// Cursor Agent adapter: login and model checks, and one read-only `--print` turn per answer, each in a
// private home folder that only exposes the CLI's own credential file.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, errorText, failureError } from '../diagnostics.mjs';
import { systemCaEnv } from '../process.mjs';
import { stripAnsi } from '../redact.mjs';
import { checkCli, listsFlag } from './common.mjs';
import { isObject, parseEvent, progressReporter, readUsage, STREAM_OUTPUT_LIMIT } from './stream.mjs';

const credentialStores = new Map();
const authenticationError =
  /authentication (?:required|failed)|invalid or expired|unauthenticated|not logged in|\b401\b/i;
// Cursor prints every service error as a Connect RPC error ("ConnectError: [code] …"): of those, only the
// transport codes mean a lost connection.
const connectionLost =
  /connection lost|writableiterable is closed|econnreset|unavailable:|\[(?:unavailable|deadline_exceeded)\]|fetch failed/i;
// The model service stopped sending data mid-answer, and Cursor gave up after its own retries
// ("RetriableError: Connection stalled repeatedly", after minutes). Retrying it again seldom helps.
const connectionStalled = /connection stalled/i;
const usageLimit = /rate.?limit|quota|usage.?limit|out of credits|resource.?exhausted/i;
const modelUnavailable =
  /model.{0,80}(invalid|unavailable|not found|not available|unknown)|cannot use this model|unknown model/i;
// The flags of every answer.
const ANSWER_FLAGS = [
  '--print',
  '--trust',
  '--mode',
  '--sandbox',
  '--workspace',
  '--output-format',
  '--model'
];
/**
 * What this adapter expects of the Cursor Agent CLI (the format is described in common.mjs). No real Cursor
 * output has been captured yet (see tests/fixtures/cli/README.md), so only scripts/check-cli-contract.mjs
 * checks it against the CLI itself.
 */
export const contract = {
  versionArgs: ['--version'],
  helpChecks: [
    // An answer streams (--output-format stream-json) when the help also lists STREAM_FLAG.
    { args: ['--help'], flags: [...ANSWER_FLAGS, '--stream-partial-output'], required: ANSWER_FLAGS },
    { args: ['status', '--help'], flags: ['--format'] }
  ],
  hiddenFlags: []
};
const OUTDATED = '当前 Cursor Agent CLI 缺少只读模式或所需参数。请更新后重试。';
/** The flag that makes stream-json output carry text deltas; a CLI whose help lacks it answers in json. */
const STREAM_FLAG = '--stream-partial-output';
/** Executable path → whether its help, as the last health check read it, lists STREAM_FLAG. */
const streaming = new Map();

function credentialFile(env, home) {
  if (process.platform === 'darwin') return path.join(home, '.cursor', 'auth.json');
  if (process.platform === 'win32')
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'cursor', 'auth.json');
}

// Cursor resolves some hooks and MCP servers via the home directory, separately
// from CURSOR_CONFIG_DIR. Expose only the CLI's own credential file to its private
// home so Cursor can read and refresh its login normally.
async function withCursorWorkspace(runtimeDir, webSearch, callback) {
  const root = await fs.mkdtemp(path.join(runtimeDir, 'cursor-'));
  try {
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const config = path.join(home, '.cursor');
    const env = {
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      CURSOR_CONFIG_DIR: config,
      CURSOR_DATA_DIR: config,
      NO_OPEN_BROWSER: '1',
      DIRENV_DISABLE: '1',
      // Trust the system certificates, unless NODE_OPTIONS already chose a CA store.
      ...systemCaEnv()
    };
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.mkdir(config, { recursive: true, mode: 0o700 });
    const source = credentialFile(process.env, os.homedir());
    const target = credentialFile(env, home);
    const hasLoginFile = await fs.stat(source).then(
      (stat) => stat.isFile(),
      () => false
    );
    if (hasLoginFile) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.symlink(source, target);
    }
    const deny = ['Shell(*)', 'Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', 'Mcp(*:*)'];
    if (!webSearch) deny.push('WebFetch(*)');
    await fs.writeFile(
      path.join(config, 'cli-config.json'),
      JSON.stringify({
        version: 1,
        editor: { vimMode: false },
        approvalMode: 'allowlist',
        permissions: { allow: webSearch ? ['WebFetch(*)'] : [], deny },
        autoAcceptWebSearch: webSearch,
        sandbox: { mode: 'enabled', readBoundary: 'workspace' }
      }),
      { mode: 0o600 }
    );
    return await callback({ cwd: workspace, env, hasLoginFile });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Model IDs from `agent models` output: one per line, optionally followed by " - Name" or "(current)". */
export function parseModelList(output) {
  const models = new Set();
  for (const line of stripAnsi(output).split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^([A-Za-z0-9][A-Za-z0-9._:/+[\],=-]*)(?:\s+-\s+.*|\s+\((?:current|default)[^)]*\))?$/);
    if (match) models.add(match[1]);
  }
  return [...models];
}

/** `agent status`: { result, loggedIn }, whether the CLI holds a login before the model service is asked. */
async function readStatus(bin, run, options) {
  const result = await run(bin, ['status', '--format', 'json'], options);
  let account;
  try {
    account = JSON.parse(result.stdout);
  } catch {}
  return {
    result,
    loggedIn: result.code === 0 && account?.isAuthenticated === true && account.hasAccessToken === true
  };
}

/**
 * Confirms a login `agent status` reported with the model service: `agent models` fails with an
 * authentication error when the login is stale, and otherwise lists the models. ok tells whether the
 * result can be reused (the login works and the model list was read).
 */
async function validateLogin(bin, run, options, loggedIn) {
  if (!loggedIn) {
    return {
      ok: false,
      authenticated: false,
      subscription: false,
      models: [],
      message: '请在终端运行 agent login 登录 Cursor，再重新检查。'
    };
  }
  const result = await run(bin, ['models'], options);
  if (result.code !== 0 && authenticationError.test(result.stderr + result.stdout)) {
    return {
      ok: false,
      authenticated: false,
      subscription: false,
      models: [],
      message: 'Cursor 登录已失效。请在终端运行 agent login 后重新检查。'
    };
  }
  return {
    ok: result.code === 0,
    authenticated: true,
    subscription: true,
    models: result.code === 0 ? parseModelList(result.stdout) : [],
    message: result.code === 0 ? '已识别 Cursor 账号登录' : '已识别 Cursor 登录，模型列表暂时无法获取。'
  };
}

// The version and help checks run once per executable and `agent status` before every discussion.
// `agent models`, which also proves the login works with the model service, runs again only when the
// status output changes or the last successful run is older than HEALTH_TTL.
async function inspect(ctx) {
  const { bin, run, runtimeDir, signal, info } = ctx;
  try {
    return await withCursorWorkspace(runtimeDir, false, async (workspace) => {
      const configuredStore = process.env.AGENT_CLI_CREDENTIAL_STORE;
      let store = configuredStore || credentialStores.get(bin);
      const useStore = (value) => {
        if (value) workspace.env.AGENT_CLI_CREDENTIAL_STORE = value;
        else delete workspace.env.AGENT_CLI_CREDENTIAL_STORE;
      };
      useStore(store);
      const options = { cwd: workspace.cwd, env: workspace.env, signal, timeout: 12000 };
      const cliOptions = { cwd: workspace.cwd, env: { ...workspace.env }, signal };
      const [cli, status] = await Promise.all([
        ctx.cli(() =>
          checkCli(run, bin, { id: 'cursor', contract, outdated: OUTDATED, options: cliOptions })
        ),
        readStatus(bin, run, options)
      ]);
      info.version = cli.version;
      if (!cli.ok) {
        streaming.delete(bin);
        info.message = cli.message;
        return info;
      }
      streaming.set(bin, listsFlag(cli.help, STREAM_FLAG));
      const statusKey = `${store || ''}\n${status.result.code}\n${status.result.stdout}`;
      const login = await ctx.remote(statusKey, async () => {
        let validated = await validateLogin(bin, run, options, status.loggedIn);
        if (
          !validated.authenticated &&
          !configuredStore &&
          workspace.hasLoginFile &&
          process.platform === 'darwin'
        ) {
          // macOS can have a stale Keychain login and a valid CLI file-store login, or vice versa.
          store = store === 'file' ? undefined : 'file';
          useStore(store);
          const retry = await readStatus(bin, run, options);
          validated = await validateLogin(bin, run, options, retry.loggedIn);
        }
        if (validated.subscription) credentialStores.set(bin, store);
        else credentialStores.delete(bin);
        return validated;
      });
      info.authenticated = login.authenticated;
      info.subscription = login.subscription;
      info.models = login.models;
      info.message = login.message;
      return info;
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    info.message = 'Cursor 连接检查失败。请检查网络和终端里的 agent status 后重试。';
    return info;
  }
}

// Cursor's own failure messages, checked in order before the shared ones. What the service answered comes
// before a lost connection, which is retried (see discussion.mjs): an expired login, a used-up quota or a
// refused model is not.
const CURSOR_FAILURES = [
  ['auth', authenticationError, 'Cursor 登录已失效。请运行 agent login 后重新检查。'],
  ['quota', usageLimit, 'Cursor 用量或速率已达上限。请检查账号用量后重试。'],
  ['model', modelUnavailable, 'Cursor 无法使用所选模型。请重新检查连接，并从模型列表选择。'],
  [
    'other',
    connectionStalled,
    'Cursor 与模型服务的数据流多次停滞，Cursor 自行重试后仍未恢复。可以重试未完成的部分，或换一个模型（例如推理档位较低的版本）再试。'
  ],
  ['network', connectionLost, 'Cursor 与模型服务的连接已中断。请检查网络后重试。']
];

/**
 * Classifies a failed Cursor call as { category, message } (see classifyFailure in diagnostics.mjs) from its
 * error output only: `stderr` and `errors`, the error text of a result the CLI marked as an error, never the
 * answer. Cursor's own patterns come first, then the shared ones, then the exit code.
 */
export function classifyCursorFailure({ code, stderr = '', errors = [] }) {
  const text = [stderr, ...errors.map(errorText)].join('\n');
  for (const [category, pattern, message] of CURSOR_FAILURES)
    if (pattern.test(text)) return { category, message };
  const shared = classifyFailure({ code, stderr, errors });
  if (shared.category !== 'other') return shared;
  return {
    category: 'other',
    message:
      code === 0
        ? 'Cursor 未返回有效的回答。'
        : `Cursor 调用失败（退出码 ${code ?? '未知'}）。请在终端检查 agent status、网络和模型权限。`
  };
}

/** Characters of a streamed message before a piece that starts with all of it counts as a repeat. */
const REPEAT_MIN = 16;

/** The text of a stream-json message: its text parts, joined. */
const messageText = (message) =>
  Array.isArray(message?.content)
    ? message.content
        .filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
    : '';

/**
 * Reads `agent --print --output-format stream-json --stream-partial-output` line by line (pass line() as
 * onLine). Each {"type":"assistant","message":{"content":[{"type":"text","text":…}]}} event carries the next
 * piece of text, which goes to callbacks.onText. Once the message so far has REPEAT_MIN characters, a piece
 * that starts with all of it adds only what is new: a CLI may send the complete message after its pieces.
 * Thinking events and web tool calls are reported as activities (see progressReporter); text after a tool
 * call starts a new paragraph. `result` is the last {"type":"result"} event, or null; `model` is the model
 * the {"type":"system"} event names, or ''.
 */
export function readCursorStream(callbacks) {
  const progress = progressReporter(callbacks);
  let result = null;
  let model = '';
  let message = ''; // the text since the last tool call
  return {
    get result() {
      return result;
    },
    get model() {
      return model;
    },
    line(raw) {
      const event = parseEvent(raw);
      if (!event) return;
      if (event.type === 'result') result = event;
      else if (event.type === 'system' && typeof event.model === 'string') model = event.model;
      else if (event.type === 'thinking') progress.activity('thinking');
      else if (event.type === 'tool_call') {
        // Only the call's kind (the key of its tool_call object) is read, never its arguments.
        if (event.subtype === 'started' && isObject(event.tool_call)) {
          if (Object.keys(event.tool_call).some((kind) => /web/i.test(kind))) progress.activity('searching');
        }
        message = '';
        progress.separate();
      } else if (event.type === 'assistant') {
        const text = messageText(event.message);
        if (message.length >= REPEAT_MIN && text.startsWith(message)) {
          progress.text(text.slice(message.length));
          message = text;
        } else {
          progress.text(text);
          message += text;
        }
      }
    }
  };
}

// Cursor has no separate system prompt: the instructions precede the question on stdin. Reasoning effort
// is part of a Cursor model ID, so ctx.reasoning is not used.
async function invoke({
  bin,
  run,
  workDir,
  signal,
  prompt,
  instructions,
  model,
  webSearch,
  timeout,
  onText,
  onActivity
}) {
  return withCursorWorkspace(workDir, webSearch, async ({ cwd, env }) => {
    const store = credentialStores.get(bin);
    if (store) env.AGENT_CLI_CREDENTIAL_STORE = store;
    const stream = streaming.get(bin) === true;
    // Only this empty, app-owned workspace receives trust. Tool permissions remain scoped.
    const args = ['--print', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', cwd];
    if (stream) args.push('--output-format', 'stream-json', STREAM_FLAG);
    else args.push('--output-format', 'json');
    if (model) args.push('--model', model);
    const options = { cwd, env, signal, timeout, input: instructions + prompt };
    let result;
    let event = null;
    let streamedModel = '';
    if (stream) {
      const reader = readCursorStream({ onText, onActivity });
      const streamed = { onLine: reader.line, keepStdout: false, outputLimit: STREAM_OUTPUT_LIMIT };
      result = await run(bin, args, { ...options, ...streamed });
      event = reader.result;
      streamedModel = reader.model;
    } else {
      result = await run(bin, args, options);
      try {
        event = JSON.parse(result.stdout);
      } catch {}
      if (!isObject(event)) event = null;
    }
    // The result is the model's answer unless the CLI marked it as an error; only then may it explain a failure.
    const failed = event?.is_error === true;
    if (result.code !== 0 || failed) {
      const errors = failed ? [event.result, event.error] : [];
      throw failureError(classifyCursorFailure({ code: result.code, stderr: result.stderr, errors }));
    }
    if (typeof event?.result !== 'string' || !event.result.trim())
      throw failureError({ category: 'other', message: 'Cursor 未返回有效的回答。' });
    const usage = readUsage(event.usage);
    return {
      text: event.result.trim(),
      model: typeof event.model === 'string' ? event.model : streamedModel || model || '',
      ...(usage && { usage })
    };
  });
}

export default {
  id: 'cursor',
  label: 'Cursor',
  binaries: ['cursor-agent', 'agent'],
  missingHint: 'Cursor Agent（cursor-agent 或 agent）',
  envDenylist: [
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
  ],
  apiKeyEnv: ['CURSOR_API_KEY'],
  supportsWeb: true,
  contract,
  inspect,
  invoke
};
