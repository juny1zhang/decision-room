import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler, readStaticFile, resolveStaticPath } from '../../src/http.mjs';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

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
  const publicDir = await publicFolder(t);
  const token = 'a'.repeat(64);
  let port = 0;
  const listener = createRequestHandler({
    token,
    getPort: () => port,
    publicDir,
    health: { check: async () => ({ ok: true }) },
    invoke: async () => assert.fail('No model call is expected'),
    rooms: { list: async () => [], load: async () => assert.fail('No room is expected') },
    activeRun: { isBusy: () => false, begin() {}, end() {}, abort() {} }
  });
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  port = server.address().port;
  const request = (route, { method = 'GET', headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: route, method, headers, agent: false },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
          );
        }
      );
      req.on('error', reject);
      req.end();
    });
  const json = (response) => JSON.parse(response.body.toString('utf8'));

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
    assert.deepEqual(json(missing), { error: '未找到该操作。' });
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

  const denied = { error: '访问凭证无效。请使用终端打印的完整地址重新打开。' };
  for (const [route, method] of [
    ['/api/health', 'GET'],
    ['/app.js', 'POST']
  ]) {
    const response = await request(route, { method });
    assert.equal(response.status, 403, `${method} ${route}`);
    assert.deepEqual(json(response), denied);
  }
  const health = await request('/api/health', { headers: { 'X-Decision-Token': token } });
  assert.equal(health.status, 200);
  assert.deepEqual(json(health), { ok: true });
});
