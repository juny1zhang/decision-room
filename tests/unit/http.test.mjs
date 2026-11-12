import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createActiveRun } from '../../src/discussion.mjs';
import { createRequestHandler, readStaticFile, resolveStaticPath } from '../../src/http.mjs';
import { createPreferenceStore } from '../../src/preferences.mjs';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
const TOKEN = 'a'.repeat(64);
const NOT_FOUND = { error: '未找到该操作。' };
const DENIED = { error: '访问凭证无效。请使用终端打印的完整地址重新打开。' };
const ROOM_ID = '00000000-0000-4000-8000-000000000001';

/** A public folder next to a secret file, with a link that leads out of it and one that stays inside. */
async function publicFolder(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-static-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'public');
  const files = {
    'index.html': '<!doctype html><title>Decision Room</title>',
    'app.js': 'export const app = 1;\n',
    'app.css': 'body { margin: 0; }\n',
    'js/api.js': 'export const api = 1;\n',
    'img/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '.secret.js': 'hidden',
    'notes.txt': 'not served'
  };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  await fs.writeFile(path.join(dir, 'img/logo.png'), PNG);
  await fs.mkdir(path.join(dir, 'folder.js'));
  await fs.writeFile(path.join(parent, 'secret.js'), 'outside');
  await fs.symlink(path.join(parent, 'secret.js'), path.join(dir, 'escape.js'));
  await fs.symlink(path.join(dir, 'app.js'), path.join(dir, 'alias.js'));
  return dir;
}

/**
 * Serves createRequestHandler on a random port with stand-ins for everything not given in `deps`.
 * request(route, { method, headers, body }) resolves to { status, headers, body } using a raw HTTP client,
 * so Host and Origin can be set freely.
 */
async function serve(t, deps = {}) {
  let port = 0;
  const listener = createRequestHandler({
    token: TOKEN,
    getPort: () => port,
    publicDir: deps.publicDir ?? (await publicFolder(t)),
    health: { check: async () => ({ ok: true }) },
    invoke: async () => assert.fail('No model call is expected'),
    rooms: { list: async () => [], load: async () => assert.fail('No room is expected') },
    preferences: { read: async () => assert.fail('No preferences are expected') },
    activeRun: { isBusy: () => false, begin() {}, end() {}, abort() {} },
    ...deps
  });
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  port = server.address().port;
  const request = (route, { method = 'GET', headers = {}, body, agent = false } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: route, method, headers, agent }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      });
      req.on('error', reject);
      req.end(body);
    });
  return { port, request };
}

const json = (response) => JSON.parse(response.body.toString('utf8'));
const authorized = (headers = {}) => ({ 'X-Decision-Token': TOKEN, ...headers });

test('static paths map to files of the allowed types inside the public folder', () => {
  const root = path.resolve('/srv/public');
  const cases = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/js/api.js': ['js/api.js', 'text/javascript; charset=utf-8'],
    '/js/%61pi.js': ['js/api.js', 'text/javascript; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'],
    '/img/icon.svg': ['img/icon.svg', 'image/svg+xml'],
    '/img/logo.png': ['img/logo.png', 'image/png']
  };
  for (const [pathname, [file, type]] of Object.entries(cases)) {
    assert.deepEqual(resolveStaticPath(root, pathname), { file: path.join(root, file), type }, pathname);
  }
});

test('static paths that could leave the public folder or reveal other files are refused', () => {
  const root = path.resolve('/srv/public');
  for (const pathname of [
    '/../server.mjs',
    '/js/../../server.js',
    '/%2e%2e/server.js',
    '/%2E%2E%2Fserver.js',
    '/js/..%2f..%2fapp.js',
    '/..%5c..%5capp.js',
    '/js\\..\\..\\app.js',
    '//etc/app.js',
    '/%2fetc%2fapp.js',
    '/C:/Windows/app.js',
    '/C:%5cWindows%5capp.js',
    '/.env',
    '/.git/config',
    '/js/.hidden.js',
    '/%2ehidden.js',
    '/app.js%00.png',
    '/%E0%A4%A.js',
    '/index.html',
    '/app.mjs',
    '/app.JS',
    '/notes.txt',
    '/app',
    '/js/',
    ''
  ]) {
    assert.equal(resolveStaticPath(root, pathname), null, pathname);
  }
});

test('only regular files inside the public folder are read', async (t) => {
  const dir = await publicFolder(t);
  assert.deepEqual(await readStaticFile(dir, '/app.js'), {
    body: Buffer.from('export const app = 1;\n'),
    type: 'text/javascript; charset=utf-8'
  });
  assert.deepEqual((await readStaticFile(dir, '/img/logo.png')).body, PNG);
  assert.equal((await readStaticFile(dir, '/')).type, 'text/html; charset=utf-8');
  assert.equal((await readStaticFile(dir, '/alias.js')).type, 'text/javascript; charset=utf-8');
  for (const pathname of [
    '/escape.js',
    '/folder.js',
    '/.secret.js',
    '/missing.js',
    '/notes.txt',
    '/%2e%2e/secret.js'
  ]) {
    assert.equal(await readStaticFile(dir, pathname), null, pathname);
  }
});

test('the UI is served without the token, with the security headers and host and origin checks', async (t) => {
  const { port, request } = await serve(t);

  const index = await request('/');
  assert.equal(index.status, 200);
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.body.toString(), '<!doctype html><title>Decision Room</title>');
  assert.equal(index.headers['content-security-policy'], CSP);
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['referrer-policy'], 'no-referrer');

  const script = await request('/js/api.js', { headers: { Origin: `http://localhost:${port}` } });
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(script.headers['cache-control'], 'no-store');

  for (const route of [
    '/missing.js',
    '/%2e%2e/secret.js',
    '/js/..%2f..%2fsecret.js',
    '/.secret.js',
    '/escape.js'
  ]) {
    const missing = await request(route);
    assert.equal(missing.status, 404, route);
    assert.equal(missing.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(missing.headers['cache-control'], 'no-store');
    assert.deepEqual(json(missing), NOT_FOUND);
  }

  const favicon = await request('/favicon.ico');
  assert.equal(favicon.status, 204);
  assert.equal(favicon.headers['cache-control'], 'no-store');
  assert.deepEqual(json(await request('/app.js', { headers: { Host: 'attacker.invalid' } })), {
    error: 'Invalid host'
  });
  const foreign = await request('/app.js', { headers: { Origin: 'https://attacker.invalid' } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(json(foreign), { error: 'Invalid origin' });
  const foreignApi = await request('/api/health', {
    headers: authorized({ Origin: 'https://attacker.invalid' })
  });
  assert.equal(foreignApi.status, 403, 'Host and origin failures stay 403, also with the token');

  const health = await request('/api/health', { headers: authorized() });
  assert.equal(health.status, 200);
  assert.deepEqual(json(health), { ok: true });
});

test('API routes answer 401 without the token, and unknown paths a JSON 404', async (t) => {
  const { request } = await serve(t);
  for (const headers of [{}, { 'X-Decision-Token': 'b'.repeat(64) }, { 'X-Decision-Token': 'short' }]) {
    for (const [route, method] of [
      ['/api/health', 'GET'],
      ['/api/rooms', 'GET'],
      ['/api/run', 'POST'],
      ['/api/preferences', 'PUT'],
      ['/api/unknown', 'GET']
    ]) {
      const response = await request(route, { method, headers });
      assert.equal(response.status, 401, `${method} ${route} ${JSON.stringify(headers)}`);
      assert.deepEqual(json(response), DENIED);
    }
  }
  for (const [route, method] of [
    ['/app.js', 'POST'],
    ['/', 'POST'],
    ['/index.html', 'DELETE'],
    ['/favicon.ico', 'PUT'],
    ['/unknown', 'GET'],
    ['/api', 'GET'],
    ['//', 'GET']
  ]) {
    const response = await request(route, { method, headers: authorized() });
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
    assert.deepEqual(json(response), NOT_FOUND);
  }
  const unknownApi = await request('/api/unknown', { headers: authorized() });
  assert.equal(unknownApi.status, 404);
  assert.deepEqual(json(unknownApi), NOT_FOUND);
});

test('health is checked in full only when the page asks for a refresh', async (t) => {
  const levels = [];
  const { request } = await serve(t, {
    health: {
      check: async (level) => {
        levels.push(level);
        return { level };
      }
    }
  });
  await request('/api/health', { headers: authorized() });
  await request('/api/health?refresh=1', { headers: authorized() });
  await request('/api/health?refresh=0', { headers: authorized() });
  assert.deepEqual(levels, ['cached', 'full', 'cached']);
});

test('an oversized body is read to its end, so even a raw client receives the 413 answer', async (t) => {
  const { request } = await serve(t);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const tooLarge = { error: '提交内容过大。' };
  const body = JSON.stringify({ prompt: 'A'.repeat(3_000_000) });
  for (const headers of [
    { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    // Chunked: the size is only known while reading.
    { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }
  ]) {
    for (const route of ['/api/run', '/api/preferences']) {
      const method = route === '/api/run' ? 'POST' : 'PUT';
      const response = await request(route, { method, headers: authorized(headers), body, agent });
      assert.equal(response.status, 413, `${route} ${JSON.stringify(headers)}`);
      assert.deepEqual(json(response), tooLarge);
      assert.notEqual(response.headers.connection, 'close', 'The connection stays usable');
    }
  }
  const next = await request('/api/health', { headers: authorized(), agent });
  assert.equal(next.status, 200, 'The same connection answers the next request');
});

test('a raw client can finish sending an oversized body without a connection reset', async (t) => {
  const { port } = await serve(t);
  const total = 8 * 1024 * 1024;
  const result = await new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    let sent = 0;
    let error = null;
    socket.setEncoding('utf8');
    socket.on('data', (text) => (received += text));
    socket.on('error', (e) => (error = e.code));
    socket.on('close', () => resolve({ received, sent, error }));
    socket.write(
      `POST /api/run HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Decision-Token: ${TOKEN}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`
    );
    const piece = Buffer.alloc(256 * 1024, 65);
    const pump = () => {
      if (sent >= total) return socket.end();
      sent += piece.length;
      if (socket.write(piece)) setTimeout(pump, 1);
      else socket.once('drain', pump);
    };
    pump();
  });
  assert.equal(result.error, null, 'No ECONNRESET while the body is still being sent');
  assert.equal(result.sent, total);
  assert.match(result.received, /^HTTP\/1\.1 413 /);
  assert.ok(result.received.includes(JSON.stringify({ error: '提交内容过大。' })));
});

test('a body declared larger than the discard limit is refused at once and the connection closed', async (t) => {
  const { port } = await serve(t);
  const response = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/run',
        method: 'POST',
        agent: false,
        headers: authorized({ 'Content-Type': 'application/json', 'Content-Length': 64 * 1024 * 1024 })
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    // The body never comes; the answer must not wait for it. Errors after the answer are expected.
    req.on('error', (error) => reject(error));
    req.write('{"prompt":"');
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers.connection, 'close');
  assert.deepEqual(json(response), { error: '提交内容过大。' });
});

test('preferences are read and saved through the API, and invalid ones are refused', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-preferences-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { request } = await serve(t, {
    preferences: createPreferenceStore(path.join(dir, 'preferences.json'))
  });
  const read = async () => json(await request('/api/preferences', { headers: authorized() }));
  const put = (body, headers = { 'Content-Type': 'application/json' }) =>
    request('/api/preferences', {
      method: 'PUT',
      headers: authorized(headers),
      body: typeof body === 'string' ? body : JSON.stringify(body)
    });

  assert.deepEqual(await read(), { configuration: null, selectedRoomId: null });
  const configuration = {
    mode: 'debate',
    participants: ['claude', 'cursor'],
    moderator: 'cursor',
    settings: { claude: { model: 'sonnet', reasoning: 'high', capability: 'risk' } },
    webSearch: true
  };
  const saved = await put({ configuration, selectedRoomId: ROOM_ID });
  assert.equal(saved.status, 200);
  assert.deepEqual(json(saved), { ok: true });
  assert.deepEqual(await read(), { configuration, selectedRoomId: ROOM_ID });

  assert.equal((await put({ selectedRoomId: null })).status, 200);
  assert.deepEqual(await read(), { configuration, selectedRoomId: null }, 'Only the given field changes');

  for (const invalid of [
    { configuration: { mode: 'everyone' } },
    { configuration: { mode: 'both', participants: ['codex', 'other'] } },
    { configuration: { mode: 'both', webSearch: 'yes' } },
    { configuration: { mode: 'codex', settings: { codex: { model: 'x'.repeat(241) } } } },
    { selectedRoomId: '../../etc/passwd' }
  ]) {
    const response = await put(invalid);
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.deepEqual(json(response), { error: '偏好设置无效。' });
  }
  assert.equal((await put('{broken')).status, 400);
  assert.equal((await put({}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.deepEqual(await read(), { configuration, selectedRoomId: null }, 'Refused changes are not saved');
});

test('debug lines name the method, path, status and duration, never the token', async (t) => {
  const lines = [];
  const { request } = await serve(t, { debug: (line) => lines.push(line) });
  await request('/api/health?refresh=1', { headers: authorized() });
  await request(`/api/rooms/${TOKEN}`, { headers: authorized() });
  await request('/api/health');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.match(lines[0], /^http GET \/api\/health\?refresh=1 200 \d+ ms$/);
  assert.match(lines[1], /^http GET \/api\/rooms\/\[token\] 404 \d+ ms$/);
  assert.match(lines[2], /^http GET \/api\/health 401 \d+ ms$/);
  assert.ok(!lines.join('\n').includes(TOKEN));
});

test('a run that fails part-way stops its other calls, so none writes to the room later', async (t) => {
  const activeRun = createActiveRun();
  const ready = { available: true, authenticated: true, subscription: true, supportsWeb: true };
  const saves = [];
  const rooms = {
    list: async () => [],
    // The question is saved; the first answer cannot be (a full disk).
    save: async (room) => {
      saves.push(room.messages.length);
      if (saves.length === 2) throw new Error('ENOSPC: no space left on device');
    }
  };
  let stopped = false;
  const invoke = (id, _prompt, _webSearch, signal) =>
    id === 'codex'
      ? Promise.resolve({ text: 'Codex 的分析', model: 'mock-codex' })
      : new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            stopped = true;
            reject(new Error('讨论已停止。'));
          })
        );
  const { request } = await serve(t, {
    activeRun,
    rooms,
    invoke,
    health: { check: async () => ({ codex: ready, claude: ready }) }
  });
  const response = await request('/api/run', {
    method: 'POST',
    headers: authorized({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prompt: '选哪个方案？', mode: 'debate', participants: ['codex', 'claude'] })
  });
  const events = response.body
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /ENOSPC/);
  // Claude's call was stopped with the run, which no longer holds the room.
  assert.equal(stopped, true);
  assert.equal(activeRun.isBusy(), false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(saves, [1, 2], 'nothing is saved after the run ended');
});
