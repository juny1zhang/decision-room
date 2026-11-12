// Cursor Agent adapter: login and model checks, and one read-only `--print` turn per answer, each in a
// private home folder that only exposes the CLI's own credential file.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyFailure, errorText, failureError } from '../diagnostics.mjs';
import { stripAnsi } from '../redact.mjs';

const credentialStores = new Map();
const authenticationError =
  /authentication (?:required|failed)|invalid or expired|unauthenticated|not logged in|\b401\b/i;
const connectionLost =
  /connection lost|writableiterable is closed|econnreset|unavailable:|connecterror|fetch failed/i;
const usageLimit = /rate.?limit|quota|usage.?limit|out of credits|resource.?exhausted/i;
const modelUnavailable =
  /model.{0,80}(invalid|unavailable|not found|not available|unknown)|cannot use this model|unknown model/i;
// `agent --help` must list these flags, which every call relies on.
const REQUIRED_FLAGS = [
  '--print',
  '--trust',
  '--mode',
  '--sandbox',
  '--workspace',
  '--model',
  '--output-format'
];

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
      NODE_USE_SYSTEM_CA: '1'
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

async function inspectLogin(bin, run, { cwd, env }, signal) {
  const options = { cwd, env, signal, timeout: 12000 };
  const status = await run(bin, ['status', '--format', 'json'], options);
  let account;
  try {
    account = JSON.parse(status.stdout);
  } catch {}
  if (status.code !== 0 || account?.isAuthenticated !== true || account.hasAccessToken !== true) {
    return {
      authenticated: false,
      subscription: false,
      models: [],
      message: '请在终端运行 agent login 登录 Cursor，再重新检查。'
    };
  }

  const result = await run(bin, ['models'], options);
  if (result.code !== 0 && authenticationError.test(result.stderr + result.stdout)) {
    return {
      authenticated: false,
      subscription: false,
      models: [],
      message: 'Cursor 登录已失效。请在终端运行 agent login 后重新检查。'
    };
  }
  return {
    authenticated: true,
    subscription: true,
    models: result.code === 0 ? parseModelList(result.stdout) : [],
    message: result.code === 0 ? '已识别 Cursor 账号登录' : '已识别 Cursor 登录，模型列表暂时无法获取。'
  };
}

// Cursor reads its model list on every check: ctx.cachedCatalog is not used.
async function inspect({ bin, run, runtimeDir, signal }) {
  const info = {
    available: true,
    version: '',
    authenticated: false,
    subscription: false,
    models: [],
    reasoningLevels: [],
    supportsWeb: true,
    message: ''
  };
  try {
    return await withCursorWorkspace(runtimeDir, false, async (workspace) => {
      const options = { cwd: workspace.cwd, env: workspace.env, signal };
      const [version, help] = await Promise.all([
        run(bin, ['--version'], options),
        run(bin, ['--help'], options)
      ]);
      info.version = version.stdout.trim().split('\n')[0].slice(0, 100);
      if (
        version.code !== 0 ||
        help.code !== 0 ||
        REQUIRED_FLAGS.some((flag) => !help.stdout.includes(flag))
      ) {
        return { ...info, message: '当前 Cursor Agent CLI 缺少只读模式或所需参数。请更新后重试。' };
      }
      const configuredStore = process.env.AGENT_CLI_CREDENTIAL_STORE;
      let store = configuredStore || credentialStores.get(bin);
      if (store) workspace.env.AGENT_CLI_CREDENTIAL_STORE = store;
      let login = await inspectLogin(bin, run, workspace, signal);
      if (
        !login.authenticated &&
        !configuredStore &&
        workspace.hasLoginFile &&
        process.platform === 'darwin'
      ) {
        // macOS can have a stale Keychain login and a valid CLI file-store login, or vice versa.
        store = store === 'file' ? undefined : 'file';
        if (store) workspace.env.AGENT_CLI_CREDENTIAL_STORE = store;
        else delete workspace.env.AGENT_CLI_CREDENTIAL_STORE;
        login = await inspectLogin(bin, run, workspace, signal);
      }
      if (login.subscription) credentialStores.set(bin, store);
      else credentialStores.delete(bin);
      return { ...info, ...login };
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ...info, message: 'Cursor 连接检查失败。请检查网络和终端里的 agent status 后重试。' };
  }
}

// Cursor's own failure messages, checked in order before the shared ones.
const CURSOR_FAILURES = [
  ['network', connectionLost, 'Cursor 与模型服务的连接已中断。请检查网络后重试。'],
  ['auth', authenticationError, 'Cursor 登录已失效。请运行 agent login 后重新检查。'],
  ['quota', usageLimit, 'Cursor 用量或速率已达上限。请检查账号用量后重试。'],
  ['model', modelUnavailable, 'Cursor 无法使用所选模型。请重新检查连接，并从模型列表选择。']
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

// Cursor has no separate system prompt: the instructions precede the question on stdin. Reasoning effort
// is part of a Cursor model ID, so ctx.reasoning is not used.
async function invoke({ bin, run, workDir, signal, prompt, instructions, model, webSearch, timeout }) {
  return withCursorWorkspace(workDir, webSearch, async ({ cwd, env }) => {
    const store = credentialStores.get(bin);
    if (store) env.AGENT_CLI_CREDENTIAL_STORE = store;
    // Only this empty, app-owned workspace receives trust. Tool permissions remain scoped.
    const args = ['--print', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', cwd];
    args.push('--output-format', 'json');
    if (model) args.push('--model', model);
    const result = await run(bin, args, { cwd, env, signal, timeout, input: instructions + prompt });
    let event = null;
    try {
      event = JSON.parse(result.stdout);
    } catch {}
    if (!event || typeof event !== 'object') event = null;
    // The result is the model's answer unless the CLI marked it as an error; only then may it explain a failure.
    const failed = event?.is_error === true;
    if (result.code !== 0 || failed) {
      const errors = failed ? [event.result, event.error] : [];
      throw failureError(classifyCursorFailure({ code: result.code, stderr: result.stderr, errors }));
    }
    if (typeof event?.result !== 'string' || !event.result.trim())
      throw failureError({ category: 'other', message: 'Cursor 未返回有效的回答。' });
    return { text: event.result.trim(), model: typeof event.model === 'string' ? event.model : model || '' };
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
  // Reported while the CLI is missing; once it is found, inspect() reports supportsWeb: true.
  supportsWeb: false,
  inspect,
  invoke
};
