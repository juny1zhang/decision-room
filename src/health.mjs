// Health checks: which CLIs are installed, logged in with a subscription, and which models they offer.
//
// What a check costs. Each provider's inspect() (see providers/index.mjs) runs three kinds of commands:
//   - version and help checks depend only on the executable, so ctx.cli() keeps a successful result per
//     executable identity (real path, modification time, size, inode);
//   - the login status is read by every inspect, so a discussion always sees the current login method;
//   - model catalogues and other calls to the model service: ctx.remote() keeps a successful result for
//     HEALTH_TTL while the login status reads the same.
// A warm check therefore starts one process per provider. Concurrent callers share a check in progress.
// Checks run with the checker's own signal, so a stopped discussion never cuts short a check another
// caller waits for; close() stops them all.
import { setMaxListeners } from 'node:events';
import { CAPABILITIES } from './capabilities.mjs';
import { HEALTH_TTL, VERSION } from './config.mjs';
import { AppError } from './errors.mjs';
import { executableIdentity, findExecutable } from './process.mjs';
import { PROVIDERS } from './providers/index.mjs';
import { safeDetail } from './redact.mjs';

/**
 * How fresh check() results must be:
 *   cached  results younger than HEALTH_TTL are reused (the page's status polls);
 *   login   every login status is read again; other results are reused as described above (the check a
 *           discussion runs on its participants before it starts);
 *   full    as login, and catalogues and other remote checks run again ("重新检查连接", --check, startup).
 */
const LEVELS = { cached: 0, login: 1, full: 2 };

/** A provider's health entry before its CLI has been inspected. */
export function baseHealth(provider) {
  return {
    available: false,
    version: '',
    authenticated: false,
    subscription: false,
    message: '',
    models: [],
    reasoningLevels: [],
    reasoningByModel: {},
    supportsWeb: provider.supportsWeb
  };
}

/** Resolves like `promise`, or rejects with "讨论已停止。" as soon as `signal` aborts. */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const stopped = () => reject(new AppError('讨论已停止。'));
    signal.addEventListener('abort', stopped, { once: true });
    if (signal.aborted) stopped();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopped));
  });
}

/**
 * Health checks for `providers`. check(level, signal, selected) resolves to one entry per provider id (all
 * providers, or the `selected` ids) plus `providers` ([{ id, label }] in registry order), the
 * capabilities, the version, `apiEnvironmentNames` (API-key variables that are set and ignored) and
 * `busy`. `level` is one of LEVELS ('cached' by default); for older callers true means 'full', or 'login'
 * with `selected`. `signal` only stops the caller's wait. binary(id) is the CLI path found by the last
 * check of that provider; close() stops every check in progress. `debug(line)`, when given, receives a
 * summary of every provider check.
 */
export function createHealthChecker({
  run,
  runtimeDir,
  isBusy = () => false,
  providers = PROVIDERS,
  env = process.env,
  debug,
  now = Date.now
}) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const apiKeyEnv = [...new Set(providers.flatMap((provider) => provider.apiKeyEnv))];
  const lifetime = new AbortController();
  // Every CLI process of a check listens to this signal; a cold check of all providers starts a dozen.
  setMaxListeners(100, lifetime.signal);
  const latest = new Map(); // id → { info, startedAt } of the latest-started finished check
  const running = new Map(); // id → { promise, startedAt, level } of the latest-started check in progress
  const cliResults = new Map(); // id → { key, promise } for ctx.cli()
  const remoteResults = new Map(); // id → { key, promise, settledAt, ok } for ctx.remote()
  const binaries = new Map();

  // ctx.cli(): one result per executable identity, kept while it has ok: true.
  function cliCheck(id, identity, check, steps) {
    const known = cliResults.get(id);
    if (identity && known?.key === identity) {
      steps.cli = 'reused';
      return known.promise;
    }
    steps.cli = 'ran';
    const promise = Promise.resolve().then(check);
    if (!identity) return promise;
    const entry = { key: identity, promise };
    cliResults.set(id, entry);
    const forget = () => {
      if (cliResults.get(id) === entry) cliResults.delete(id);
    };
    promise.then((result) => result?.ok !== true && forget(), forget);
    return promise;
  }

  // ctx.remote(): a running check is shared; a finished one is kept for HEALTH_TTL while it has ok: true,
  // unless this is a full check.
  function remoteCheck(id, key, check, rerun, steps) {
    const known = remoteResults.get(id);
    if (key && known?.key === key) {
      const fresh = known.ok && now() - known.settledAt < HEALTH_TTL;
      if (known.settledAt === undefined || (fresh && !rerun)) {
        steps.remote = 'reused';
        return known.promise;
      }
    }
    steps.remote = 'ran';
    const promise = Promise.resolve().then(check);
    if (!key) return promise;
    const entry = { key, promise, settledAt: undefined, ok: false };
    remoteResults.set(id, entry);
    promise.then(
      (result) => {
        entry.ok = result?.ok === true;
        entry.settledAt = now();
      },
      () => {
        entry.settledAt = now();
      }
    );
    return promise;
  }

  async function inspect(provider, level) {
    const startedAt = now();
    const info = baseHealth(provider);
    const steps = { cli: '-', remote: '-' };
    let entry = info;
    const bin = await findExecutable(provider, env);
    if (!bin) {
      binaries.delete(provider.id);
      info.message = `找不到 ${provider.missingHint}。请检查 CLI 安装位置。`;
    } else {
      binaries.set(provider.id, bin);
      info.available = true;
      const identity = await executableIdentity(bin);
      try {
        entry =
          (await provider.inspect({
            bin,
            run,
            runtimeDir,
            signal: lifetime.signal,
            info,
            cli: (check) => cliCheck(provider.id, identity, check, steps),
            remote: (key, check) =>
              remoteCheck(provider.id, identity && `${identity}\n${key}`, check, level === 'full', steps)
          })) || info;
      } catch (error) {
        info.message = safeDetail(error.message);
        entry = info;
      }
    }
    entry.supportsWeb = provider.supportsWeb;
    entry.checkedAt = now();
    if (debug) {
      const state = !entry.available ? 'missing' : entry.subscription ? 'ready' : 'not-ready';
      debug(
        `health ${provider.id} ${state} level=${level} cli=${steps.cli} remote=${steps.remote}` +
          ` models=${entry.models?.length || 0} ${entry.checkedAt - startedAt} ms` +
          ` version=${JSON.stringify(entry.version || '')} message=${JSON.stringify(safeDetail(entry.message))}`
      );
    }
    return entry;
  }

  function start(id, level) {
    const startedAt = now();
    const promise = inspect(byId.get(id), level).then((info) => {
      const previous = latest.get(id);
      if (!previous || previous.startedAt <= startedAt) latest.set(id, { info, startedAt });
      return info;
    });
    const job = { promise, startedAt, level };
    running.set(id, job);
    promise
      .finally(() => {
        if (running.get(id) === job) running.delete(id);
      })
      .catch(() => {});
    return promise;
  }

  function providerHealth(id, level, requestedAt) {
    const known = latest.get(id);
    if (level === 'cached' && known && now() - known.info.checkedAt < HEALTH_TTL) return known.info;
    const job = running.get(id);
    // A check that started before this request may have read the login status too early for it.
    if (job && (level === 'cached' || (job.startedAt >= requestedAt && LEVELS[job.level] >= LEVELS[level])))
      return job.promise;
    return start(id, level);
  }

  async function check(level = 'cached', signal, selected) {
    if (typeof level !== 'string') level = level ? (selected ? 'login' : 'full') : 'cached';
    if (!Object.hasOwn(LEVELS, level)) throw new TypeError(`Unknown health check level: ${level}`);
    const requestedAt = now();
    const ids = selected || providers.map((provider) => provider.id);
    const entries = await untilAborted(
      Promise.all(ids.map(async (id) => [id, await providerHealth(id, level, requestedAt)])),
      signal
    );
    const apiEnvironmentNames = apiKeyEnv.filter((key) => Boolean(env[key]));
    return {
      ...Object.fromEntries(entries),
      providers: providers.map(({ id, label }) => ({ id, label })),
      capabilities: CAPABILITIES,
      version: VERSION,
      checkedAt: now(),
      apiEnvironmentIgnored: apiEnvironmentNames.length > 0,
      apiEnvironmentNames,
      busy: isBusy()
    };
  }

  return {
    check,
    binary: (id) => binaries.get(id),
    close: () => lifetime.abort()
  };
}
