import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY_LIMIT } from '../../src/config.mjs';
import { contextInEffect, questionContexts } from '../../src/messages.mjs';
import { CONTEXT_NOTE_LIMIT, ENTRY_LIMIT, historyFor, roundPrompt, shorten } from '../../src/prompts.mjs';

let sequence = 0;
const message = (role, stage, text, extra = {}) => ({
  id: `m${++sequence}`,
  role,
  stage,
  text,
  createdAt: '2026-03-01T00:00:00.000Z',
  ...extra
});
const question = (text, extra) => message('user', 'question', text, extra);
const answer = (provider, stage, text) =>
  message(provider, stage, text, { provider, model: `${provider}-model` });
const summary = (text) => message('summary', 'summary', text, { provider: 'codex', model: 'codex-model' });
const notice = (text) => message('system', 'notice', text);

/** Positions of `parts` in `text`, asserting each is present. */
function positions(text, parts) {
  return parts.map((part) => {
    const index = text.indexOf(part);
    assert.ok(index >= 0, `missing: ${part.slice(0, 40)}`);
    return index;
  });
}
const ascending = (values) => values.every((value, index) => index === 0 || values[index - 1] < value);

test('a 50,000-character latest answer is shortened and earlier questions and summaries are kept', () => {
  const long = 'H'.repeat(100) + '中'.repeat(49800) + 'T'.repeat(100);
  const room = {
    context: '',
    messages: [
      question('第一个问题'),
      answer('codex', 'analysis', 'Codex 第一轮分析'),
      answer('claude', 'analysis', 'Claude 第一轮分析'),
      answer('codex', 'review', 'Codex 第一轮审查'),
      answer('claude', 'review', 'Claude 第一轮审查'),
      summary('第一轮总结'),
      notice('状态说明不会发送给模型'),
      question('第二个问题'),
      answer('claude', 'analysis', long)
    ]
  };
  const history = historyFor(room);
  assert.ok(history.text.length <= HISTORY_LIMIT);
  assert.deepEqual([history.omitted, history.shortened], [0, 1]);
  const order = positions(history.text, [
    '[用户 / 问题]\n第一个问题',
    '[Codex / codex-model / 独立分析]\nCodex 第一轮分析',
    'Claude 第一轮审查',
    '[决策归纳（Codex） / codex-model / 讨论总结]\n第一轮总结',
    '第二个问题',
    '[Claude / claude-model / 独立分析]\n' + 'H'.repeat(100),
    `\n…（中间省略约 ${long.length - ENTRY_LIMIT} 字）…\n`,
    'T'.repeat(100)
  ]);
  assert.ok(ascending(order), 'kept messages stay in their original order');
  assert.ok(!history.text.includes('状态说明'));
  assert.ok(!roundPrompt({ context: '', history: history.text, prompt: '下一问' }).includes('这是新讨论'));
});

test('questions and summaries take the budget first, then the newest analyses and reviews', () => {
  const room = {
    messages: [
      question('Q1'),
      answer('codex', 'analysis', 'a'.repeat(1000)),
      answer('claude', 'analysis', 'b'.repeat(1000)),
      answer('codex', 'review', 'c'.repeat(1000)),
      answer('claude', 'review', 'd'.repeat(1000)),
      summary('S1'),
      question('Q2'),
      answer('codex', 'analysis', 'e'.repeat(1000)),
      answer('claude', 'analysis', 'f'.repeat(1000))
    ]
  };
  const history = historyFor(room, '', { limit: 2600 });
  assert.ok(history.text.length <= 2600);
  assert.deepEqual([history.omitted, history.shortened], [4, 0]);
  for (const letter of 'abcd') assert.ok(!history.text.includes(letter.repeat(1000)), letter);
  const order = positions(history.text, [
    '\nQ1',
    '（为控制长度，此处省略了 4 条发言）',
    '\nS1',
    '\nQ2',
    'e'.repeat(1000),
    'f'.repeat(1000)
  ]);
  assert.ok(ascending(order));

  // A newer message that no longer fits leaves room for older ones that do.
  const questions = {
    messages: [question('早'), question('x'.repeat(30000)), question('y'.repeat(30000)), question('近')]
  };
  const kept = historyFor(questions, '', { limit: 20000 });
  assert.ok(kept.text.length <= 20000);
  assert.deepEqual([kept.omitted, kept.shortened], [1, 1]);
  assert.ok(ascending(positions(kept.text, ['\n早', '此处省略了 1 条发言', 'y'.repeat(100), '\n近'])));
  assert.ok(!kept.text.includes('x'.repeat(100)));
});

test('the history never exceeds its budget and keeps messages in order', () => {
  // A small deterministic pseudo-random generator, so a failure can be reproduced.
  let seed = 20261112;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (values) => values[Math.floor(random() * values.length)];
  const roles = ['user', 'summary', 'codex', 'claude', 'cursor', 'system'];
  const sizes = [0, 10, 500, 5000, 11990, 12000, 12001, 30000, 64000];
  for (let round = 0; round < 300; round++) {
    const messages = [];
    const count = Math.floor(random() * 40);
    for (let index = 0; index < count; index++) {
      const role = pick(roles);
      const text = `<<${index}>>` + 'x'.repeat(pick(sizes));
      const extra = role === 'user' && random() < 0.3 ? { context: 'c'.repeat(pick(sizes)) } : {};
      messages.push(message(role, role === 'user' ? 'question' : 'analysis', text, extra));
    }
    const limit = random() < 0.2 ? HISTORY_LIMIT : 300 + Math.floor(random() * 60000);
    const room = { context: random() < 0.5 ? '' : 'c'.repeat(pick(sizes)), messages };
    const history = historyFor(room, room.context, { limit });
    assert.ok(history.text.length <= limit, `round ${round}: ${history.text.length} > ${limit}`);
    const shown = [...history.text.matchAll(/<<(\d+)>>/g)].map((match) => Number(match[1]));
    assert.ok(ascending(shown), `round ${round}: order`);
    const sent = messages.filter((item) => item.role !== 'system').length;
    assert.equal(shown.length + history.omitted, sent, `round ${round}: counts`);
    assert.ok(history.shortened <= shown.length);
    assert.equal(history.text === '', sent === 0, `round ${round}: empty only without messages`);
  }
});

test('shorten keeps the head and the tail around a note of the omitted length', () => {
  assert.equal(shorten('短文本', 10), '短文本');
  assert.equal(shorten('x'.repeat(ENTRY_LIMIT), ENTRY_LIMIT), 'x'.repeat(ENTRY_LIMIT));
  const text = 'a'.repeat(6000) + 'b'.repeat(38000) + 'c'.repeat(6000);
  assert.equal(
    shorten(text, ENTRY_LIMIT),
    'a'.repeat(6000) + '\n…（中间省略约 38000 字）…\n' + 'c'.repeat(6000)
  );
  // A cut never splits a character made of two UTF-16 code units.
  for (let limit = 2; limit < 12; limit++) {
    const short = shorten('😀'.repeat(10), limit);
    assert.ok(short.isWellFormed(), String(limit));
    assert.match(short, /^😀*\n…（中间省略约 \d+ 字）…\n😀+$/u);
  }
});

test('a room without earlier messages has no history and is called a new discussion', () => {
  for (const room of [{ messages: [] }, {}, { messages: 'broken' }, { messages: [notice('只有状态')] }]) {
    assert.deepEqual(historyFor(room), { text: '', omitted: 0, shortened: 0 });
  }
  assert.ok(roundPrompt({ context: '', history: '', prompt: '问题' }).includes('这是新讨论'));
  const one = historyFor({ messages: [question('第一问')] });
  assert.equal(one.text, '[用户 / 问题]\n第一问');
  assert.ok(!roundPrompt({ context: '', history: one.text, prompt: '问题' }).includes('这是新讨论'));
});

test('hand-edited messages without text, stage or model are sent without errors', () => {
  const room = { messages: [null, 'text', { role: 'user' }, { role: 'codex', text: 5, model: {} }] };
  assert.deepEqual(historyFor(room), {
    text: '[用户]\n\n\n[Codex]\n',
    omitted: 0,
    shortened: 0
  });
});

test('questions are sent with the shared context in effect when they changed it', () => {
  const messages = [
    question('Q1', { context: '预算 200 元' }),
    answer('codex', 'analysis', 'A1'),
    question('Q2'),
    answer('codex', 'analysis', 'A2'),
    question('Q3', { context: '预算 300 元' }),
    answer('codex', 'analysis', 'A3')
  ];
  const room = { context: '预算 300 元', messages };
  assert.deepEqual([...questionContexts(room).values()], ['预算 200 元', '预算 200 元', '预算 300 元']);
  assert.equal(contextInEffect(room), '预算 300 元');
  const text = historyFor(room, '预算 300 元').text;
  assert.ok(text.startsWith('[共享背景]\n预算 200 元\n\n[用户 / 问题]\nQ1\n\n'));
  assert.ok(text.includes('A1\n\n[用户 / 问题]\nQ2\n\n'), 'an unchanged context is not repeated');
  assert.ok(text.includes('\n\n[共享背景（本轮更新）]\n与上方本次的共享背景相同。\n\n[用户 / 问题]\nQ3'));
  // Against yet another context, the earlier one is shown in full.
  assert.ok(historyFor(room, '预算 400 元').text.includes('[共享背景（本轮更新）]\n预算 300 元\n\n'));

  const cleared = { messages: [...messages, question('Q4', { context: '' })] };
  assert.ok(historyFor(cleared, '').text.includes('[共享背景（本轮更新）]\n（已清空）\n\n[用户 / 问题]\nQ4'));

  const long = { messages: [question('Q1', { context: 'L'.repeat(10000) })] };
  const shortened = historyFor(long, '');
  assert.equal(shortened.shortened, 1);
  assert.ok(shortened.text.includes(`…（中间省略约 ${10000 - CONTEXT_NOTE_LIMIT} 字）…`));
  assert.equal(historyFor(long, 'L'.repeat(10000)).shortened, 0);
});

test('rooms saved before context snapshots use their saved context for earlier questions', () => {
  const legacy = { context: '旧背景', messages: [question('Q1'), answer('codex', 'analysis', 'A1')] };
  assert.equal(contextInEffect(legacy), '旧背景');
  assert.ok(historyFor(legacy, '旧背景').text.startsWith('[共享背景]\n与上方本次的共享背景相同。\n\n'));
  assert.ok(historyFor(legacy, '新背景').text.startsWith('[共享背景]\n旧背景\n\n'));

  // Once a question changed it, the old context is kept as legacyContext.
  const changed = {
    context: '新背景',
    legacyContext: '旧背景',
    messages: [...legacy.messages, question('Q2', { context: '新背景' })]
  };
  assert.deepEqual([...questionContexts(changed).values()], ['旧背景', '新背景']);
  const text = historyFor(changed, '新背景').text;
  assert.ok(text.startsWith('[共享背景]\n旧背景\n\n[用户 / 问题]\nQ1'));
  assert.ok(text.includes('[共享背景（本轮更新）]\n与上方本次的共享背景相同。\n\n[用户 / 问题]\nQ2'));
  assert.equal(contextInEffect({ messages: [] }), '');
});
