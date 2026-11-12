// Runtime behaviour of the server process: health-check cost, login changes, ports, preferences, HTTP
// answers and debug output, against the mock CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { base, delay, harness } from '../support/harness.mjs';

const DEFAULT_PORT = 41710;
const PARTICIPANTS = ['codex', 'claude', 'cursor'];

/** Every CLI process the mocks started, in order: { provider, args }. */
async function spawns(h) {
  try {
    return (await fs.readFile(path.join(h.bin, 'spawns.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Whether a spawn answers a prompt (as opposed to a version, help, login or catalogue check). */
function isModelCall({ provider, args }) {
  if (provider === 'codex') return args.includes('exec') && !args.includes('--help');
  if (provider === 'claude') return args.includes('-p') && !args.includes('--input-format');
  return args.includes('--print');
}

/** A spawn by its provider and plain-word arguments: "codex login status", "cursor status json", … */
const describe = ({ provider, args }) =>
  [provider, ...args.filter((arg) => /^(?:[a-z]+|--version|--help)$/.test(arg))].join(' ');

async function until(condition, what, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await delay(25);
  }
}

/** Starts server.mjs without mock CLIs (none is found) and resolves once it exits: { code, stdout, stderr }. */
async function launchUntilExit(t, env, args = []) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-launch-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const missing = path.join(temp, 'missing-cli');
  const child = spawn(process.execPath, [path.join(base, 'server.mjs'), '--no-open', ...args], {
    cwd: base,
    env: {
      ...process.env,
      HOME: temp,
      DECISION_ROOM_DATA_DIR: path.join(temp, 'data'),
      DECISION_ROOM_CODEX_BIN: missing,
      DECISION_ROOM_CLAUDE_BIN: missing,
      DECISION_ROOM_CURSOR_BIN: missing,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (bytes) => (stdout += bytes));
  child.stderr.on('data', (bytes) => (stderr += bytes));
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);
  return { code, stdout, stderr };
}

/** A listening TCP server on 127.0.0.1:`port` (0 = any), or null when that port cannot be taken. */
async function occupy(t, port = 0) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    return null;
  }
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

test('the startup check runs in the background and concurrent callers share it', async (t) => {
  const h = await harness(t);
  // No request yet: the server checks every CLI on its own after printing the address.
  await until(async () => {
    const versions = (await spawns(h)).filter(({ args }) => args.includes('--version'));
    return PARTICIPANTS.every((provider) => versions.some((spawned) => spawned.provider === provider));
  }, 'the startup check');
  const answers = await Promise.all([
    h.request('/api/health'),
    h.request('/api/health'),
    h.request('/api/health')
  ]);
  for (const answer of answers) {
    const health = await answer.json();
    for (const provider of PARTICIPANTS)
      assert.equal(health[provider].subscription, true, health[provider].message);
  }
  const all = await spawns(h);
  for (const provider of PARTICIPANTS) {
    const versions = all.filter(
      (spawned) => spawned.provider === provider && spawned.args.includes('--version')
    );
    assert.equal(versions.length, 1, `${provider} --version runs once`);
    const logins = all.filter((spawned) => /status/.test(describe(spawned)) && spawned.provider === provider);
    assert.equal(logins.length, 1, `${provider} login status runs once`);
  }
});

test('a warm three-participant debate starts at most three check processes before its seven model calls', async (t) => {
  const h = await harness(t);
  assert.equal((await h.request('/api/health')).status, 200);
  const before = (await spawns(h)).length;
  const { res, raw } = await h.run({ mode: 'debate', participants: PARTICIPANTS, moderator: 'claude' });
  assert.equal(res.status, 200, raw);
  const during = (await spawns(h)).slice(before);
  const firstModelCall = during.findIndex(isModelCall);
  const checks = during.slice(0, firstModelCall);
  assert.ok(checks.length <= 3, JSON.stringify(checks.map(describe)));
  assert.deepEqual(checks.map(describe).sort(), [
    'claude auth status',
    'codex login status',
    'cursor status json'
  ]);
  assert.equal(during.filter(isModelCall).length, 7);
  assert.equal(during.length, checks.length + 7, 'No other process starts during the round');
  assert.equal((await h.calls()).length, 7);
});

test('changing login methods while the app runs is noticed before the next discussion', async (t) => {
  const h = await harness(t);
  const warm = await (await h.request('/api/health')).json();
  assert.equal(warm.codex.subscription, true);
  assert.equal(warm.cursor.subscription, true);
  await h.setControl({ codex: { auth: 'api' }, cursor: { auth: 'none' } });
  for (const mode of ['codex', 'cursor']) {
    const { res, raw } = await h.run({ mode });
    assert.equal(res.status, 409, `${mode}: ${raw}`);
  }
  assert.equal((await h.calls()).length, 0, 'No model is asked');
  const seen = await (await h.request('/api/health')).json();
  assert.equal(seen.codex.subscription, false, 'The page sees what the discussion found');
  assert.equal(seen.cursor.subscription, false);
  assert.equal(seen.claude.subscription, true);

  await h.setControl({});
  const { res, raw } = await h.run({ mode: 'debate', participants: PARTICIPANTS });
  assert.equal(res.status, 200, raw);
  assert.equal((await h.calls()).length, 7);
});

test('health lists the providers, ignored API-key variables, web support and version lines', async (t) => {
  const h = await harness(
    t,
    {},
    { env: { DECISION_ROOM_CURSOR_BIN: path.join(os.tmpdir(), 'no-such-cursor-agent') } }
  );
  const health = await (await h.request('/api/health')).json();
  assert.deepEqual(health.providers, [
    { id: 'codex', label: 'Codex' },
    { id: 'claude', label: 'Claude' },
    { id: 'cursor', label: 'Cursor' }
  ]);
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_API_KEY', 'CURSOR_API_KEY'])
    assert.ok(health.apiEnvironmentNames.includes(name), name);
  assert.ok(!health.apiEnvironmentNames.includes('CODEX_ACCESS_TOKEN'), 'Only API-key variables are named');
  assert.equal(health.apiEnvironmentIgnored, true);
  assert.equal(health.codex.version, 'codex-cli 0.167.0');
  assert.equal(health.cursor.available, false);
  assert.equal(health.cursor.supportsWeb, true, 'Cursor searches the web, also while its CLI is missing');
  assert.match(health.cursor.message, /找不到 Cursor Agent/);
  const raw = JSON.stringify(health);
  assert.ok(!raw.includes('fake-test-value'), 'Variable values never appear');
});

test('the page gets 401 without its token and a JSON 404 for unknown paths', async (t) => {
  const h = await harness(t);
  const missing = await fetch(h.origin + '/api/health');
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: '访问凭证无效。请使用终端打印的完整地址重新打开。' });
  const stale = await fetch(h.origin + '/api/rooms', { headers: { 'X-Decision-Token': 'f'.repeat(64) } });
  assert.equal(stale.status, 401);
  for (const [route, method] of [
    ['/no-such-page', 'GET'],
    ['/', 'POST']
  ]) {
    const response = await fetch(h.origin + route, { method });
    assert.equal(response.status, 404, `${method} ${route}`);
    assert.deepEqual(await response.json(), { error: '未找到该操作。' });
  }
});

test('preferences saved through one address are found through another, in a private file', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-shared-data-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  const first = await harness(t, {}, { env: { DECISION_ROOM_DATA_DIR: data } });
  assert.deepEqual(await (await first.request('/api/preferences')).json(), {
    configuration: null,
    selectedRoomId: null
  });
  const configuration = {
    mode: 'debate',
    participants: ['claude', 'cursor'],
    moderator: 'cursor',
    settings: { cursor: { model: 'mock-cursor', reasoning: '', capability: 'plan' } },
    webSearch: true
  };
  const roomId = '00000000-0000-4000-8000-0000000000ab';
  const saved = await first.request('/api/preferences', {
    method: 'PUT',
    body: { configuration, selectedRoomId: roomId }
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ok: true });
  const invalid = await first.request('/api/preferences', {
    method: 'PUT',
    body: { configuration: { mode: 'x' } }
  });
  assert.equal(invalid.status, 400);

  const second = await harness(t, {}, { env: { DECISION_ROOM_DATA_DIR: data } });
  assert.notEqual(second.origin, first.origin);
  assert.deepEqual(await (await second.request('/api/preferences')).json(), {
    configuration,
    selectedRoomId: roomId
  });
  if (process.platform !== 'win32')
    assert.equal((await fs.stat(path.join(data, 'preferences.json'))).mode & 0o777, 0o600);
});

test('--debug reports CLI processes, health and requests on stderr, never prompts, answers or the token', async (t) => {
  const h = await harness(t, {}, { args: ['--debug'] });
  await h.request('/api/health');
  const prompt = '调试模式下的私密问题 PRIVATE_DEBUG_PROMPT';
  const { res, raw } = await h.run({ prompt, mode: 'both', participants: ['codex', 'cursor'] });
  assert.equal(res.status, 200, raw);
  await until(() => h.stderr().includes('http POST /api/run 200'), 'the request line');
  const output = h.stderr();
  // One line per entry, so a CLI's multi-line stderr cannot pass as server output. Node's own runtime
  // warnings may also appear.
  const lines = output.split('\n').filter((line) => line && !/^\(node:\d+\)|^\(Use `node /.test(line));
  assert.ok(
    lines.every((line) => line.startsWith('[debug] ')),
    output
  );
  assert.match(output, /\[debug\] cli codex \S+codex \["login","status"\] cwd=\S+ exit=0 \d+ ms/);
  assert.match(output, /\[debug\] cli cursor \S+cursor \["--print",/);
  assert.match(output, /\[debug\] health claude ready level=full /);
  assert.match(output, /\[debug\] http GET \/api\/health 200 \d+ ms/);
  for (const secret of ['PRIVATE_DEBUG_PROMPT', 'MOCK_CODEX_RESULT', 'MOCK_CURSOR_RESULT', h.token])
    assert.ok(!output.includes(secret), secret);
  assert.ok(!output.includes('private-user@example.invalid'), 'Account details are redacted');
});

test('DECISION_ROOM_PORT chooses the port; a taken or invalid one stops the start with a clear message', async (t) => {
  const free = await occupy(t);
  assert.ok(free);
  const taken = await launchUntilExit(t, { DECISION_ROOM_PORT: String(free) });
  assert.equal(taken.code, 1);
  assert.ok(taken.stderr.includes(`端口 ${free} 已被占用`), taken.stderr);
  assert.ok(!taken.stdout.includes('本地决策群已启动'));
  for (const value of ['abc', '70000', '-1', '80.5']) {
    const invalid = await launchUntilExit(t, { DECISION_ROOM_PORT: value });
    assert.equal(invalid.code, 1, value);
    assert.ok(invalid.stderr.includes('DECISION_ROOM_PORT 必须是 0 到 65535 之间的整数'), invalid.stderr);
  }

  // A port that was free a moment ago is taken as given.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const h = await harness(t, {}, { env: { DECISION_ROOM_PORT: String(port) } });
  assert.equal(new URL(h.origin).port, String(port));
});

test('without DECISION_ROOM_PORT the default port is used, or a random one with a note when it is taken', async (t) => {
  await occupy(t, DEFAULT_PORT); // null when something else already holds it: the result is the same
  const h = await harness(t, {}, { env: { DECISION_ROOM_PORT: undefined } });
  assert.notEqual(new URL(h.origin).port, String(DEFAULT_PORT));
  assert.ok(h.stdout().includes(`端口 ${DEFAULT_PORT} 已被占用，本次改用随机端口。`), h.stdout());
  assert.equal((await h.request('/api/health')).status, 200);
});
