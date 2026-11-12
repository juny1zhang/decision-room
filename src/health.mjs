// Health checks: which CLIs are installed, logged in with a subscription, and which models they offer.
import { CAPABILITIES } from './capabilities.mjs';
import { HEALTH_TTL, VERSION } from './config.mjs';
import { findExecutable } from './process.mjs';
import { PROVIDERS } from './providers/index.mjs';
import { safeDetail } from './redact.mjs';

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

/**
 * Health checks for `providers`, cached for HEALTH_TTL. check(force, signal, selected) resolves to one
 * entry per provider id (all providers, or the `selected` ids) plus the capabilities, version, whether
 * API-key variables are set (they are ignored) and `busy`. binary(id) is the CLI path found by the last
 * check of that provider.
 */
export function createHealthChecker({
  run,
  runtimeDir,
  isBusy = () => false,
  providers = PROVIDERS,
  env = process.env
}) {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const apiKeyEnv = [...new Set(providers.flatMap((provider) => provider.apiKeyEnv))];
  const cache = new Map();
  const binaries = new Map();

  async function inspect(provider, signal, cachedCatalog) {
    const info = baseHealth(provider);
    const bin = await findExecutable(provider, env);
    if (!bin) {
      info.message = `找不到 ${provider.missingHint}。请检查 CLI 安装位置。`;
      return info;
    }
    binaries.set(provider.id, bin);
    info.available = true;
    try {
      return await provider.inspect({ bin, run, runtimeDir, signal, cachedCatalog, info });
    } catch (error) {
      info.message = safeDetail(error.message);
    }
    return info;
  }

  async function check(force = false, signal, selected) {
    const ids = selected || providers.map((provider) => provider.id);
    const results = await Promise.all(
      ids.map(async (id) => {
        const cached = cache.get(id);
        if (!force && cached && Date.now() - cached.info.checkedAt < HEALTH_TTL) return [id, cached.info];
        // A discussion re-checks its participants; their model lists can be reused for a while.
        const reuseCatalog =
          selected && cached?.info.subscription && Date.now() - cached.catalogTime < HEALTH_TTL;
        const catalog = reuseCatalog
          ? {
              models: cached.info.models,
              reasoningLevels: cached.info.reasoningLevels,
              reasoningByModel: cached.info.reasoningByModel
            }
          : undefined;
        const info = { ...(await inspect(byId.get(id), signal, catalog)), checkedAt: Date.now() };
        if (!signal?.aborted)
          cache.set(id, { info, catalogTime: reuseCatalog ? cached.catalogTime : info.checkedAt });
        return [id, info];
      })
    );
    const apiEnvironmentIgnored = apiKeyEnv.some((key) => Boolean(env[key]));
    return {
      ...Object.fromEntries(results),
      capabilities: CAPABILITIES,
      version: VERSION,
      checkedAt: Date.now(),
      apiEnvironmentIgnored,
      busy: isBusy()
    };
  }

  return { check, binary: (id) => binaries.get(id) };
}
