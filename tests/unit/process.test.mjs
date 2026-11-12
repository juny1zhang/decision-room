import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { childEnv, createRunner, findExecutable } from '../../src/process.mjs';
import { CHILD_ENV_DENYLIST } from '../../src/providers/index.mjs';

// Every variable server.mjs removed from CLI environments before the provider registry existed.
const ORIGINAL_DENYLIST = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
  'CURSOR_API_ENDPOINT',
  'CURSOR_API_URL',
  'CURSOR_ENABLE_BEDROCK',
  'CURSOR_LOCAL_AGENT_API_KEY',
  'CURSOR_LOCAL_AGENT_BASE_URL',
  'CURSOR_LOCAL_AGENT_HEADERS',
  'CURSOR_API_BASE_URL',
  'CURSOR_ENABLE_LOCAL_BEDROCK',
  'CURSOR_BEDROCK_BASE_URL',
  'CURSOR_ENABLE_AUTHLESS',
  'CURSOR_AGENT_CLI_AUTHLESS_MODE',
  'CURSOR_AGENT_CLI_LOCAL_MODE'
];

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-unit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('every CLI starts without the API keys, endpoints and session markers of all providers', () => {
  assert.deepEqual([...CHILD_ENV_DENYLIST].sort(), [...ORIGINAL_DENYLIST].sort());
  const kept = ['PATH', 'HOME', 'LANG', 'OPENAI_ORG_ID', 'CURSOR_CONFIG_DIR', 'CLAUDE_CONFIG_DIR'];
  const source = Object.fromEntries([...ORIGINAL_DENYLIST, ...kept].map((key) => [key, 'value']));
  Object.assign(source, { NO_COLOR: '', FORCE_COLOR: '3' });
  const env = childEnv(CHILD_ENV_DENYLIST, source);
  assert.deepEqual(Object.keys(env).sort(), [...kept, 'NO_COLOR', 'FORCE_COLOR'].sort());
  assert.equal(env.NO_COLOR, '1');
  assert.equal(env.FORCE_COLOR, '0');
  assert.equal(source.OPENAI_API_KEY, 'value', 'The source environment is left unchanged');
});

test('the runner starts CLIs in its folder with the scrubbed environment, stdin and extra variables', async (t) => {
  const cwd = await tempDir(t);
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CLAUDECODE: process.env.CLAUDECODE };
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.OPENAI_API_KEY = 'unit-test-value';
  process.env.CLAUDECODE = '1';
  const run = createRunner({ cwd, denylist: CHILD_ENV_DENYLIST });
  const script =
    "let input = '';" +
    "process.stdin.on('data', (chunk) => (input += chunk)).on('end', () =>" +
    ' process.stdout.write(JSON.stringify({ input, cwd: process.cwd(), env: process.env })));';
  const result = await run(process.execPath, ['-e', script], {
    input: '原样输入 $(id)',
    env: { EXTRA: 'yes' }
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.input, '原样输入 $(id)');
  assert.equal(await fs.realpath(report.cwd), await fs.realpath(cwd));
  assert.equal(report.env.OPENAI_API_KEY, undefined);
  assert.equal(report.env.CLAUDECODE, undefined);
  assert.equal(report.env.NO_COLOR, '1');
  assert.equal(report.env.FORCE_COLOR, '0');
  assert.equal(report.env.EXTRA, 'yes');
});

test('findExecutable prefers DECISION_ROOM_<ID>_BIN, then searches the binaries in order', async (t) => {
  const dir = await tempDir(t);
  for (const name of ['cursor-agent', 'agent']) await fs.writeFile(path.join(dir, name), '', { mode: 0o700 });
  await fs.writeFile(path.join(dir, 'not-executable'), '', { mode: 0o600 });
  const cursor = { id: 'cursor', binaries: ['cursor-agent', 'agent'] };
  assert.equal(await findExecutable(cursor, { PATH: dir }), path.join(dir, 'cursor-agent'));
  const override = path.join(dir, 'agent');
  assert.equal(await findExecutable(cursor, { PATH: dir, DECISION_ROOM_CURSOR_BIN: override }), override);
  const unusable = { PATH: dir, DECISION_ROOM_CURSOR_BIN: path.join(dir, 'not-executable') };
  assert.equal(
    await findExecutable(cursor, unusable),
    null,
    'An override is never replaced by a PATH search'
  );
});
