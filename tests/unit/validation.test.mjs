import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/errors.mjs';
import { isModelId, readConfiguration, savedConfiguration } from '../../src/validation.mjs';

const defaults = { model: '', reasoning: '', capability: 'general' };

test('isModelId accepts the model ID forms the CLIs use', () => {
  for (const id of [
    'gpt-5',
    'sonnet',
    'claude-opus-4-1@20250805',
    'mock-cursor[context=1m,effort=high,fast=false]',
    'openai/gpt-oss:20b',
    'model+variant_1.5',
    'x',
    'a'.repeat(240)
  ]) {
    assert.equal(isModelId(id), true, id);
  }
});

test('isModelId rejects flags, shell syntax, overlong IDs and non-strings', () => {
  for (const id of [
    '',
    '-m',
    '--dangerously-bypass-approvals-and-sandbox',
    '.hidden',
    'has space',
    'semi;colon',
    '$(touch x)',
    '`id`',
    'a'.repeat(241),
    '模型',
    5,
    null,
    undefined,
    ['gpt-5']
  ]) {
    assert.equal(isModelId(id), false, String(id));
  }
});

test('readConfiguration fills in a Codex and Claude debate by default', () => {
  assert.deepEqual(readConfiguration({}), {
    mode: 'debate',
    participants: ['codex', 'claude'],
    moderator: 'codex',
    settings: { codex: defaults, claude: defaults },
    webSearch: false,
    maxRounds: 3
  });
});

test('readConfiguration uses the selected provider alone in single mode', () => {
  assert.deepEqual(readConfiguration({ mode: 'cursor', webSearch: true }), {
    mode: 'cursor',
    participants: ['cursor'],
    moderator: 'cursor',
    settings: { cursor: defaults },
    webSearch: true,
    maxRounds: 3
  });
});

test('readConfiguration keeps three participants with their own settings and moderator', () => {
  const settings = {
    codex: { model: 'mock-codex', reasoning: 'high', capability: 'verify' },
    claude: { model: 'sonnet', reasoning: 'medium', capability: 'risk' },
    cursor: { model: 'mock-cursor[context=1m]', reasoning: '', capability: 'plan' }
  };
  const body = { mode: 'debate', participants: ['cursor', 'claude', 'codex'], moderator: 'cursor', settings };
  assert.deepEqual(readConfiguration(body), { ...body, webSearch: false, maxRounds: 3 });
});

test('readConfiguration takes goal mode with its moderator and the most versions of its plan', () => {
  const body = { mode: 'goal', participants: ['claude', 'cursor', 'codex'], moderator: 'cursor' };
  for (const maxRounds of [1, 4, 6]) {
    const configuration = readConfiguration({ ...body, maxRounds });
    assert.equal(configuration.mode, 'goal');
    assert.equal(configuration.moderator, 'cursor');
    assert.equal(configuration.maxRounds, maxRounds);
  }
  assert.equal(readConfiguration(body).maxRounds, 3, 'three versions by default');
  // Kept in every mode, so that the choice outlives a switch to another mode.
  assert.equal(readConfiguration({ mode: 'both', maxRounds: 5 }).maxRounds, 5);
});

test('savedConfiguration keeps a valid maxRounds and gives older or broken configurations the default', () => {
  const saved = { mode: 'goal', participants: ['codex', 'claude'], moderator: 'claude' };
  assert.equal(savedConfiguration({ ...saved, maxRounds: 5 }).maxRounds, 5);
  for (const maxRounds of [undefined, 0, 7, 2.5, '4', null])
    assert.equal(savedConfiguration({ ...saved, maxRounds }).maxRounds, 3, String(maxRounds));
  // A debate saved before goal mode existed reads, and runs again, as before.
  const legacy = { mode: 'debate', participants: ['codex', 'claude'], moderator: 'codex', webSearch: true };
  assert.deepEqual(readConfiguration(savedConfiguration(legacy)), {
    ...legacy,
    settings: { codex: defaults, claude: defaults },
    maxRounds: 3
  });
});

test('readConfiguration completes partial settings and keeps settings of non-participants', () => {
  const result = readConfiguration({
    mode: 'both',
    participants: ['claude', 'codex'],
    settings: { codex: { reasoning: 'low' }, cursor: { model: 'auto' } }
  });
  assert.deepEqual(result.settings, {
    claude: defaults,
    codex: { ...defaults, reasoning: 'low' },
    cursor: { ...defaults, model: 'auto' }
  });
  assert.equal(result.moderator, 'claude');
});

test('readConfiguration rejects invalid selections with a specific message', () => {
  const participantsMessage = '参与者必须从 Codex、Claude 和 Cursor 中选择，每位只能选择一次。';
  const invalid = [
    [{ mode: 'arbitrary-executable' }, '请选择有效的讨论模式。'],
    [{ mode: 5 }, '请选择有效的讨论模式。'],
    [{ mode: 'hasOwnProperty' }, '请选择有效的讨论模式。'],
    [{ webSearch: 'yes' }, '网页检索选项无效。'],
    [{ mode: 'both', participants: 'codex' }, participantsMessage],
    [{ mode: 'both', participants: ['claude', 'claude'] }, participantsMessage],
    [{ mode: 'both', participants: ['cursor', 'other'] }, participantsMessage],
    [{ mode: 'both', participants: ['toString', 'codex'] }, participantsMessage],
    [{ mode: 'both', participants: ['codex', 'claude', 'cursor', 'codex'] }, participantsMessage],
    [{ mode: 'codex', participants: ['codex', 'claude'] }, '单方模式只能选择对应的参与者。'],
    [{ mode: 'codex', participants: ['claude'] }, '单方模式只能选择对应的参与者。'],
    [{ mode: 'both', participants: ['codex'] }, '联合讨论、目标模式和分别回答需要至少两位参与者。'],
    [{ mode: 'goal', participants: ['claude'] }, '联合讨论、目标模式和分别回答需要至少两位参与者。'],
    [
      { mode: 'goal', participants: ['claude', 'codex'], moderator: 'cursor' },
      '请从本轮参与者中选择主持人。'
    ],
    ...[0, 7, -1, 2.5, '3', null, true, NaN, Infinity].map((maxRounds) => [
      { mode: 'goal', maxRounds },
      '「最多几版」必须是 1 到 6 之间的整数。'
    ]),
    [{ mode: 'debate', maxRounds: 12 }, '「最多几版」必须是 1 到 6 之间的整数。'],
    [
      { mode: 'debate', participants: ['cursor', 'claude'], moderator: 'codex' },
      '请从本轮参与者中选择主持人。'
    ],
    [{ settings: [] }, '参与者设置无效。'],
    [{ settings: null }, '参与者设置无效。'],
    [{ settings: { other: {} } }, '参与者设置无效。'],
    [{ settings: JSON.parse('{"__proto__":{}}') }, '参与者设置无效。'],
    [{ settings: { codex: null } }, 'Codex 设置无效。'],
    [{ settings: { claude: [] } }, 'Claude 设置无效。'],
    [
      { settings: { codex: { model: '--dangerously-bypass-approvals-and-sandbox' } } },
      'Codex 模型 ID 无效。'
    ],
    [{ settings: { cursor: { model: 'a'.repeat(5000) } } }, 'Cursor 模型 ID 无效。'],
    [{ settings: { codex: { model: 5 } } }, 'Codex 模型 ID 无效。'],
    [{ settings: { claude: { reasoning: 5 } } }, 'Claude 推理强度无效。'],
    [{ settings: { claude: { reasoning: 'x'.repeat(33) } } }, 'Claude 推理强度无效。'],
    [{ settings: { codex: { capability: 'unrecognized' } } }, 'Codex 分析能力无效。']
  ];
  for (const [body, message] of invalid) {
    assert.throws(
      () => readConfiguration(body),
      (error) => error instanceof AppError && error.status === 400 && error.message === message,
      JSON.stringify(body)
    );
  }
});
