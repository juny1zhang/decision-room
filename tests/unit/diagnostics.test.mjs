import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  FAILURE_CATEGORIES,
  classifyFailure,
  diagnosticFailure,
  failureError
} from '../../src/diagnostics.mjs';
import { AppError } from '../../src/errors.mjs';
import claude from '../../src/providers/claude.mjs';
import codex from '../../src/providers/codex.mjs';
import cursor, { classifyCursorFailure } from '../../src/providers/cursor.mjs';

const NETWORK = '未能连接官方模型服务，请检查本机网络和证书设置。';
const QUOTA = '套餐额度或速率限制已触发。请在对应官方工具查看用量，稍后再试；本应用不会自动切换 API。';
const AUTH = '登录无效或已过期。请在终端重新登录对应官方 CLI，再点击重新检查。';
// A model answer that talks about limits and logins. It is the model's text, never a reason for a failure.
const ANSWER =
  '方案 A 会触发 rate limit 与 quota 上限，账号需要重新 login，接口可能返回 401 或 not logged in。';

/** A stand-in for runProcess: the CLI prints `stdout` and `stderr`, then exits with `code`. */
function fakeRun({ code = 0, stdout = '', stderr = '' }) {
  return async (bin, args, options = {}) => {
    for (const line of stdout.split('\n')) {
      try {
        options.onLine?.(line);
      } catch {}
    }
    return { code, stdout, stderr };
  };
}

async function call(provider, output) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-diagnostics-'));
  try {
    return await provider.invoke({
      bin: 'cli',
      run: fakeRun(output),
      workDir,
      signal: new AbortController().signal,
      prompt: '问题',
      instructions: '',
      model: '',
      reasoning: '',
      webSearch: false,
      timeout: 1000
    });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Asserts that `provider` fails on `output` with an AppError of `category` and `message`. */
async function failsWith(provider, output, category, message) {
  await assert.rejects(call(provider, output), (error) => {
    assert.ok(error instanceof AppError, error.stack);
    assert.equal(error.category, category);
    assert.equal(error.message, message);
    return true;
  });
}

const lines = (...events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const agentMessage = (text) => ({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text } });

test('classifyFailure names the category and keeps every message', () => {
  const cases = [
    ["You've hit your usage limit. Try again later.", 'quota', QUOTA],
    ['unexpected status 429 Too Many Requests', 'quota', QUOTA],
    ['Error: Not logged in. Please run codex login.', 'auth', AUTH],
    ['HTTP 401 Unauthorized', 'auth', AUTH],
    [
      "error: unexpected argument '--safe-mode' found",
      'cli',
      '当前 CLI 版本不支持所需参数。请按官方安装文档更新后重试。'
    ],
    [
      'The model gpt-9 is not supported when using Codex with a ChatGPT account.',
      'model',
      '当前账号或 CLI 无法使用所选模型，请检查模型 ID 或改用默认模型。'
    ],
    [
      'stream disconnected before completion: error sending request for url (https://example.invalid)',
      'network',
      NETWORK
    ],
    ['TypeError: fetch failed', 'network', NETWORK],
    ['Error: getaddrinfo ENOTFOUND api.example.invalid', 'network', NETWORK],
    ['API Error: Connection error.', 'network', NETWORK],
    ['read ECONNRESET', 'network', NETWORK],
    // A certificate that has expired is a connection problem, not an expired login.
    ['unable to verify the first certificate: certificate has expired', 'network', NETWORK]
  ];
  for (const [stderr, category, message] of cases) {
    assert.deepEqual(classifyFailure({ code: 1, stderr }), { category, message }, stderr);
  }
  assert.deepEqual(classifyFailure({ code: 3, stderr: 'something unexpected' }), {
    category: 'other',
    message: '官方 CLI 未成功完成（退出码 3）。请在对应 CLI 中检查所选模型、账号权限和网络。'
  });
  assert.match(classifyFailure({ code: null }).message, /退出码 未知/);
  // Structured errors count; they may be strings or objects with a message.
  assert.equal(
    classifyFailure({ code: 1, errors: [null, { message: 'usage limit reached' }] }).category,
    'quota'
  );
  assert.equal(classifyFailure({ code: 1, errors: ['fetch failed'] }).category, 'network');
});

test('diagnostics never read stdout, which holds the model text', () => {
  assert.equal(classifyFailure({ code: 1, stdout: ANSWER, stderr: '' }).category, 'other');
  assert.equal(
    diagnosticFailure({ code: 1, stdout: ANSWER, stderr: '' }),
    classifyFailure({ code: 1 }).message
  );
  assert.equal(diagnosticFailure({ code: 1, stdout: '', stderr: 'quota exceeded' }), QUOTA);
});

test('failureError is an AppError carrying its category', () => {
  assert.deepEqual(FAILURE_CATEGORIES, ['quota', 'auth', 'cli', 'model', 'network', 'other']);
  const error = failureError({ category: 'network', message: NETWORK });
  assert.ok(error instanceof AppError);
  assert.equal(error.status, 400);
  assert.equal(error.category, 'network');
  assert.equal(error.message, NETWORK);
});

test('Codex failures are classified from stderr and reported errors, not from its answer', async () => {
  const answered = lines({ type: 'thread.started' }, { type: 'turn.started' }, agentMessage(ANSWER));
  // The regression: the answer mentioned a quota and a login while the connection failed.
  await failsWith(
    codex,
    {
      code: 1,
      stdout: answered,
      stderr: 'ERROR stream disconnected before completion: error sending request'
    },
    'network',
    NETWORK
  );
  await failsWith(
    codex,
    { code: 1, stdout: answered },
    'other',
    '官方 CLI 未成功完成（退出码 1）。请在对应 CLI 中检查所选模型、账号权限和网络。'
  );
  await failsWith(
    codex,
    {
      code: 1,
      stdout: lines(agentMessage(ANSWER), {
        type: 'turn.failed',
        error: { message: "You've hit your usage limit." }
      })
    },
    'quota',
    QUOTA
  );
  await failsWith(
    codex,
    {
      code: 0,
      stdout: lines(
        agentMessage(ANSWER),
        { type: 'error', message: 'Reconnecting... 5/5 (stream disconnected before completion)' },
        { type: 'turn.failed', error: { message: 'exceeded retry limit' } }
      )
    },
    'network',
    NETWORK
  );
  await failsWith(
    codex,
    { code: 0, stdout: lines(agentMessage(ANSWER)) },
    'other',
    'Codex 没有返回完成标记，未将这次输出认定为有效结论。'
  );
  // A turn that recovered from a reported error still succeeds.
  const recovered = await call(codex, {
    code: 0,
    stdout: lines({ type: 'error', message: 'Reconnecting... 1/5' }, agentMessage(ANSWER), {
      type: 'turn.completed',
      usage: {}
    })
  });
  assert.equal(recovered.text, ANSWER);
});

test('Claude failures read its result only when the CLI marked it as an error', async () => {
  const success = (result) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result });
  await failsWith(
    claude,
    { code: 1, stdout: success(ANSWER), stderr: 'TypeError: fetch failed' },
    'network',
    NETWORK
  );
  await failsWith(
    claude,
    { code: 1, stdout: success(ANSWER) },
    'other',
    '官方 CLI 未成功完成（退出码 1）。请在对应 CLI 中检查所选模型、账号权限和网络。'
  );
  await failsWith(
    claude,
    {
      code: 1,
      stdout: JSON.stringify({
        subtype: 'success',
        is_error: true,
        result: 'Claude AI usage limit reached|1760000000'
      })
    },
    'quota',
    QUOTA
  );
  await failsWith(
    claude,
    {
      code: 0,
      stdout: JSON.stringify({
        subtype: 'error_during_execution',
        errors: ['API Error: 401 authentication_error']
      })
    },
    'auth',
    AUTH
  );
  await failsWith(
    claude,
    { code: 1, stdout: JSON.stringify({ subtype: 'error_max_turns', is_error: true }) },
    'other',
    'Claude 达到本轮工具调用上限。请缩小问题，或关闭联网后重试。'
  );
  await failsWith(
    claude,
    { code: 0, stdout: 'not json' },
    'cli',
    '无法解析 Claude 返回结果。请更新 Claude Code 后重试。'
  );
  const answer = await call(claude, {
    code: 0,
    stdout: JSON.stringify({
      subtype: 'success',
      is_error: false,
      result: ANSWER,
      modelUsage: { 'mock-claude': {} }
    })
  });
  assert.deepEqual(answer, { text: ANSWER, model: 'mock-claude' });
});

test('Cursor failures use its own classifier on stderr and error results only', async () => {
  const result = (fields) =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...fields });
  await failsWith(
    cursor,
    { code: 1, stdout: result({ result: ANSWER }), stderr: 'ConnectError: [unavailable] Connection lost' },
    'network',
    'Cursor 与模型服务的连接已中断。请检查网络后重试。'
  );
  await failsWith(
    cursor,
    { code: 1, stdout: result({ result: ANSWER }) },
    'other',
    'Cursor 调用失败（退出码 1）。请在终端检查 agent status、网络和模型权限。'
  );
  await failsWith(
    cursor,
    {
      code: 0,
      stdout: result({ is_error: true, result: "Error: Authentication required. Run 'agent login'." })
    },
    'auth',
    'Cursor 登录已失效。请运行 agent login 后重新检查。'
  );
  await failsWith(
    cursor,
    { code: 1, stderr: '[resource_exhausted] usage limit for this billing cycle' },
    'quota',
    'Cursor 用量或速率已达上限。请检查账号用量后重试。'
  );
  await failsWith(
    cursor,
    { code: 1, stderr: 'Cannot use this model: mock-x' },
    'model',
    'Cursor 无法使用所选模型。请重新检查连接，并从模型列表选择。'
  );
  // Every service error is a ConnectError: only the transport codes are a lost connection, which is retried.
  for (const [stderr, category] of [
    ['ConnectError: [unauthenticated] Authentication required', 'auth'],
    ['ConnectError: [resource_exhausted] You have hit your usage limit', 'quota'],
    ['ConnectError: [permission_denied] Model not available', 'model'],
    ['Error: Model unavailable: mock-x', 'model'],
    ['ConnectError: [deadline_exceeded] the operation timed out', 'network'],
    ['ConnectError: [invalid_argument] bad request', 'other']
  ])
    assert.equal(classifyCursorFailure({ code: 1, stderr }).category, category, stderr);
  // Failures Cursor's own patterns do not name fall back to the shared ones.
  await failsWith(
    cursor,
    { code: 1, stderr: 'Error: getaddrinfo ENOTFOUND api2.example.invalid' },
    'network',
    NETWORK
  );
  await failsWith(
    cursor,
    { code: 0, stdout: result({ is_error: true, result: 'odd' }) },
    'other',
    'Cursor 未返回有效的回答。'
  );
  await failsWith(
    cursor,
    { code: 0, stdout: result({ result: '  ' }) },
    'other',
    'Cursor 未返回有效的回答。'
  );
  assert.match(classifyCursorFailure({ code: null }).message, /退出码 未知/);
  const answer = await call(cursor, { code: 0, stdout: result({ result: ` ${ANSWER} `, model: 'auto' }) });
  assert.deepEqual(answer, { text: ANSWER, model: 'auto' });
});
