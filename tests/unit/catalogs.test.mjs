import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeCatalog } from '../../src/providers/claude.mjs';
import { codexCatalog } from '../../src/providers/codex.mjs';
import { parseModelList } from '../../src/providers/cursor.mjs';

/** A stand-in for runProcess that records its calls and answers with `reply`. */
function fakeRun(reply) {
  const calls = [];
  const run = async (bin, args, options) => {
    calls.push({ bin, args, options });
    if (reply instanceof Error) throw reply;
    return { code: 0, stdout: '', stderr: '', ...reply };
  };
  return { run, calls };
}

const levels = (...efforts) => efforts.map((effort) => ({ effort, description: effort }));

test('Codex catalog lists visible models with their reasoning levels in effort order', async () => {
  const { run, calls } = fakeRun({
    stdout: JSON.stringify({
      models: [
        {
          slug: 'gpt-5',
          visibility: 'list',
          supported_reasoning_levels: levels('high', 'low', 'medium', 'turbo')
        },
        { slug: 'gpt-5-mini', supported_reasoning_levels: levels('minimal', 'low', 'medium') },
        { slug: 'internal-model', visibility: 'hide', supported_reasoning_levels: levels('low') },
        { slug: '--flag-like', visibility: 'list', supported_reasoning_levels: levels('low') },
        { slug: 'codex-auto', visibility: 'list' }
      ]
    })
  });
  const catalog = await codexCatalog('/bin/codex', run, undefined);
  assert.deepEqual(catalog, {
    models: ['gpt-5', 'gpt-5-mini', 'codex-auto'],
    reasoningByModel: {
      'gpt-5': ['low', 'medium', 'high'],
      'gpt-5-mini': ['minimal', 'low', 'medium'],
      'codex-auto': []
    },
    reasoningLevels: []
  });
  assert.deepEqual(calls[0].args, ['debug', 'models']);
  assert.equal(calls[0].options.timeout, 6500);
});

test('Codex catalog reports the reasoning levels every model shares', async () => {
  const { run } = fakeRun({
    stdout: JSON.stringify({
      models: [
        { slug: 'a', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh') },
        { slug: 'b', supported_reasoning_levels: levels('minimal', 'low', 'medium', 'high') }
      ]
    })
  });
  assert.deepEqual((await codexCatalog('codex', run)).reasoningLevels, ['low', 'medium', 'high']);
});

test('Codex catalog fails when the CLI cannot list models', async () => {
  const { run } = fakeRun({ code: 2, stderr: 'unknown command' });
  await assert.rejects(codexCatalog('codex', run), /model catalog unavailable/);
  const empty = fakeRun({ stdout: JSON.stringify({ models: [] }) });
  assert.deepEqual(await codexCatalog('codex', empty.run), {
    models: [],
    reasoningByModel: {},
    reasoningLevels: []
  });
});

test('Claude catalog falls back to aliases and reads effort levels from --help on the next line', async () => {
  const help =
    '--safe-mode --model <model> --tools --output-format\n' +
    '  --effort <level>  Effort level for the current session\n' +
    '                    (low, medium, high, xhigh, max)\n';
  const { run, calls } = fakeRun({});
  assert.deepEqual(await claudeCatalog('claude', run, help), {
    models: ['sonnet', 'opus', 'haiku'],
    reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    reasoningByModel: {}
  });
  assert.equal(calls.length, 0, 'Without --input-format the CLI is not asked');
});

test('Claude catalog reads effort levels from --help on the same line and ignores unknown ones', async () => {
  const { run } = fakeRun({});
  const sameLine = await claudeCatalog(
    'claude',
    run,
    '  --effort <level>  Effort (high, LOW, medium, extreme)\n'
  );
  assert.deepEqual(sameLine.reasoningLevels, ['medium', 'high']);
  assert.deepEqual((await claudeCatalog('claude', run, '--model <model>\n')).reasoningLevels, []);
});

test('Claude catalog lists aliases and exact model IDs from the initialize response', async () => {
  const supportedEffortLevels = ['low', 'medium', 'high'];
  const models = [
    { value: 'default', resolvedModel: 'claude-default-id', supportedEffortLevels },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-id', supportedEffortLevels: ['high', 'low', 'max'] },
    { value: 'haiku', resolvedModel: 'claude-haiku-id', supportsEffort: false, supportedEffortLevels },
    { value: 'bad id', resolvedModel: '--flag' }
  ];
  const stdout = [
    'not json',
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'error', response: { models: [] } } }),
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', response: { models } } })
  ].join('\n');
  const { run, calls } = fakeRun({ stdout });
  const help = '--input-format --output-format\n --effort <level> (low, medium)\n';
  const catalog = await claudeCatalog('claude', run, help);
  assert.deepEqual(catalog.models, [
    'claude-default-id',
    'sonnet',
    'claude-sonnet-id',
    'haiku',
    'claude-haiku-id'
  ]);
  assert.deepEqual(
    { ...catalog.reasoningByModel },
    {
      'claude-default-id': ['low', 'medium', 'high'],
      sonnet: ['low', 'high', 'max'],
      'claude-sonnet-id': ['low', 'high', 'max'],
      haiku: [],
      'claude-haiku-id': []
    }
  );
  assert.deepEqual(catalog.reasoningLevels, ['low', 'medium', 'high'], 'Levels of the default model');
  const [{ args, options }] = calls;
  assert.deepEqual(args.slice(0, 4), ['--safe-mode', '--setting-sources', '', '--settings']);
  assert.deepEqual(JSON.parse(args[4]), { forceLoginMethod: 'claudeai', disableAllHooks: true });
  assert.ok(args.includes('stream-json') && args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.deepEqual(JSON.parse(options.input), {
    type: 'control_request',
    request_id: 'models',
    request: { subtype: 'initialize' }
  });
  assert.equal(options.timeout, 6500);
});

test('Claude catalog falls back when the model query fails, unless the check was stopped', async () => {
  const help = '--input-format\n--effort <level> (low, high)\n';
  const fallback = {
    models: ['sonnet', 'opus', 'haiku'],
    reasoningLevels: ['low', 'high'],
    reasoningByModel: {}
  };
  assert.deepEqual(await claudeCatalog('claude', fakeRun({ code: 1 }).run, help), fallback);
  assert.deepEqual(await claudeCatalog('claude', fakeRun({ stdout: 'null\n' }).run, help), fallback);
  assert.deepEqual(await claudeCatalog('claude', fakeRun(new Error('timeout')).run, help), fallback);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    claudeCatalog('claude', fakeRun(new Error('stopped')).run, help, controller.signal),
    /stopped/
  );
});

test('Cursor model list keeps one ID per line and drops headings, names and markers', () => {
  const output =
    'Available models\r\n\r\n' +
    '\u001b[1mgpt-5\u001b[0m - GPT-5\n' +
    'sonnet-4.5 (current)\n' +
    'opus-4.1 (default, thinking)\n' +
    'mock-cursor[context=1m,effort=high] - Mock\n' +
    'auto - Auto (default)\n' +
    'gpt-5 - duplicate\n' +
    'Tip: use --model <id>\n';
  assert.deepEqual(parseModelList(output), [
    'gpt-5',
    'sonnet-4.5',
    'opus-4.1',
    'mock-cursor[context=1m,effort=high]',
    'auto'
  ]);
  assert.deepEqual(parseModelList(''), []);
});
