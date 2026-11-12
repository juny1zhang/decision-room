// Startup: command-line flags, the data folder, the local HTTP server and a clean shutdown.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT, PUBLIC_DIR, ROOT, VERSION } from './config.mjs';
import { dataDirNote, resolveDataDir } from './data-dir.mjs';
import { createActiveRun } from './discussion.mjs';
import { AppError } from './errors.mjs';
import { createHealthChecker } from './health.mjs';
import { createRequestHandler } from './http.mjs';
import { createInvoker } from './invoke.mjs';
import { createPreferenceStore } from './preferences.mjs';
import { createRunner } from './process.mjs';
import { CHILD_ENV_DENYLIST, PROVIDERS } from './providers/index.mjs';
import { safeDetail } from './redact.mjs';
import { createRoomStore } from './storage.mjs';

const MINIMUM_NODE = 22;

const HELP = [
  'Decision Room',
  '启动：node server.mjs',
  '仅检查工具与登录：node server.mjs --check',
  '不自动打开浏览器：node server.mjs --no-open',
  '在终端输出调试信息：node server.mjs --debug（或设置 DECISION_ROOM_DEBUG=1）。' +
    '调试信息包括 CLI 命令、参数、退出码、耗时、错误输出和请求路径，不包括问题和回答。',
  `只监听 127.0.0.1，默认端口 ${DEFAULT_PORT}，被占用时改用随机端口；` +
    'DECISION_ROOM_PORT 指定端口（0 表示随机端口）。',
  '讨论记录默认保存在系统的应用数据目录；DECISION_ROOM_DATA_DIR 指定其他目录。'
].join('\n');

/** Whether --debug or DECISION_ROOM_DEBUG=1 asks for debug lines on stderr. */
export function debugEnabled(argv = process.argv, env = process.env) {
  return argv.includes('--debug') || /^(?:1|true|yes|on)$/i.test(env.DECISION_ROOM_DEBUG || '');
}

/** DECISION_ROOM_PORT as a number (0 = random), or null when it is not set. Throws an AppError when invalid. */
export function configuredPort(env = process.env) {
  const value = (env.DECISION_ROOM_PORT || '').trim();
  if (!value) return null;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65535)
    throw new AppError('DECISION_ROOM_PORT 必须是 0 到 65535 之间的整数（0 表示随机端口）。');
  return Number(value);
}

/** Resolves to the port `server` listens on at 127.0.0.1:`port`, or rejects with the listen error. */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    const failed = (error) => {
      server.off('listening', listening);
      reject(error);
    };
    const listening = () => {
      server.off('error', failed);
      resolve(server.address().port);
    };
    server.once('error', failed);
    server.once('listening', listening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Listens on `requested` (DECISION_ROOM_PORT), failing with a clear message when that port cannot be used,
 * or else on DEFAULT_PORT, falling back to a random port with a `notice` for the banner.
 */
async function listenOnPort(server, requested) {
  if (requested !== null) {
    try {
      return { port: await listen(server, requested) };
    } catch (error) {
      if (error.code === 'EADDRINUSE')
        throw new AppError(
          `端口 ${requested} 已被占用。请关闭占用它的程序，或用 DECISION_ROOM_PORT 指定其他端口（0 表示随机端口）。`
        );
      if (error.code === 'EACCES')
        throw new AppError(`没有权限使用端口 ${requested}。请用 DECISION_ROOM_PORT 指定 1024 以上的端口。`);
      throw new AppError(`无法监听端口 ${requested}：${safeDetail(error.message)}`);
    }
  }
  try {
    return { port: await listen(server, DEFAULT_PORT) };
  } catch (error) {
    const reason = error.code === 'EADDRINUSE' ? '已被占用' : '无法使用';
    return {
      port: await listen(server, 0),
      notice: `端口 ${DEFAULT_PORT} ${reason}，本次改用随机端口。浏览器里未发送的草稿按页面地址保存，换了端口不会显示。`
    };
  }
}

/** Opens `address` in the default browser on macOS and Linux; failures are ignored. */
function openBrowser(address, platform = process.platform) {
  const command = { darwin: 'open', linux: 'xdg-open' }[platform];
  if (!command) return;
  try {
    // Detached, so the browser neither holds this process open nor receives its Ctrl+C.
    const opener = spawn(command, [address], { stdio: 'ignore', shell: false, detached: true });
    opener.on('error', () => {});
    opener.unref();
  } catch {}
}

/**
 * Runs Decision Room for the command line in `argv`: --help prints usage, --check prints the health of every
 * CLI as JSON, otherwise the server starts on 127.0.0.1 (see listenOnPort) and opens the browser unless
 * --no-open is given. --debug (or DECISION_ROOM_DEBUG=1) prints "[debug] …" lines to stderr.
 */
export async function main(argv = process.argv) {
  if (argv.includes('--help')) {
    console.log(HELP);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < MINIMUM_NODE)
    throw new AppError(`需要 Node.js ${MINIMUM_NODE} 或更新版本。`);
  const debug = debugEnabled(argv) ? (line) => process.stderr.write(`[debug] ${line}\n`) : undefined;
  const checkOnly = argv.includes('--check');
  const requestedPort = checkOnly ? null : configuredPort();
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-'));
  const removeRuntime = () => fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
  let health;
  const run = createRunner({
    cwd: runtimeDir,
    denylist: CHILD_ENV_DENYLIST,
    debug,
    label: (bin) => PROVIDERS.find((provider) => health?.binary(provider.id) === bin)?.id
  });
  const activeRun = createActiveRun();
  health = createHealthChecker({ run, runtimeDir, isBusy: activeRun.isBusy, debug });
  if (checkOnly) {
    try {
      console.log(JSON.stringify(await health.check('full'), null, 2));
    } finally {
      health.close();
      await removeRuntime();
    }
    return;
  }

  let server, rooms, preferences, roomsDir, data;
  let port = 0;
  let notice;
  const token = randomBytes(32).toString('hex');
  try {
    data = await resolveDataDir({ root: ROOT });
    roomsDir = path.join(data.dir, 'rooms');
    await fs.mkdir(roomsDir, { recursive: true, mode: 0o700 });
    rooms = createRoomStore(roomsDir);
    preferences = createPreferenceStore(path.join(data.dir, 'preferences.json'));
    server = http.createServer(
      createRequestHandler({
        token,
        getPort: () => port,
        health,
        invoke: createInvoker({ run, runtimeDir, binary: health.binary }),
        rooms,
        preferences,
        activeRun,
        publicDir: PUBLIC_DIR,
        debug
      })
    );
    server.requestTimeout = 0;
    server.headersTimeout = 15000;
    server.maxHeadersCount = 40;
    ({ port, notice } = await listenOnPort(server, requestedPort));
  } catch (error) {
    health.close();
    await removeRuntime();
    throw error;
  }
  const address = `http://127.0.0.1:${port}/#${token}`;
  const banner = ['', `Decision Room v${VERSION}`, '本地决策群已启动：', address, ''];
  banner.push('请保留这个终端窗口；退出按 Ctrl+C。', `讨论记录：${roomsDir}`);
  if (notice) banner.push(notice);
  const note = dataDirNote(data);
  if (note) banner.push(note);
  console.log(banner.join('\n') + '\n');
  // Check every CLI in the background so the page's first status request finds the results ready.
  health.check('full').catch(() => {});
  if (!argv.includes('--no-open')) openBrowser(address);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    activeRun.abort();
    health.close();
    server.close();
    const deadline = Date.now() + 5000;
    while (activeRun.isBusy() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await rooms.flush();
    await preferences.flush();
    await removeRuntime();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** main() for the command line: an error is printed without credentials and sets exit code 1. */
export function start(argv = process.argv) {
  return main(argv).catch((e) => {
    console.error(safeDetail(e.message));
    process.exitCode = 1;
  });
}
