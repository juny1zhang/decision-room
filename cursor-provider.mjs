import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const credentialStores = new Map();
const authenticationError = /authentication (?:required|failed)|invalid or expired|unauthenticated|not logged in|\b401\b/i;

function credentialFile(env, home) {
  if (process.platform === 'darwin') return path.join(home, '.cursor', 'auth.json');
  if (process.platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'auth.json');
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
      HOME: home, USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
      CURSOR_CONFIG_DIR: config, CURSOR_DATA_DIR: config, NO_OPEN_BROWSER: '1', DIRENV_DISABLE: '1',
      NODE_USE_SYSTEM_CA: '1',
    };
    await fs.mkdir(workspace, { mode: 0o700 });
    await fs.mkdir(config, { recursive: true, mode: 0o700 });
    const source = credentialFile(process.env, os.homedir());
    const target = credentialFile(env, home);
    const hasLoginFile = await fs.stat(source).then(stat => stat.isFile(), () => false);
    if (hasLoginFile) {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.symlink(source, target);
    }
    const deny = ['Shell(*)', 'Read(**)', 'Read(/**)', 'Write(**)', 'Write(/**)', 'Mcp(*:*)'];
    if (!webSearch) deny.push('WebFetch(*)');
    await fs.writeFile(path.join(config, 'cli-config.json'), JSON.stringify({
      version: 1, editor: { vimMode: false }, approvalMode: 'allowlist',
      permissions: { allow: webSearch ? ['WebFetch(*)'] : [], deny },
      autoAcceptWebSearch: webSearch,
      sandbox: { mode: 'enabled', readBoundary: 'workspace' },
    }), { mode: 0o600 });
    return await callback({ cwd: workspace, env, hasLoginFile });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function modelList(output) {
  const models = new Set();
  for (const line of output.replace(/\x1b\[[\d;]*m/g, '').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._:/+[\],=-]*)(?:\s+-\s+.*|\s+\((?:current|default)[^)]*\))?$/);
    if (match) models.add(match[1]);
  }
  return [...models];
}

async function inspectLogin(bin, runProcess, { cwd, env }, signal) {
  const options = { cwd, env, signal, timeout: 12000 };
  const status = await runProcess(bin, ['status', '--format', 'json'], options);
  let account;
  try { account = JSON.parse(status.stdout); } catch {}
  if (status.code !== 0 || !account?.isAuthenticated || account.hasAccessToken === false) {
    return { authenticated: false, subscription: false, models: [], message: '请在终端运行 agent login 登录 Cursor，再重新检查。' };
  }

  const result = await runProcess(bin, ['models'], options);
  if (result.code !== 0 && authenticationError.test(result.stderr + result.stdout)) {
    return { authenticated: false, subscription: false, models: [], message: 'Cursor 登录已失效。请在终端运行 agent login 后重新检查。' };
  }
  return {
    authenticated: true, subscription: true, models: result.code === 0 ? modelList(result.stdout) : [],
    message: result.code === 0 ? '已识别 Cursor 账号登录' : '已识别 Cursor 登录，模型列表暂时无法获取。',
  };
}

export async function inspectCursor({ bin, runProcess, runtimeDir, signal }) {
  const info = { available: Boolean(bin), version: '', authenticated: false, subscription: false,
    models: [], reasoningLevels: [], supportsWeb: true, message: '' };
  if (!bin) return { ...info, message: '找不到 Cursor Agent CLI。请安装 agent 或 cursor-agent。' };
  try {
    return await withCursorWorkspace(runtimeDir, false, async workspace => {
      const options = { cwd: workspace.cwd, env: workspace.env, signal };
      const [version, help] = await Promise.all([
        runProcess(bin, ['--version'], options), runProcess(bin, ['--help'], options),
      ]);
      info.version = version.stdout.trim().split('\n')[0].slice(0, 100);
      const flags = ['--mode', '--sandbox', '--workspace', '--model', '--output-format'];
      if (version.code !== 0 || help.code !== 0 || flags.some(flag => !help.stdout.includes(flag))) {
        return { ...info, message: '当前 Cursor Agent CLI 缺少只读模式或所需参数。请更新后重试。' };
      }
      const configuredStore = process.env.AGENT_CLI_CREDENTIAL_STORE;
      let store = configuredStore || credentialStores.get(bin);
      if (store) workspace.env.AGENT_CLI_CREDENTIAL_STORE = store;
      let login = await inspectLogin(bin, runProcess, workspace, signal);
      if (!login.authenticated && !configuredStore && workspace.hasLoginFile && process.platform === 'darwin') {
        // macOS can have a stale Keychain login and a valid CLI file-store login, or vice versa.
        store = store === 'file' ? undefined : 'file';
        if (store) workspace.env.AGENT_CLI_CREDENTIAL_STORE = store;
        else delete workspace.env.AGENT_CLI_CREDENTIAL_STORE;
        login = await inspectLogin(bin, runProcess, workspace, signal);
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

export async function invokeCursor({ bin, runProcess, runtimeDir, signal, prompt, model, webSearch, timeout }) {
  return withCursorWorkspace(runtimeDir, webSearch, async ({ cwd, env }) => {
    const store = credentialStores.get(bin);
    if (store) env.AGENT_CLI_CREDENTIAL_STORE = store;
    // Only this empty, app-owned workspace receives trust. Tool permissions remain scoped.
    const args = ['--print', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', cwd, '--output-format', 'json'];
    if (model) args.push('--model', model);
    const result = await runProcess(bin, args, { cwd, env, signal, timeout, input: prompt });
    if (result.code !== 0) {
      const failure = result.stderr + '\n' + result.stdout;
      if (/connection lost|writableiterable is closed|econnreset|unavailable:|connecterror|fetch failed/i.test(failure)) throw new Error('Cursor 与模型服务的连接已中断。请检查网络后重试。');
      if (authenticationError.test(failure)) throw new Error('Cursor 登录已失效。请运行 agent login 后重新检查。');
      if (/rate.?limit|quota|usage.?limit|out of credits|resource.?exhausted/i.test(failure)) throw new Error('Cursor 用量或速率已达上限。请检查账号用量后重试。');
      if (/model.{0,80}(invalid|unavailable|not found|not available|unknown)|cannot use this model|unknown model/i.test(failure)) throw new Error('Cursor 无法使用所选模型。请重新检查连接，并从模型列表选择。');
      throw new Error(`Cursor 调用失败（退出码 ${result.code}）。请在终端检查 agent status、网络和模型权限。`);
    }
    let event;
    try { event = JSON.parse(result.stdout); } catch {}
    if (event?.is_error || typeof event?.result !== 'string' || !event.result.trim()) {
      throw new Error('Cursor 未返回有效的回答。');
    }
    return { text: event.result.trim(), model: typeof event.model === 'string' ? event.model : model || '' };
  });
}
