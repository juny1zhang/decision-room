// Starting model CLIs: environment scrubbing, executable lookup and a bounded child-process runner.
import { spawn } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHECK_TIMEOUT, OUTPUT_LIMIT, STDERR_LIMIT } from './config.mjs';
import { AppError } from './errors.mjs';
import { safeDetail } from './redact.mjs';

/** Characters of a CLI's stderr shown in one debug line. */
const DEBUG_STDERR_LIMIT = 4000;
/** Characters of one command-line argument shown in a debug line. */
const DEBUG_ARGUMENT_LIMIT = 160;

/**
 * The environment a CLI runs with: `source` without the `denylist` variables (API keys, alternative
 * endpoints, nested-session markers) and with colour output turned off.
 */
export function childEnv(denylist, source = process.env) {
  const env = { ...source };
  // Process-local only. Never edit the user's shell or credentials.
  for (const key of denylist) delete env[key];
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

const CA_STORE_FLAG = /(?:^|\s)--use-(?:openssl|bundled|system)-ca(?=\s|$)/;

/** Whether NODE_OPTIONS already selects Node's CA store (--use-openssl-ca, --use-bundled-ca, --use-system-ca). */
export function selectsCaStore(nodeOptions) {
  return CA_STORE_FLAG.test(nodeOptions || '');
}

/**
 * NODE_USE_SYSTEM_CA=1, which lets a Node-based CLI trust the operating system's certificates, unless the
 * NODE_OPTIONS of `env` already select a CA store: Node 24 and later refuse to start when both are given.
 */
export function systemCaEnv(env = process.env) {
  return selectsCaStore(env.NODE_OPTIONS) ? {} : { NODE_USE_SYSTEM_CA: '1' };
}

/**
 * Finds a provider's CLI: the path in DECISION_ROOM_<ID>_BIN when set, otherwise the first of its
 * `binaries` that is executable on PATH or in a common install folder. Resolves to null when none is.
 */
export async function findExecutable({ id, binaries }, env = process.env) {
  const override = env[`DECISION_ROOM_${id.toUpperCase()}_BIN`];
  const directories = [
    ...(env.PATH || '').split(path.delimiter).filter(Boolean),
    path.join(os.homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
  const candidates = override
    ? [path.resolve(override)]
    : binaries.flatMap((binary) => directories.map((dir) => path.join(dir, binary)));
  for (const candidate of new Set(candidates)) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

/**
 * A key that changes whenever the executable at `file` is replaced or updated: its real path (following
 * links such as a version manager's), modification time, size and inode. Resolves to null when the file
 * cannot be inspected.
 */
export async function executableIdentity(file) {
  try {
    const real = await fs.realpath(file);
    const stat = await fs.stat(real);
    return JSON.stringify([real, stat.mtimeMs, stat.size, stat.ino]);
  } catch {
    return null;
  }
}

/** "20 秒", "6.5 秒", "12 分钟": a timeout as people read it. */
export function formatDuration(ms) {
  const [value, unit] = ms < 60000 ? [ms / 1000, '秒'] : [ms / 60000, '分钟'];
  return `${Number.isInteger(value) ? value : Number(value.toFixed(1))} ${unit}`;
}

function shorten(argument) {
  const text = String(argument);
  return text.length > DEBUG_ARGUMENT_LIMIT ? text.slice(0, DEBUG_ARGUMENT_LIMIT - 1) + '…' : text;
}

/**
 * Runs a CLI without a shell, writes `input` to its stdin and collects its output.
 *
 * Resolves with { code, stdout, stderr } once the process exits. Rejects with an AppError when it cannot
 * start, `signal` aborts, `timeout` passes or it prints more than `outputLimit` bytes (stdout and stderr
 * together, OUTPUT_LIMIT by default); the whole process group is then terminated. `onLine` receives each
 * stdout line as it arrives; with `keepStdout: false` the lines are only passed to it and the result's
 * stdout is '', for a CLI that streams more than is worth keeping. `env` entries are added to the
 * environment produced by childEnv(denylist). With `debug`, one line per process reports `label`, the
 * executable, arguments, folder, exit code, duration and redacted stderr; never stdin or stdout.
 */
export function runProcess(
  executable,
  args,
  {
    input = '',
    cwd,
    timeout = CHECK_TIMEOUT,
    signal,
    onLine,
    keepStdout = true,
    outputLimit = OUTPUT_LIMIT,
    env,
    denylist = [],
    debug,
    label
  } = {}
) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('讨论已停止。'));
    const startedAt = Date.now();
    let child;
    let stdout = '';
    let stderr = '';
    let pending = ''; // stdout text after the last complete line, for onLine
    let total = 0; // stdout + stderr bytes
    let forcedError; // set when this side stops the process
    let settled = false;
    let hardKill;
    const killGroup = (sig) => {
      if (!child?.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {}
      }
    };
    const stop = (error) => {
      if (forcedError || settled) return;
      forcedError = error;
      killGroup('SIGTERM');
      hardKill = setTimeout(() => killGroup('SIGKILL'), 1500);
      hardKill.unref();
    };
    const abort = () => stop(new AppError('讨论已停止。'));
    const timer = setTimeout(
      () => stop(new AppError(`等待超过 ${formatDuration(timeout)}，已停止调用。请稍后重试。`)),
      timeout
    );
    const report = (code, failure) => {
      if (!debug) return;
      let line =
        `cli ${label || path.basename(executable)} ${executable} ${JSON.stringify(args.map(shorten))}` +
        ` cwd=${cwd ?? process.cwd()} exit=${code ?? '-'} ${Date.now() - startedAt} ms`;
      if (failure) line += ` error=${JSON.stringify(safeDetail(failure.message))}`;
      if (stderr.trim()) line += ` stderr=${JSON.stringify(safeDetail(stderr.trim(), DEBUG_STDERR_LIMIT))}`;
      debug(line);
    };
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      signal?.removeEventListener('abort', abort);
      // Also stop descendants left behind by a CLI wrapper.
      if (forcedError) killGroup('SIGKILL');
      report(code, forcedError || error);
      if (error || forcedError) reject(forcedError || error);
      else resolve({ code, stdout, stderr });
    };
    try {
      child = spawn(executable, args, {
        cwd,
        env: { ...childEnv(denylist), ...env },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      finish(e);
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > outputLimit) {
        stop(new AppError('工具返回内容过多，已停止本轮。请缩小问题范围。'));
        return;
      }
      if (keepStdout || !onLine) stdout += chunk;
      if (onLine) {
        pending += chunk;
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            onLine(line);
          } catch {}
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      total += Buffer.byteLength(chunk);
      if (total > outputLimit) stop(new AppError('工具返回内容过多，已停止本轮。'));
      if (stderr.length < STDERR_LIMIT) stderr += chunk;
    });
    child.on('error', (e) => finish(new AppError(`无法启动工具：${safeDetail(e.message)}`)));
    child.on('close', (code) => {
      if (pending && onLine) {
        try {
          onLine(pending);
        } catch {}
      }
      finish(null, code);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/**
 * A runProcess bound to the server's defaults: children start in `cwd` unless a call names another
 * folder, and always run with childEnv(denylist). With `debug`, every process is reported (see runProcess)
 * under the name `label(executable)` gives, such as the provider id.
 */
export function createRunner({ cwd, denylist, debug, label = () => undefined }) {
  return (executable, args, options = {}) =>
    runProcess(executable, args, {
      ...options,
      cwd: options.cwd ?? cwd,
      denylist,
      debug,
      label: debug ? label(executable) : undefined
    });
}
