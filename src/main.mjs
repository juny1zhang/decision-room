// Startup: command-line flags, the local HTTP server and a clean shutdown.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { PUBLIC_DIR, ROOMS_DIR, VERSION } from './config.mjs';
import { createActiveRun } from './discussion.mjs';
import { AppError } from './errors.mjs';
import { createHealthChecker } from './health.mjs';
import { createRequestHandler } from './http.mjs';
import { createInvoker } from './invoke.mjs';
import { createRunner } from './process.mjs';
import { CHILD_ENV_DENYLIST } from './providers/index.mjs';
import { safeDetail } from './redact.mjs';
import { createRoomStore } from './storage.mjs';

const HELP =
  'Decision Room\n启动：node server.mjs\n仅检查工具与登录：node server.mjs --check\n' +
  '不自动打开浏览器：node server.mjs --no-open\n默认只监听 127.0.0.1，动态选择端口。';

/**
 * Runs Decision Room for the command line in `argv`: --help prints usage, --check prints the health of every
 * CLI as JSON, otherwise the server starts on a random 127.0.0.1 port (and opens the browser on macOS
 * unless --no-open is given).
 */
export async function main(argv = process.argv) {
  if (argv.includes('--help')) {
    console.log(HELP);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 18) throw new AppError('需要 Node.js 18 或更新版本。');
  await fs.mkdir(ROOMS_DIR, { recursive: true, mode: 0o700 });
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-'));
  const run = createRunner({ cwd: runtimeDir, denylist: CHILD_ENV_DENYLIST });
  const activeRun = createActiveRun();
  const health = createHealthChecker({ run, runtimeDir, isBusy: activeRun.isBusy });
  if (argv.includes('--check')) {
    try {
      console.log(JSON.stringify(await health.check(true), null, 2));
    } finally {
      await fs.rm(runtimeDir, { recursive: true, force: true });
    }
    return;
  }

  const token = randomBytes(32).toString('hex');
  const rooms = createRoomStore(ROOMS_DIR);
  let port = 0;
  const server = http.createServer(
    createRequestHandler({
      token,
      getPort: () => port,
      health,
      invoke: createInvoker({ run, runtimeDir, binary: health.binary }),
      rooms,
      activeRun,
      publicDir: PUBLIC_DIR
    })
  );
  server.requestTimeout = 0;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 40;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  const address = `http://127.0.0.1:${port}/#${token}`;
  console.log(
    `\nDecision Room v${VERSION}\n本地决策群已启动：\n${address}\n\n请保留这个终端窗口；退出按 Ctrl+C。\n讨论记录：${ROOMS_DIR}\n`
  );
  if (!argv.includes('--no-open') && process.platform === 'darwin') {
    const opener = spawn('open', [address], { stdio: 'ignore', shell: false });
    opener.on('error', () => {});
    opener.unref();
  }

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    activeRun.abort();
    server.close();
    const deadline = Date.now() + 5000;
    while (activeRun.isBusy() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await rooms.flush();
    await fs.rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
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
