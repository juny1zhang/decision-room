// Streamed CLI output: the line readers of each adapter, usage, the help-based choice between streamed and
// one-shot output, the call wrapper's measures, and the throttled preview events of a discussion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDiscussion } from '../../src/discussion.mjs';
import { answerNote, durationText, usageText } from '../../src/export.mjs';
import { baseHealth } from '../../src/health.mjs';
import { createInvoker } from '../../src/invoke.mjs';
import claude, { MAX_TURNS, printArgs, readClaudeStream } from '../../src/providers/claude.mjs';
import { readCodexEvents } from '../../src/providers/codex.mjs';
import cursor, { readCursorStream } from '../../src/providers/cursor.mjs';
import {
  parseEvent,
  progressReporter,
  readUsage,
  STREAM_OUTPUT_LIMIT,
  sumUsage
} from '../../src/providers/stream.mjs';

const lines = (...events) =>
  events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Callbacks that record what a reader reports: [['text', chunk] | ['activity', kind], …]. */
function recorder() {
  const log = [];
  return {
    log,
    text: () =>
      log
        .filter(([kind]) => kind === 'text')
        .map(([, value]) => value)
        .join(''),
    activities: () => log.filter(([kind]) => kind === 'activity').map(([, value]) => value),
    callbacks: {
      onText: (chunk) => log.push(['text', chunk]),
      onActivity: (kind) => log.push(['activity', kind])
    }
  };
}

/** Feeds `outputLines` to a fresh reader made by `make`, returning the reader and what it reported. */
function read(make, outputLines) {
  const record = recorder();
  const reader = make(record.callbacks);
  for (const line of outputLines) reader.line(line);
  return { reader, ...record };
}

test('only JSON objects count as events', () => {
  for (const line of ['', '   ', 'not json', '{"type":', '[1,2]', 'null', '42', '"text"', undefined, null])
    assert.equal(parseEvent(line), null, String(line));
  assert.deepEqual(parseEvent('  {"type":"result"}\r'), { type: 'result' });
});

test('usage is read in either naming, with cache counts added where the CLI lists them apart', () => {
  assert.deepEqual(
    readUsage(
      { input_tokens: 12345, cached_input_tokens: 2048, output_tokens: 1234 },
      { cacheIncluded: true }
    ),
    {
      inputTokens: 12345,
      outputTokens: 1234,
      cachedInputTokens: 2048
    }
  );
  assert.deepEqual(
    readUsage({
      input_tokens: 20,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 4000,
      output_tokens: 456
    }),
    { inputTokens: 4320, outputTokens: 456, cachedInputTokens: 4000 }
  );
  assert.deepEqual(readUsage({ inputTokens: 7, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 1 }), {
    inputTokens: 11,
    outputTokens: 8,
    cachedInputTokens: 3
  });
  assert.deepEqual(readUsage({ output_tokens: 5 }), { outputTokens: 5 }, 'Unknown counts are left out');
  for (const raw of [
    null,
    undefined,
    'usage',
    [],
    {},
    { input_tokens: -1, output_tokens: 1.5, cached_input_tokens: '9' }
  ])
    assert.equal(readUsage(raw), null, JSON.stringify(raw));
  assert.deepEqual(
    sumUsage([{ inputTokens: 1, outputTokens: 2 }, null, { inputTokens: 3, cachedInputTokens: 4 }]),
    {
      inputTokens: 4,
      outputTokens: 2,
      cachedInputTokens: 4
    }
  );
  assert.equal(sumUsage([null, null]), null);
});

test('progress reports each activity change once and separates paragraphs only after text', () => {
  const record = recorder();
  const progress = progressReporter(record.callbacks);
  progress.separate();
  progress.activity('thinking');
  progress.activity('thinking');
  progress.text('');
  progress.text('A');
  progress.text('B');
  progress.separate();
  progress.activity('searching');
  progress.text('C');
  assert.deepEqual(record.log, [
    ['activity', 'thinking'],
    ['activity', 'writing'],
    ['text', 'A'],
    ['text', 'B'],
    ['activity', 'searching'],
    ['activity', 'writing'],
    ['text', '\n\n'],
    ['text', 'C']
  ]);
  // Without callbacks nothing fails.
  progressReporter().text('x');
});

const claudeDelta = (text, extra = {}) => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
  parent_tool_use_id: null,
  ...extra
});
const claudeResult = (fields = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '最终',
  ...fields
});

test('Claude stream: text deltas preview, thinking and web tools are activities, the result is the last result event', () => {
  const { reader, text, activities } = read(
    readClaudeStream,
    lines(
      { type: 'system', subtype: 'init', model: 'claude-x' },
      'not json',
      '{"type":"stream_event","event":',
      { type: 'rate_limit_event' },
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'thinking' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '…' } }
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text', text: '' } }
      },
      claudeDelta('我先'),
      claudeDelta('查一下。'),
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'WebSearch' } }
      },
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"q' } }
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: '我先查一下。' }] } },
      claudeDelta('subagent text', { parent_tool_use_id: 'toolu_1' }),
      { type: 'stream_event', event: { type: 'message_start' } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', content_block: { type: 'text', text: '' } }
      },
      claudeDelta('结论是 A。'),
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 42 } }
      },
      { type: 'stream_event', event: 'odd' },
      claudeResult({ result: '旧' }),
      claudeResult({ result: '结论是 A。', usage: { input_tokens: 1, output_tokens: 2 } })
    )
  );
  assert.equal(text(), '我先查一下。\n\n结论是 A。');
  assert.deepEqual(activities(), ['thinking', 'writing', 'searching', 'writing']);
  assert.equal(reader.result.result, '结论是 A。', 'The last result event');
});

test('Claude stream without text deltas previews each complete assistant message', () => {
  const { reader, text, activities } = read(
    readClaudeStream,
    lines(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '…' },
            { type: 'text', text: '第一段' }
          ]
        }
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch' }] } },
      { type: 'assistant', message: { content: 'odd' } },
      { type: 'assistant', message: { content: [null, { type: 'text', text: '第二段' }] } }
    )
  );
  assert.equal(text(), '第一段\n\n第二段');
  assert.deepEqual(activities(), ['thinking', 'writing', 'searching', 'writing']);
  assert.equal(reader.result, null, 'No result event');
});

const cursorText = (text) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] }
});

test('Cursor stream: pieces preview once, a repeated whole message adds nothing, web tools are activities', () => {
  const { reader, text, activities } = read(
    readCursorStream,
    lines(
      { type: 'system', subtype: 'init', model: 'Mock Model' },
      { type: 'user', message: { content: [{ type: 'text', text: '问题' }] } },
      { type: 'thinking', subtype: 'delta', text: '…' },
      'garbage',
      cursorText('先看看'),
      cursorText('网页上的说法。'),
      { type: 'tool_call', subtype: 'started', tool_call: { webSearchToolCall: { args: { query: 'x' } } } },
      { type: 'tool_call', subtype: 'completed', tool_call: { webSearchToolCall: {} } },
      cursorText('结论：方案 A 更适合，'),
      cursorText('因为预算固定。'),
      cursorText('结论：方案 A 更适合，因为预算固定。'),
      { type: 'assistant', message: { content: [{ type: 'image' }, 'odd'] } },
      { type: 'result', subtype: 'success', is_error: false, result: '结论：方案 A 更适合，因为预算固定。' }
    )
  );
  assert.equal(text(), '先看看网页上的说法。\n\n结论：方案 A 更适合，因为预算固定。');
  assert.deepEqual(activities(), ['thinking', 'writing', 'searching', 'writing']);
  assert.equal(reader.model, 'Mock Model');
  assert.equal(reader.result.result, '结论：方案 A 更适合，因为预算固定。');
});

test('Cursor stream keeps a short piece that happens to repeat the text so far', () => {
  const { text } = read(readCursorStream, lines(cursorText('好'), cursorText('好')));
  assert.equal(text(), '好好');
});

test('Codex events: agent messages preview as they grow, reasoning and web search are activities', () => {
  const agent = (type, text, id = 'agent-1') => ({ type, item: { id, type: 'agent_message', text } });
  const { reader, text, activities } = read(
    readCodexEvents,
    lines(
      { type: 'thread.started', model: 'gpt-x' },
      { type: 'item.started', item: { id: 'r1', type: 'reasoning', text: '' } },
      { type: 'item.started', item: { id: 'w1', type: 'web_search', query: 'q' } },
      '{"type":"item.updated"',
      agent('item.started', ''),
      agent('item.updated', '方案'),
      agent('item.updated', '方案 A'),
      agent('item.completed', '方案 A'),
      { type: 'item.completed', item: 'odd' },
      { type: 'error', message: 'Reconnecting... 1/5' },
      agent('item.completed', '最终结论', 'agent-2'),
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }
    )
  );
  assert.equal(text(), '方案 A\n\n最终结论');
  assert.deepEqual(activities(), ['thinking', 'searching', 'writing']);
  assert.deepEqual(reader.state, {
    completed: true,
    failed: false,
    errors: ['Reconnecting... 1/5'],
    last: '最终结论',
    model: 'gpt-x',
    usage: { inputTokens: 100, outputTokens: 7, cachedInputTokens: 40 }
  });
  const failed = read(
    readCodexEvents,
    lines({ type: 'turn.failed', error: { message: 'boom' } }, { type: 'turn.completed' })
  );
  assert.equal(failed.reader.state.failed, true);
  assert.deepEqual(failed.reader.state.errors, ['boom']);
  assert.equal(failed.reader.state.usage, null);
});

/**
 * Runs `provider`'s check with `help` as the text of every help command, then one answer whose CLI prints
 * `answerLines` (each to onLine, all of them as stdout). Resolves to { answer, call, record }: `call` is the
 * answer's { args, options }.
 */
async function checkAndAnswer(provider, help, answerLines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-streams-'));
  const bin = path.join(dir, `${provider.id}-cli`);
  const calls = [];
  const run = async (_bin, args, options = {}) => {
    calls.push({ args, options });
    if (args.includes('--version')) return { code: 0, stdout: '1.0.0\n', stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: help, stderr: '' };
    if (args.at(-1) === 'status' || args.join(' ') === 'status --format json')
      return {
        code: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: 'claude.ai',
          isAuthenticated: true,
          hasAccessToken: true
        }),
        stderr: ''
      };
    if (args.join(' ') === 'models') return { code: 0, stdout: 'auto - Auto\n', stderr: '' };
    if (args.includes('-p') || args.includes('--print')) {
      for (const line of answerLines) options.onLine?.(line);
      return { code: 0, stdout: options.keepStdout === false ? '' : answerLines.join('\n'), stderr: '' };
    }
    return { code: 2, stdout: '', stderr: 'unexpected\n' };
  };
  try {
    const info = await provider.inspect({
      bin,
      run,
      runtimeDir: dir,
      info: baseHealth(provider),
      cli: (check) => check(),
      remote: (_key, check) => check()
    });
    assert.equal(info.subscription, true, info.message);
    const record = recorder();
    const answer = await provider.invoke({
      bin,
      run,
      workDir: dir,
      prompt: 'Q',
      instructions: 'I',
      model: '',
      reasoning: '',
      webSearch: false,
      timeout: 5000,
      ...record.callbacks
    });
    const call = calls.find(({ args }) => args.includes('-p') || args.includes('--print'));
    return { answer, call, record };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Without --input-format, Claude's check asks for no model catalogue.
const CLAUDE_HELP = '--safe-mode --tools --output-format';
const CURSOR_HELP = '--print --trust --mode --sandbox --workspace --output-format --model';

test('Claude streams when its help lists the streaming flags, and answers in json otherwise', async () => {
  const usage = { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 3 };
  const streamed = await checkAndAnswer(claude, `${CLAUDE_HELP} --verbose --include-partial-messages`, [
    ...lines(claudeDelta('最'), claudeDelta('终')),
    JSON.stringify(claudeResult({ usage, modelUsage: { 'claude-x': {} } }))
  ]);
  const { args, options } = streamed.call;
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose') && args.includes('--include-partial-messages'));
  assert.equal(options.keepStdout, false);
  assert.equal(options.outputLimit, STREAM_OUTPUT_LIMIT);
  assert.equal(streamed.record.text(), '最终');
  assert.deepEqual(streamed.answer, {
    text: '最终',
    model: 'claude-x',
    usage: { inputTokens: 15, outputTokens: 3, cachedInputTokens: 10 }
  });

  const modelUsage = {
    a: { inputTokens: 1, outputTokens: 2 },
    b: { inputTokens: 3, cacheReadInputTokens: 4 }
  };
  const oneShot = await checkAndAnswer(claude, `${CLAUDE_HELP} --verbose`, [
    JSON.stringify(claudeResult({ usage, modelUsage }))
  ]);
  assert.equal(oneShot.call.args[oneShot.call.args.indexOf('--output-format') + 1], 'json');
  assert.ok(!oneShot.call.args.includes('--include-partial-messages'));
  assert.equal(oneShot.call.options.onLine, undefined);
  assert.deepEqual(
    oneShot.answer.usage,
    { inputTokens: 8, outputTokens: 2, cachedInputTokens: 4 },
    'Summed over the models'
  );
  assert.equal(oneShot.record.log.length, 0, 'No preview without streaming');
});

test('a streamed Claude answer still needs a result event, and a failed one is classified as before', async () => {
  const help = `${CLAUDE_HELP} --verbose --include-partial-messages`;
  await assert.rejects(checkAndAnswer(claude, help, lines(claudeDelta('半截'))), {
    category: 'cli',
    message: '无法解析 Claude 返回结果。请更新 Claude Code 后重试。'
  });
  await assert.rejects(
    checkAndAnswer(claude, help, lines(claudeResult({ subtype: 'error_max_turns', is_error: true }))),
    { message: 'Claude 达到本轮工具调用上限。请缩小问题，或关闭联网后重试。' }
  );
});

test('Cursor streams when its help lists --stream-partial-output, and answers in json otherwise', async () => {
  const result = { type: 'result', subtype: 'success', is_error: false, result: ' 方案 A ' };
  const streamed = await checkAndAnswer(cursor, `${CURSOR_HELP} --stream-partial-output`, [
    ...lines({ type: 'system', model: 'Mock Model' }, cursorText('方案'), cursorText(' A')),
    JSON.stringify(result)
  ]);
  const { args, options } = streamed.call;
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--stream-partial-output'));
  assert.equal(options.keepStdout, false);
  assert.equal(streamed.record.text(), '方案 A');
  assert.deepEqual(streamed.answer, { text: '方案 A', model: 'Mock Model' });

  const oneShot = await checkAndAnswer(cursor, CURSOR_HELP, [
    JSON.stringify({ ...result, usage: { inputTokens: 9, outputTokens: 1 } })
  ]);
  assert.equal(oneShot.call.args[oneShot.call.args.indexOf('--output-format') + 1], 'json');
  assert.ok(!oneShot.call.args.includes('--stream-partial-output'));
  assert.deepEqual(oneShot.answer, { text: '方案 A', model: '', usage: { inputTokens: 9, outputTokens: 1 } });
});

test('a call reports its wall-clock time and clean usage, and callbacks cannot break it', async () => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-invoke-'));
  try {
    let clock = 1000;
    const run = async (_bin, _args, { onLine }) => {
      for (const line of lines(
        { type: 'item.started', item: { type: 'reasoning' } },
        { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '答案' } },
        { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: -1, cached_input_tokens: 1.5 } }
      ))
        onLine(line);
      clock += 4200;
      return { code: 0, stdout: '', stderr: '' };
    };
    const invoke = createInvoker({ run, runtimeDir, binary: () => 'codex', now: () => clock });
    const seen = [];
    const answer = await invoke(
      'codex',
      'Q',
      false,
      new AbortController().signal,
      {},
      {
        onText(chunk) {
          seen.push(chunk);
          throw new Error('a broken page');
        },
        onActivity() {
          throw new Error('a broken page');
        }
      }
    );
    assert.deepEqual(seen, ['答案']);
    assert.deepEqual(answer, {
      text: '答案',
      model: 'Codex 默认模型',
      durationMs: 4200,
      usage: { inputTokens: 3 }
    });
    const without = await invoke('codex', 'Q', false, new AbortController().signal, {});
    assert.equal(without.text, '答案', 'Progress callbacks are optional');
  } finally {
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});

/** Runs one single-provider round with `invoke`, collecting the NDJSON events and when each was written. */
async function discuss(invoke) {
  const events = [];
  const response = {
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(chunk) {
      for (const line of String(chunk).split('\n').filter(Boolean))
        events.push({ ...JSON.parse(line), at: Date.now() });
    }
  };
  const ready = {
    subscription: true,
    supportsWeb: true,
    reasoningLevels: [],
    reasoningByModel: {},
    message: ''
  };
  await runDiscussion(
    { prompt: '问题', mode: 'codex', participants: ['codex'] },
    response,
    new AbortController().signal,
    {
      health: { check: async () => ({ codex: ready }) },
      invoke,
      rooms: { save: async () => {} }
    }
  );
  return events;
}

test('a discussion streams previews at most every 120 ms, before the answer, and stores its measures', async () => {
  const chunks = Array.from({ length: 12 }, (_, index) => `第${index}段；`);
  const events = await discuss(async (_id, _prompt, _web, _signal, _settings, { onText, onActivity }) => {
    onActivity('thinking');
    onActivity('searching');
    for (const chunk of chunks) {
      onText(chunk);
      onActivity('writing');
      await sleep(25);
    }
    onActivity('unknown');
    return { text: '最终回答', model: 'm', durationMs: 4200, usage: { inputTokens: 1, outputTokens: 2 } };
  });
  const deltas = events.filter((event) => event.type === 'delta');
  assert.ok(deltas.length >= 2 && deltas.length < chunks.length, `${deltas.length} deltas`);
  assert.equal(deltas.map((event) => event.append).join(''), chunks.join(''), 'Nothing is lost or repeated');
  assert.deepEqual(
    deltas.map(({ type, agent, stage, reset }) => ({ type, agent, stage, reset })),
    deltas.map((_, index) => ({
      type: 'delta',
      agent: 'codex',
      stage: 'analysis',
      reset: index === 0 ? true : undefined
    }))
  );
  // All but the last, which is flushed with the answer, keep the interval (a few ms of timer slack).
  for (let index = 1; index < deltas.length - 1; index++)
    assert.ok(deltas[index].at - deltas[index - 1].at >= 110, `delta ${index}`);
  const answerAt = events.findIndex((event) => event.type === 'message' && event.message.role === 'codex');
  assert.ok(events.findLastIndex((event) => event.type === 'delta') < answerAt);
  assert.deepEqual(
    events.filter((event) => event.type === 'status').map((event) => event.text),
    ['正在独立分析', '正在思考', '正在检索网页', '正在独立分析', '已完成']
  );
  const { message } = events[answerAt];
  assert.equal(message.text, '最终回答');
  assert.equal(message.durationMs, 4200);
  assert.deepEqual(message.usage, { inputTokens: 1, outputTokens: 2 });
});

test('a failed call stops its preview and stores no measures', async () => {
  const events = await discuss(async (_id, _prompt, _web, _signal, _settings, { onText }) => {
    onText('一半');
    onText('还在写');
    setTimeout(() => onText('迟到的文字'), 10);
    // Not 'network': that category is retried once (see tests/integration/resilience.test.mjs).
    throw Object.assign(new Error('连接中断'), { category: 'other' });
  });
  await sleep(200);
  const deltas = events.filter((event) => event.type === 'delta');
  assert.deepEqual(
    deltas.map((event) => event.append),
    ['一半'],
    'Text still waiting is dropped, and text after the failure is ignored'
  );
  const error = events.find((event) => event.type === 'message' && event.message.stage === 'error');
  assert.equal(error.message.text, 'Codex 分析失败：连接中断');
  assert.ok(!('durationMs' in error.message));
  assert.ok(events.some((event) => event.type === 'status' && event.stage === 'error'));
});

test('the answer note shows the known model, time and tokens', () => {
  assert.equal(durationText(42000), '用时 42 秒');
  assert.equal(durationText(400), '用时不到 1 秒');
  assert.equal(durationText(192000), '用时 3 分 12 秒');
  assert.equal(durationText(180000), '用时 3 分钟');
  for (const value of [undefined, null, -1, NaN, '42']) assert.equal(durationText(value), '');
  assert.equal(usageText({ inputTokens: 12345, outputTokens: 1234 }), '输入 12,345 / 输出 1,234 tokens');
  assert.equal(
    usageText({ inputTokens: 4320, outputTokens: 456, cachedInputTokens: 4000 }),
    '输入 4,320（缓存 4,000）/ 输出 456 tokens'
  );
  assert.equal(usageText({ outputTokens: 7, cachedInputTokens: 0 }), '输出 7 tokens');
  for (const value of [undefined, null, 'x', {}, { inputTokens: -1 }]) assert.equal(usageText(value), '');
  assert.equal(
    answerNote({
      role: 'codex',
      provider: 'codex',
      model: 'mock-codex',
      durationMs: 42000,
      usage: { inputTokens: 12345, outputTokens: 1234 }
    }),
    'mock-codex · 用时 42 秒 · 输入 12,345 / 输出 1,234 tokens'
  );
  assert.equal(answerNote({ role: 'cursor', provider: 'cursor', model: '', durationMs: 1000 }), '用时 1 秒');
  assert.equal(answerNote({ role: 'user', text: '问题' }), '');
});

test('the page words the note exactly as the export does', async () => {
  Object.assign(globalThis, {
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    addEventListener() {},
    document: { getElementById: () => null }
  });
  const page = await import('../../public/js/messages.js');
  const exported = await import('../../src/export.mjs');
  for (const ms of [0, 999, 1500, 42000, 59600, 60000, 192000, 3600000, -5, undefined])
    assert.equal(page.durationText(ms), exported.durationText(ms), String(ms));
  for (const usage of [
    { inputTokens: 12345678, outputTokens: 1, cachedInputTokens: 5 },
    { outputTokens: 0 },
    { inputTokens: 1, cachedInputTokens: 0 },
    null
  ])
    assert.equal(page.usageText(usage), exported.usageText(usage), JSON.stringify(usage));
});

test('a Claude answer may use up to MAX_TURNS turns, enough for a researched answer', () => {
  const args = printArgs({ instructions: 'x', model: '', reasoning: 'max', webSearch: true, stream: true });
  assert.equal(args[args.indexOf('--max-turns') + 1], String(MAX_TURNS));
  assert.ok(MAX_TURNS >= 30);
});
