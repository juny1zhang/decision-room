// Live previews end to end: the mock CLIs stream their answers in each CLI's own format when their help
// lists the streaming flags, and answer in one piece when it does not, as an older CLI would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../support/harness.mjs';

const ALL = { mode: 'both', participants: ['codex', 'claude', 'cursor'] };

/** The answer messages of a run's events, by provider. */
const answers = (events) =>
  Object.fromEntries(
    events
      .filter((event) => event.type === 'message' && event.message.provider)
      .map((event) => [event.message.provider, event.message])
  );

/** The model call of `provider` among the mock CLIs' call log. */
const callOf = (calls, provider) => calls.find((call) => call.provider === provider);
const outputFormat = (args) => args[args.indexOf('--output-format') + 1];

test('answers stream as previews before the final message, which keeps the full answer', async (t) => {
  // Slow pieces, so that each answer arrives in more than one preview event.
  const slow = { streamDelayMs: 150 };
  const h = await harness(t, { codex: slow, claude: slow, cursor: slow });
  const { res, raw, events } = await h.run(ALL);
  assert.equal(res.status, 200, raw);
  assert.ok(
    events.some((event) => event.type === 'done'),
    raw
  );
  const final = answers(events);
  const calls = await h.calls();
  for (const provider of ALL.participants) {
    const message = final[provider];
    assert.equal(message.text, callOf(calls, provider).result, `${provider}: the final text is unchanged`);
    const deltas = events.filter((event) => event.type === 'delta' && event.agent === provider);
    assert.ok(deltas.length >= 2, `${provider}: ${deltas.length} preview events`);
    assert.ok(deltas.every((event) => event.stage === 'analysis'));
    assert.equal(deltas[0].reset, true);
    assert.equal(deltas.map((event) => event.append).join(''), message.text, `${provider}: previews add up`);
    const lastDelta = events.lastIndexOf(deltas.at(-1));
    assert.ok(
      lastDelta < events.findIndex((event) => event.message === message),
      `${provider}: previews first`
    );
    const statuses = events.filter((event) => event.type === 'status' && event.agent === provider);
    assert.deepEqual(
      statuses.map((event) => event.text),
      ['正在独立分析', '正在思考', '正在独立分析', '已完成'],
      provider
    );
    assert.ok(Number.isInteger(message.durationMs) && message.durationMs >= 300, `${provider}: wall clock`);
  }
  const { args: claudeArgs } = callOf(calls, 'claude');
  assert.equal(outputFormat(claudeArgs), 'stream-json');
  assert.ok(claudeArgs.includes('--verbose') && claudeArgs.includes('--include-partial-messages'));
  const { args: cursorArgs } = callOf(calls, 'cursor');
  assert.equal(outputFormat(cursorArgs), 'stream-json');
  assert.ok(cursorArgs.includes('--stream-partial-output'));
  assert.ok(callOf(calls, 'codex').args.includes('--json'));

  // Usage as each CLI reported it; Cursor reported none.
  assert.deepEqual(final.codex.usage, { inputTokens: 12345, outputTokens: 1234, cachedInputTokens: 2048 });
  assert.deepEqual(final.claude.usage, { inputTokens: 4320, outputTokens: 456, cachedInputTokens: 4000 });
  assert.ok(!('usage' in final.cursor));

  // Stored with the room and in its Markdown export.
  const roomId = events.find((event) => event.type === 'room').roomId;
  const room = await (await h.request(`/api/rooms/${roomId}`)).json();
  const stored = answers(room.messages.map((message) => ({ type: 'message', message })));
  for (const provider of ALL.participants) {
    assert.equal(stored[provider].durationMs, final[provider].durationMs);
    assert.deepEqual(stored[provider].usage, final[provider].usage);
  }
  const exported = await (await h.request(`/api/rooms/${roomId}/export`)).text();
  assert.match(
    exported,
    /\n模型 · mock-codex-actual · 用时(?: \d+|不到 1) 秒 · 输入 12,345（缓存 2,048）\/ 输出 1,234 tokens\n/
  );
  assert.match(
    exported,
    /\n模型 · mock-claude · 用时(?: \d+|不到 1) 秒 · 输入 4,320（缓存 4,000）\/ 输出 456 tokens\n/
  );
  assert.match(
    exported,
    /\n用时(?: \d+|不到 1) 秒\n\nMOCK_CURSOR_RESULT_\d\n/,
    'Cursor: no model and no tokens reported'
  );
});

test('a CLI whose help lacks the streaming flags answers in one piece, as before', async (t) => {
  const old = { noStreamFlags: true };
  const h = await harness(t, { codex: old, claude: old, cursor: old });
  const { res, raw, events } = await h.run(ALL);
  assert.equal(res.status, 200, raw);
  const final = answers(events);
  const calls = await h.calls();
  for (const provider of ['claude', 'cursor']) {
    const { args } = callOf(calls, provider);
    assert.equal(outputFormat(args), 'json', provider);
    for (const flag of ['--include-partial-messages', '--stream-partial-output'])
      assert.ok(!args.includes(flag), `${provider} ${flag}`);
    assert.ok(!events.some((event) => event.type === 'delta' && event.agent === provider), provider);
  }
  for (const provider of ALL.participants) {
    assert.equal(final[provider].text, callOf(calls, provider).result, provider);
    assert.ok(Number.isInteger(final[provider].durationMs), provider);
  }
  // Codex has no flag to lose: its completed message is previewed just before it is final.
  const codexDeltas = events.filter((event) => event.type === 'delta' && event.agent === 'codex');
  assert.equal(codexDeltas.map((event) => event.append).join(''), final.codex.text);
  // Claude's one-shot result reports usage too.
  assert.deepEqual(final.claude.usage, { inputTokens: 4320, outputTokens: 456, cachedInputTokens: 4000 });
});

test('a failed call previews nothing further and its error replaces the preview', async (t) => {
  const h = await harness(t, {
    claude: { failure: { answer: '写了一半', stderr: 'TypeError: fetch failed' } }
  });
  const { res, raw, events } = await h.run({ mode: 'claude', participants: ['claude'] });
  assert.equal(res.status, 200, raw);
  assert.ok(!events.some((event) => event.type === 'delta'), 'The failed answer is never previewed');
  const error = events.find((event) => event.type === 'message' && event.message.stage === 'error');
  assert.match(error.message.text, /^Claude 分析失败：/);
  assert.ok(
    events.some((event) => event.type === 'status' && event.agent === 'claude' && event.stage === 'error')
  );
});
