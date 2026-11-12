import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEALTH_TTL } from '../../src/config.mjs';
import { createHealthChecker } from '../../src/health.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-health-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Executable stand-ins for `ids`, found through DECISION_ROOM_<ID>_BIN in the returned env. */
async function executables(dir, ids) {
  const env = { PATH: '' };
  const files = {};
  for (const id of ids) {
    files[id] = path.join(dir, id);
    await fs.writeFile(files[id], '#!/bin/sh\n', { mode: 0o700 });
    env[`DECISION_ROOM_${id.toUpperCase()}_BIN`] = files[id];
  }
  return { env, files };
}

/**
 * A provider whose inspect() follows the real pattern: a static check through ctx.cli(), a login check
 * on every inspect, and a remote check through ctx.remote() keyed by the login state. `world` decides the
 * outcomes; `log` records which steps ran.
 */
function fakeProvider(id, world, log) {
  return {
    id,
    label: id.toUpperCase(),
    binaries: [id],
    missingHint: id,
    envDenylist: [`${id.toUpperCase()}_API_KEY`],
    apiKeyEnv: [`${id.toUpperCase()}_API_KEY`],
    supportsWeb: id !== 'beta',
    async inspect(ctx) {
      const { info } = ctx;
      const [cli] = await Promise.all([
        ctx.cli(async () => {
          log.push(`${id}:cli`);
          await world.cliGate;
          return { ok: world.cliOk, version: `${id} 1.0` };
        }),
        (async () => log.push(`${id}:login`))()
      ]);
      await world.loginGate;
      info.version = cli.version;
      info.authenticated = info.subscription = world.login !== 'none';
      info.message = `login ${world.login}`;
      if (!info.subscription) return info;
      const catalog = await ctx.remote(world.login, async () => {
        log.push(`${id}:remote`);
        await world.remoteGate;
        return { ok: world.remoteOk, models: [`${id}-model`] };
      });
      info.models = catalog.models;
      world.signals.push(ctx.signal);
      return info;
    },
    invoke: async () => assert.fail('No model call is expected')
  };
}

async function setup(t, { ids = ['alpha'], world: overrides = {}, env: extraEnv = {} } = {}) {
  const dir = await tempDir(t);
  const { env, files } = await executables(dir, ids);
  const world = { cliOk: true, remoteOk: true, login: 'chatgpt', signals: [], ...overrides };
  const log = [];
  let clock = 1_000_000;
  const health = createHealthChecker({
    run: async () => assert.fail('Fake providers start no process'),
    runtimeDir: dir,
    providers: ids.map((id) => fakeProvider(id, world, log)),
    env: { ...env, ...extraEnv },
    now: () => clock
  });
  t.after(() => health.close());
  // Which steps ran since the last call, sorted: static and login checks run at the same time.
  const steps = () => log.splice(0).sort();
  const advance = (ms) => (clock += ms);
  return { health, world, steps, advance, files };
}

test('version and help run once per executable, the login on every login check, catalogues while fresh', async (t) => {
  const { health, world, steps, advance, files } = await setup(t);
  const first = await health.check('full');
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:remote']);
  assert.deepEqual(first.alpha.models, ['alpha-model']);

  await health.check('login');
  assert.deepEqual(steps(), ['alpha:login'], 'A discussion re-reads only the login state');
  await health.check('cached');
  assert.deepEqual(steps(), [], 'A status poll reuses a fresh result');

  world.login = 'apikey';
  const switched = await health.check('login');
  assert.deepEqual(steps(), ['alpha:login', 'alpha:remote'], 'A changed login state is validated again');
  assert.equal(switched.alpha.message, 'login apikey');

  advance(HEALTH_TTL + 1);
  await health.check('login');
  assert.deepEqual(steps(), ['alpha:login', 'alpha:remote'], 'Catalogues expire after HEALTH_TTL');
  await health.check('cached');
  assert.deepEqual(steps(), [], 'The login check just now refreshed the cached result');

  await health.check('full');
  assert.deepEqual(steps(), ['alpha:login', 'alpha:remote'], '"重新检查连接" asks the model service again');

  await fs.appendFile(files.alpha, '# updated\n');
  await health.check('login');
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:remote'], 'An updated CLI is checked again');

  advance(HEALTH_TTL + 1);
  await health.check('cached');
  assert.deepEqual(steps(), ['alpha:login', 'alpha:remote'], 'A stale cached result is checked again');
});

test('failed static and remote checks are not reused', async (t) => {
  const { health, world, steps } = await setup(t, { world: { cliOk: false, remoteOk: false } });
  await health.check('login');
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:remote']);
  await health.check('login');
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:remote']);
  world.cliOk = true;
  world.remoteOk = true;
  await health.check('login');
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:remote']);
  await health.check('login');
  assert.deepEqual(steps(), ['alpha:login']);
});

test('concurrent callers share a check in progress; a login check never joins an older one', async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { health, world, steps } = await setup(t, { world: { remoteGate: gate } });
  const polls = [health.check('cached'), health.check('cached'), health.check('full')];
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Started after the polls, while their remote check still runs: reads the login again but shares
  // the static and remote checks in progress.
  const discussion = health.check('login', undefined, ['alpha']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  const results = await Promise.all([...polls, discussion]);
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:login', 'alpha:remote']);
  for (const result of results) assert.deepEqual(result.alpha.models, ['alpha-model']);
  assert.equal(results[0].alpha, results[1].alpha, 'The polls received the same check');
  assert.equal(world.signals.length, 2);
});

test("a caller's signal ends only its own wait; the check still completes for the next caller", async (t) => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { health, steps } = await setup(t, { world: { loginGate: gate } });
  const controller = new AbortController();
  const waiting = health.check('login', controller.signal, ['alpha']);
  controller.abort();
  await assert.rejects(waiting, { message: '讨论已停止。', status: 400 });
  release();
  const later = await health.check('cached');
  assert.equal(later.alpha.subscription, true);
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:remote'], 'One check, not two');
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(health.check('cached', stopped.signal), { message: '讨论已停止。' });
});

test('close() aborts the signal that every check runs with', async (t) => {
  const { health, world } = await setup(t);
  await health.check('full');
  assert.equal(world.signals[0].aborted, false);
  health.close();
  assert.equal(world.signals[0].aborted, true);
});

test('the result lists the providers, ignored API-key variables and web support from the registry', async (t) => {
  const { health } = await setup(t, {
    ids: ['alpha', 'beta'],
    env: { ALPHA_API_KEY: 'set', BETA_API_KEY: '', DECISION_ROOM_BETA_BIN: '/nonexistent/beta' }
  });
  const result = await health.check();
  assert.deepEqual(result.providers, [
    { id: 'alpha', label: 'ALPHA' },
    { id: 'beta', label: 'BETA' }
  ]);
  assert.deepEqual(result.apiEnvironmentNames, ['ALPHA_API_KEY']);
  assert.equal(result.apiEnvironmentIgnored, true);
  assert.equal(result.alpha.supportsWeb, true);
  assert.equal(result.beta.available, false);
  assert.equal(result.beta.supportsWeb, false, 'Reported from the registry while the CLI is missing');
  assert.equal(result.beta.message, '找不到 beta。请检查 CLI 安装位置。');
  assert.equal(health.binary('beta'), undefined);
  assert.ok(health.binary('alpha').endsWith('alpha'));
  const selected = await health.check('cached', undefined, ['beta']);
  assert.ok(!('alpha' in selected) && 'beta' in selected && selected.providers.length === 2);
  assert.equal(typeof result.version, 'string');
  assert.ok(Array.isArray(result.capabilities));
});

test('older callers: true means a full check, or a login check for selected providers', async (t) => {
  const { health, steps } = await setup(t);
  await health.check(true);
  assert.deepEqual(steps(), ['alpha:cli', 'alpha:login', 'alpha:remote']);
  await health.check(true, undefined, ['alpha']);
  assert.deepEqual(steps(), ['alpha:login']);
  await health.check(true);
  assert.deepEqual(steps(), ['alpha:login', 'alpha:remote']);
  await health.check(false);
  assert.deepEqual(steps(), []);
  await assert.rejects(health.check('sometimes'), TypeError);
});

/** Answers like the real CLIs for health checks only; `calls` records [provider, args]. */
function cliStandIns(files) {
  const calls = [];
  const provider = (bin) => Object.keys(files).find((id) => files[id] === bin);
  const run = async (bin, args) => {
    const id = provider(bin);
    calls.push([id, args.join(' ')]);
    const ok = (stdout, stderr = '') => ({ code: 0, stdout, stderr });
    if (args[0] === '--version') return ok(`${id} 9.9.9\n`);
    if (args.join(' ') === 'exec --help') return ok('--ignore-user-config --ephemeral --json');
    if (id === 'claude' && args[0] === '--help')
      return ok('--safe-mode --tools --output-format --input-format\n  --effort <level> (low, high)\n');
    if (id === 'cursor' && args[0] === '--help')
      return ok('--print --trust --mode --sandbox --workspace --model --output-format');
    if (args.join(' ') === 'login status') return ok('', 'Logged in using ChatGPT\n');
    if (args.join(' ') === 'debug models') {
      const levels = [{ effort: 'low' }, { effort: 'high' }];
      return ok(JSON.stringify({ models: [{ slug: 'gpt-x', supported_reasoning_levels: levels }] }));
    }
    if (args.slice(-2).join(' ') === 'auth status')
      return ok(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    if (args.includes('--input-format')) {
      const models = [{ value: 'default', resolvedModel: 'claude-x', supportedEffortLevels: ['low'] }];
      return ok(
        JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { models } } })
      );
    }
    if (args.join(' ') === 'status --format json')
      return ok(JSON.stringify({ isAuthenticated: true, hasAccessToken: true }));
    if (args[0] === 'models') return ok('cursor-x - Cursor X\n');
    return { code: 2, stdout: '', stderr: `unexpected ${args.join(' ')}` };
  };
  return { run, calls };
}

test('with warm results the real providers start only their three login checks', async (t) => {
  const dir = await tempDir(t);
  const { env, files } = await executables(dir, ['codex', 'claude', 'cursor']);
  const { run, calls } = cliStandIns(files);
  const health = createHealthChecker({ run, runtimeDir: dir, env });
  t.after(() => health.close());

  const cold = await health.check('full');
  for (const id of ['codex', 'claude', 'cursor']) {
    assert.equal(cold[id].subscription, true, `${id}: ${cold[id].message}`);
    assert.equal(cold[id].version, `${id} 9.9.9`);
    assert.equal(cold[id].supportsWeb, true);
  }
  assert.deepEqual(cold.codex.models, ['gpt-x']);
  assert.deepEqual(cold.claude.models, ['claude-x']);
  assert.deepEqual(cold.cursor.models, ['cursor-x']);
  assert.equal(calls.length, 12, 'Version, help, login and catalogue for each provider');

  calls.length = 0;
  const warm = await health.check('login', undefined, ['codex', 'claude', 'cursor']);
  assert.deepEqual(calls.map(([id, args]) => `${id}: ${args.replace(/^.* (auth status)$/, '$1')}`).sort(), [
    'claude: auth status',
    'codex: login status',
    'cursor: status --format json'
  ]);
  assert.deepEqual(warm.cursor.models, ['cursor-x'], 'The catalogue is reused');
  assert.deepEqual(warm.claude.reasoningLevels, ['low']);
});
