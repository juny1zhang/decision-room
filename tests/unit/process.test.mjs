import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  childEnv,
  createRunner,
  executableIdentity,
  findExecutable,
  formatDuration,
  runProcess,
  selectsCaStore,
  systemCaEnv
} from '../../src/process.mjs';
import { CHILD_ENV_DENYLIST, getProvider } from '../../src/providers/index.mjs';

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

test('a timeout is worded from the actual limit', async () => {
  assert.equal(formatDuration(6500), '6.5 秒');
  assert.equal(formatDuration(20000), '20 秒');
  assert.equal(formatDuration(12000), '12 秒');
  assert.equal(formatDuration(12 * 60 * 1000), '12 分钟');
  assert.equal(formatDuration(90000), '1.5 分钟');
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeout: 300 }),
    (error) => {
      assert.equal(error.message, '等待超过 0.3 秒，已停止调用。请稍后重试。');
      return true;
    }
  );
});

test('NODE_USE_SYSTEM_CA is only set when NODE_OPTIONS picks no CA store', () => {
  for (const options of [
    undefined,
    '',
    '--max-old-space-size=4096',
    '--use-openssl-cache',
    '--trace-warnings'
  ])
    assert.deepEqual(systemCaEnv({ NODE_OPTIONS: options }), { NODE_USE_SYSTEM_CA: '1' }, String(options));
  for (const options of [
    '--use-openssl-ca',
    '--use-bundled-ca',
    '--use-system-ca',
    '--max-old-space-size=4096 --use-openssl-ca',
    '--use-bundled-ca --trace-warnings',
    '  --use-openssl-ca  '
  ]) {
    assert.equal(selectsCaStore(options), true, options);
    assert.deepEqual(systemCaEnv({ NODE_OPTIONS: options }), {}, options);
  }
  assert.equal(selectsCaStore('--use-openssl-ca-file=/x'), false);
});

test('Cursor runs with NODE_USE_SYSTEM_CA only when NODE_OPTIONS picks no CA store', async (t) => {
  const dir = await tempDir(t);
  const saved = process.env.NODE_OPTIONS;
  t.after(() => {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  });
  const cursor = getProvider('cursor');
  const seen = [];
  const run = async (bin, args, options) => {
    seen.push({ args, env: options.env });
    return { code: 1, stdout: '', stderr: '' };
  };
  const ctx = (cli) => ({
    bin: '/bin/agent',
    run,
    runtimeDir: dir,
    info: { available: true, version: '', models: [] },
    cli: (check) => check(),
    remote: (key, check) => check(),
    ...cli
  });
  for (const [options, expected] of [
    ['--use-openssl-ca', undefined],
    ['--use-bundled-ca --max-old-space-size=4096', undefined],
    ['--max-old-space-size=4096', '1']
  ]) {
    process.env.NODE_OPTIONS = options;
    seen.length = 0;
    await cursor.inspect(ctx());
    assert.ok(seen.length > 0);
    for (const call of seen) assert.equal(call.env.NODE_USE_SYSTEM_CA, expected, `${options}: ${call.args}`);
  }
});

test('the executable identity follows links and changes when the file changes', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'cli');
  await fs.writeFile(file, 'version 1', { mode: 0o700 });
  await fs.symlink(file, path.join(dir, 'link'));
  const first = await executableIdentity(file);
  assert.ok(first);
  assert.equal(await executableIdentity(path.join(dir, 'link')), first, 'A link has its target identity');
  assert.equal(await executableIdentity(file), first, 'Unchanged files keep their identity');
  await fs.appendFile(file, ' and 2');
  const resized = await executableIdentity(file);
  assert.notEqual(resized, first);
  const replacement = path.join(dir, 'cli.new');
  await fs.writeFile(replacement, 'version 1 and 2', { mode: 0o700 });
  await fs.utimes(replacement, (await fs.stat(file)).atime, (await fs.stat(file)).mtime);
  await fs.rename(replacement, file);
  assert.notEqual(await executableIdentity(file), resized, 'A replaced file (new inode) is a new identity');
  assert.equal(await executableIdentity(path.join(dir, 'missing')), null);
});

test('debug lines report the process without its input or output', async (t) => {
  const cwd = await tempDir(t);
  const lines = [];
  const run = createRunner({ cwd, denylist: [], debug: (line) => lines.push(line), label: () => 'mock' });
  const script =
    "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('SECRET_' + 'ANSWER');" +
    " process.stderr.write('warning for user@example.com\\nsecond line'); process.exitCode = 3; });";
  const result = await run(process.execPath, ['-e', script, '--', '--flag', 'x'.repeat(500)], {
    input: 'PRIVATE_PROMPT'
  });
  assert.equal(result.code, 3);
  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.ok(line.startsWith(`cli mock ${process.execPath} [`), line);
  assert.ok(line.includes(`cwd=${cwd}`) && line.includes('exit=3') && /\d+ ms/.test(line), line);
  assert.ok(
    line.includes('"--flag"') && line.includes('x'.repeat(159) + '…'),
    'Long arguments are shortened'
  );
  assert.ok(line.includes('stderr="warning for [account]\\nsecond line"'), line);
  assert.ok(!line.includes('PRIVATE_PROMPT') && !line.includes('SECRET_ANSWER'));
  assert.ok(!line.includes('\n'), 'One line per process');

  lines.length = 0;
  await assert.rejects(run(path.join(cwd, 'missing-cli'), ['--version']));
  assert.match(lines[0], /^cli mock .*missing-cli \["--version"\] .* exit=- \d+ ms error=".*ENOENT/);
  const quiet = createRunner({ cwd, denylist: [] });
  assert.equal((await quiet(process.execPath, ['-e', ''])).code, 0, 'Without debug nothing is reported');
});
