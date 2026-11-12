// Shared integration-test harness: starts server.mjs with mock CLIs in a temporary HOME and data directory.
// harness(t, control, { env, args }) -> helpers for requests, runs and the mock CLIs' call log.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const mockModule = pathToFileURL(path.join(base, 'tests/support/mock-cli.mjs')).href;
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function harness(t, control = {}, { env = {}, args = [] } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-test-'));
  const bin = path.join(temp, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'control.json'), JSON.stringify(control));
  for (const provider of ['codex', 'claude', 'cursor']) {
    await fs.writeFile(
      path.join(bin, provider),
      `#!${process.execPath}\nimport(${JSON.stringify(mockModule)}).then(({runMock}) => runMock(${JSON.stringify(provider)}, require('node:url').pathToFileURL(__filename).href)).catch(error => { console.error(error); process.exitCode = 1; });\n`,
      { mode: 0o700 }
    );
  }
  const child = spawn(process.execPath, [path.join(base, 'server.mjs'), '--no-open', ...args], {
    cwd: base,
    env: {
      ...process.env,
      HOME: temp,
      USERPROFILE: temp,
      XDG_CONFIG_HOME: path.join(temp, '.config'),
      CODEX_HOME: path.join(temp, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(temp, '.claude'),
      CURSOR_CONFIG_DIR: path.join(temp, '.cursor'),
      DECISION_ROOM_CODEX_BIN: path.join(bin, 'codex'),
      DECISION_ROOM_CLAUDE_BIN: path.join(bin, 'claude'),
      DECISION_ROOM_CURSOR_BIN: path.join(bin, 'cursor'),
      DECISION_ROOM_DATA_DIR: path.join(temp, 'data'),
      DECISION_ROOM_PORT: '0',
      ANTHROPIC_API_KEY: 'fake-test-value-not-a-real-key',
      OPENAI_API_KEY: 'fake-test-value-not-a-real-key',
      CODEX_API_KEY: 'fake-test-value-not-a-real-key',
      CODEX_ACCESS_TOKEN: 'fake-test-token-not-real',
      CLAUDE_CODE_OAUTH_TOKEN: 'fake-test-token-not-real',
      CURSOR_API_KEY: 'fake-test-value-not-a-real-key',
      CURSOR_AUTH_TOKEN: 'fake-test-token-not-real',
      CURSOR_API_ENDPOINT: 'https://example.invalid',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (bytes) => (stdout += bytes));
  child.stderr.on('data', (bytes) => (stderr += bytes));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1500)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await fs.rm(temp, { recursive: true, force: true });
  });
  const deadline = Date.now() + 8000;
  let matched;
  while (!(matched = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/#([^\s]+)/))) {
    if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}: ${stderr}`);
    if (Date.now() > deadline) throw new Error(`No startup URL. stdout=${stdout} stderr=${stderr}`);
    await delay(20);
  }
  const url = new URL(matched[0]);
  const origin = url.origin;
  const token = url.hash.slice(1);
  async function request(route, { body, headers = {}, ...options } = {}) {
    return fetch(origin + route, {
      ...options,
      headers: {
        'X-Decision-Token': token,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers
      },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    });
  }
  async function calls() {
    try {
      return (await fs.readFile(path.join(bin, 'calls.ndjson'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
  async function setControl(next) {
    await fs.writeFile(path.join(bin, 'control.json'), JSON.stringify(next));
  }
  async function startRun(payload = {}) {
    return request('/api/run', {
      method: 'POST',
      body: {
        prompt: '选择方案 A 还是 B？请说明假设。',
        context: '预算固定，不允许扩大投入。',
        mode: 'both',
        webSearch: false,
        ...payload
      }
    });
  }
  async function run(payload) {
    const res = await startRun(payload);
    const raw = await res.text();
    const events = res.ok ? raw.trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return { res, raw, events };
  }
  return {
    origin,
    token,
    request,
    calls,
    setControl,
    startRun,
    run,
    temp,
    bin,
    stdout: () => stdout,
    stderr: () => stderr
  };
}
