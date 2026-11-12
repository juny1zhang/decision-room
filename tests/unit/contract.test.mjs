// The adapters against real CLI output, captured in tests/fixtures/cli (see its README.md). The mock CLIs in
// tests/support encode what the maintainers expect of the CLIs; only these tests notice when that and a real
// CLI differ. scripts/check-cli-contract.mjs runs the same checks against the CLIs installed on a machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseHealth } from '../../src/health.mjs';
import { claudeEffortLevels } from '../../src/providers/claude.mjs';
import { codexCatalog } from '../../src/providers/codex.mjs';
import { checkCli, helpOptions, listsFlag, missingFlags } from '../../src/providers/common.mjs';
import { getProvider, PROVIDERS } from '../../src/providers/index.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/cli/', import.meta.url));

/** The CLI versions captured, and the file that holds each command's output. Cursor is not captured yet. */
const CAPTURED = {
  codex: {
    version: '0.167.2',
    files: {
      '--version': 'version.txt',
      '--help': 'help.txt',
      'exec --help': 'exec-help.txt',
      'debug models': 'debug-models.json'
    }
  },
  claude: { version: '2.1.322', files: { '--version': 'version.txt', '--help': 'help.txt' } }
};

/** The captured output of `args` for provider `id`, or undefined when that command was not captured. */
function captured(id, args) {
  const capture = CAPTURED[id];
  const file = capture?.files[args.join(' ')];
  return file && readFileSync(path.join(FIXTURES, `${id}-${capture.version}-${file}`), 'utf8');
}

const isFlag = (arg) => /^--?[A-Za-z]/.test(arg);
/** The command a help check describes, by the words of its arguments: '' for the CLI itself, 'exec', … */
const commandOf = (check) => check.args.filter((arg) => !arg.startsWith('-')).join(' ');

/**
 * A stand-in for runProcess. It answers the captured commands of `provider` with their real output, and,
 * for a provider without captures, its version and help commands with a version line and option lines
 * made from its contract. Other commands get `answer(args, options)`, a partial { code, stdout, stderr },
 * or fail. `calls` records every argument list.
 */
function fakeCli(provider, answer = () => undefined) {
  const calls = [];
  const { contract } = provider;
  const run = async (_bin, args, options = {}) => {
    calls.push(args);
    let stdout = captured(provider.id, args);
    if (stdout === undefined && !CAPTURED[provider.id]) {
      const check = contract.helpChecks.find((item) => item.args.join(' ') === args.join(' '));
      if (args.join(' ') === contract.versionArgs.join(' ')) stdout = `${provider.id} 1.0.0\n`;
      else if (check) stdout = check.flags.map((flag) => `  ${flag}  Stand-in`).join('\n') + '\n';
    }
    if (stdout !== undefined) return { code: 0, stdout, stderr: '' };
    const reply = answer(args, options);
    return reply
      ? { code: 0, stdout: '', stderr: '', ...reply }
      : { code: 2, stdout: '', stderr: `unexpected command: ${args.join(' ')}\n` };
  };
  return { run, calls };
}

const json = (value) => ({ stdout: JSON.stringify(value) + '\n' });

// Answers that take each adapter through its login and catalogue checks, and through an answer.
const ANSWERS = {
  codex(args, { onLine }) {
    if (args.join(' ') === 'login status') return { stderr: 'Logged in using ChatGPT\n' };
    if (args.includes('exec')) {
      onLine?.(JSON.stringify({ type: 'turn.completed' }));
      return {};
    }
  },
  claude(args) {
    if (args.slice(-2).join(' ') === 'auth status') return json({ loggedIn: true, authMethod: 'claude.ai' });
    if (args.includes('--input-format')) {
      const models = [{ value: 'default', resolvedModel: 'claude-x', supportedEffortLevels: ['low'] }];
      return json({ type: 'control_response', response: { subtype: 'success', response: { models } } });
    }
    if (args.includes('-p'))
      return json({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
  },
  cursor(args) {
    if (args.join(' ') === 'status --format json')
      return json({ isAuthenticated: true, hasAccessToken: true });
    if (args.join(' ') === 'models') return { stdout: 'auto - Auto\n' };
    if (args.includes('--print')) return json({ type: 'result', is_error: false, result: 'ok' });
  }
};

/**
 * Every argument list `provider` passes to its CLI while it checks the CLI and while it answers, once with
 * every option on and once with them off.
 */
async function commandLines(provider) {
  const { run, calls } = fakeCli(provider, ANSWERS[provider.id]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-contract-'));
  try {
    const info = await provider.inspect({
      bin: provider.id,
      run,
      runtimeDir: dir,
      info: baseHealth(provider),
      cli: (check) => check(),
      remote: (_key, check) => check()
    });
    assert.equal(info.subscription, true, `${provider.id}: ${info.message}`);
    for (const options of [{ model: 'model-x', reasoning: 'high', webSearch: true }, { webSearch: false }]) {
      // Only the arguments matter here: an answer the stand-in does not imitate may fail.
      await provider
        .invoke({
          bin: provider.id,
          run,
          workDir: dir,
          prompt: 'Q',
          instructions: 'I',
          timeout: 5000,
          ...options
        })
        .catch(() => {});
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  return calls;
}

/**
 * [{ flag, command }] for each flag in `args`: the command it is passed to, by the words of the help checks
 * of `contract`. In `codex --no-daemon exec --json`, --no-daemon goes to '' (the CLI) and --json to 'exec'.
 */
function flagUses(contract, args) {
  const commands = new Set(contract.helpChecks.map(commandOf));
  let command = '';
  const uses = [];
  for (const arg of args) {
    const deeper = command ? `${command} ${arg}` : arg;
    if (isFlag(arg)) uses.push({ flag: arg.split('=')[0], command });
    else if (/^[a-z][\w-]*$/.test(arg) && commands.has(deeper)) command = deeper;
  }
  return uses;
}

test('every adapter has a contract the checks can read', () => {
  const flags = (list) =>
    Array.isArray(list) && list.every((item) => typeof item === 'string' && isFlag(item));
  for (const { id, contract } of PROVIDERS) {
    assert.ok(contract.versionArgs.length > 0 && flags(contract.versionArgs), id);
    assert.ok(flags(contract.hiddenFlags), id);
    assert.ok(contract.helpChecks.length > 0, id);
    for (const check of contract.helpChecks) {
      const name = `${id} ${check.args.join(' ')}`;
      assert.ok(['--help', '-h'].includes(check.args.at(-1)), `${name}: a help command`);
      assert.ok(check.flags.length > 0 && flags(check.flags), name);
      assert.ok(
        (check.required ?? []).every((flag) => check.flags.includes(flag)),
        `${name}: required flags are among its flags`
      );
    }
    const commands = contract.helpChecks.map(commandOf);
    assert.equal(new Set(commands).size, commands.length, `${id}: one help check per command`);
  }
});

test('the contract of every adapter names each flag it passes, and only those', async () => {
  for (const provider of PROVIDERS) {
    const { id, contract } = provider;
    // A help check's own arguments, and the version command's, count as declared.
    const declared = new Map(
      contract.helpChecks.map((check) => [commandOf(check), new Set([...check.flags, ...check.args])])
    );
    for (const arg of contract.versionArgs) declared.get('')?.add(arg);
    const passed = new Set();
    for (const args of await commandLines(provider)) {
      for (const { flag, command } of flagUses(contract, args)) {
        passed.add(`${command} ${flag}`);
        assert.ok(
          contract.hiddenFlags.includes(flag) || declared.get(command)?.has(flag),
          `${id} passes ${flag} to "${[id, command].filter(Boolean).join(' ')}": add it to its contract`
        );
      }
    }
    for (const check of contract.helpChecks) {
      for (const flag of check.flags)
        assert.ok(
          passed.has(`${commandOf(check)} ${flag}`),
          `${id}: the contract lists ${flag}, never passed`
        );
    }
    for (const flag of contract.hiddenFlags)
      assert.ok(
        [...passed].some((use) => use.endsWith(` ${flag}`)),
        `${id}: hidden ${flag} is never passed`
      );
  }
});

test('the captured help of each CLI version lists every flag the app passes, unless it is hidden', () => {
  for (const id of Object.keys(CAPTURED)) {
    const { contract } = getProvider(id);
    for (const check of contract.helpChecks) {
      const name = `${id} ${CAPTURED[id].version}: ${id} ${check.args.join(' ')}`;
      const help = captured(id, check.args);
      assert.ok(help, `${name} is not captured`);
      const options = helpOptions(help);
      const hidden = contract.hiddenFlags;
      assert.deepEqual(
        check.flags.filter((flag) => !options.has(flag) && !hidden.includes(flag)),
        [],
        `${name} lists no such option`
      );
      assert.deepEqual(
        hidden.filter((flag) => options.has(flag)),
        [],
        `${name} lists a hidden flag: move it to flags`
      );
    }
  }
});

test('the check before a CLI is first used accepts the captured Codex and Claude output', async () => {
  const expected = {
    codex: ['--version', 'exec --help'],
    claude: ['--version', '--help']
  };
  for (const id of Object.keys(CAPTURED)) {
    const provider = getProvider(id);
    const { run, calls } = fakeCli(provider);
    const result = await checkCli(run, id, { id, contract: provider.contract });
    assert.equal(result.ok, true, `${id}: ${result.message}`);
    assert.equal(result.version, captured(id, ['--version']).trim());
    assert.ok(result.version.includes(CAPTURED[id].version), result.version);
    assert.deepEqual(calls.map((args) => args.join(' ')).sort(), expected[id].sort());
  }
});

test('the check before a CLI is first used reports help that lost a required flag', async () => {
  const { contract } = getProvider('codex');
  const help = captured('codex', ['exec', '--help']);
  const withoutEphemeral = help.replace(/^ +--ephemeral\n.*\n/m, '');
  assert.notEqual(withoutEphemeral, help);
  const run = async (_bin, args) => ({
    code: 0,
    stdout: args[0] === '--version' ? 'codex-cli 0.167.2\n' : withoutEphemeral,
    stderr: ''
  });
  const result = await checkCli(run, 'codex', { id: 'codex', contract });
  assert.equal(result.ok, false);
  assert.equal(result.message, 'codex 版本需要更新：本应用需要 --ignore-user-config、--ephemeral、--json。');
  const failing = async (_bin, args) =>
    args[0] === '--version'
      ? { code: 0, stdout: 'codex-cli 0.167.2\n', stderr: '' }
      : { code: 2, stdout: '', stderr: "error: unrecognized subcommand 'exec'\n" };
  assert.equal((await checkCli(failing, 'codex', { id: 'codex', contract })).ok, false);
});

test('flags count as listed only as whole words, and only option lines define options', () => {
  const help = [
    'Usage: tool [options]',
    '  -p, --print                 Print and exit',
    '  --bare                      Minimal mode. Provide context via --settings,',
    '                              --mcp-config and --add-dir.',
    '  --allowed, --allowed-tools <tools...>',
    '      Comma-separated tool names',
    '  -c, --config <key=value>',
    '          Override a configuration value',
    '      --image <FILE>...',
    '\u001b[1m  --colour\u001b[22m [when]          Coloured output',
    '  --model-file <file>         Read the model from a file',
    '          - on-request: possible value'
  ].join('\n');
  assert.deepEqual([...helpOptions(help)].sort(), [
    '--allowed',
    '--allowed-tools',
    '--bare',
    '--colour',
    '--config',
    '--image',
    '--model-file',
    '--print',
    '-c',
    '-p'
  ]);
  assert.deepEqual(
    missingFlags(help, ['-p', '--print', '--settings', '--model', '--json', '-o', '--colour']),
    ['--model', '--json', '-o']
  );
  assert.equal(listsFlag(help, '--mcp-config'), true, 'A mention is enough for the check before first use');
  assert.equal(listsFlag('--input-formats', '--input-format'), false);
  assert.equal(listsFlag('--input-format --output-format', '--input-format'), true);
});

test('Claude --effort levels read from the captured help', () => {
  assert.deepEqual(claudeEffortLevels(captured('claude', ['--help'])), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ]);
});

test('the Codex catalogue of the captured `debug models` lists exactly the 9 visible models and their levels', async () => {
  const { run, calls } = fakeCli(getProvider('codex'));
  const catalog = await codexCatalog('codex', run);
  assert.deepEqual(calls, [['debug', 'models']]);
  const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const toMax = levels.slice(0, 5);
  assert.deepEqual(catalog.models, [
    'gpt-6-astra',
    'gpt-6.1-sol',
    'gpt-6.1-terra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5'
  ]);
  assert.deepEqual(catalog.reasoningByModel, {
    'gpt-6-astra': levels,
    'gpt-6.1-sol': levels,
    'gpt-6.1-terra': levels,
    'gpt-6-sol': levels,
    'gpt-6-luna': toMax,
    'gpt-5.6-sol': levels,
    'gpt-5.6-terra': levels,
    'gpt-5.6-luna': toMax,
    'gpt-5.5': ['low', 'medium', 'high', 'xhigh']
  });
  assert.deepEqual(
    catalog.reasoningLevels,
    ['low', 'medium', 'high', 'xhigh'],
    'The levels all models share'
  );
  const { models } = JSON.parse(captured('codex', ['debug', 'models']));
  assert.equal(models.length, 12);
  assert.deepEqual(
    catalog.models,
    models.filter((model) => model.visibility === 'list').map((model) => model.slug),
    'The 3 models with visibility "hide" are left out'
  );
});

test('Codex reads the captured logged-out status as not signed in and asks for no models', async () => {
  const status = JSON.parse(
    readFileSync(path.join(FIXTURES, 'codex-0.167.2-login-status-logged-out.json'), 'utf8')
  );
  const provider = getProvider('codex');
  const { run, calls } = fakeCli(provider, (args) =>
    args.join(' ') === status.args.join(' ')
      ? { code: status.code, stdout: status.stdout, stderr: status.stderr }
      : undefined
  );
  const info = await provider.inspect({
    bin: 'codex',
    run,
    info: baseHealth(provider),
    cli: (check) => check(),
    remote: () => assert.fail('No model catalogue without a login')
  });
  assert.equal(info.authenticated, false);
  assert.equal(info.subscription, false);
  assert.equal(info.message, '请执行 codex login，选择 Sign in with ChatGPT。');
  assert.equal(info.version, 'codex-cli 0.167.2');
  assert.deepEqual(info.models, []);
  assert.ok(calls.some((args) => args.join(' ') === 'login status'));
});
