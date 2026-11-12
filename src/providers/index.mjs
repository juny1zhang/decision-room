// The provider registry: every model CLI Decision Room can talk to.
//
// Each provider module default-exports an object with:
//   id            lowercase identifier, used in rooms, settings and the API. DECISION_ROOM_<ID>_BIN
//                 overrides where its CLI is found.
//   label         name shown to people and used in prompts and messages.
//   binaries      executable names searched on PATH and in common install folders, in order.
//   missingHint   how the CLI is named in the "找不到 …" message when none of the binaries is found.
//   envDenylist   environment variables removed before any CLI starts (API keys, endpoints, …).
//   apiKeyEnv     variables that would switch the CLI to API billing; health reports them as ignored.
//   supportsWeb   whether the CLI can search the web; health reports it whether or not the CLI is found.
//   inspect(ctx)  checks version, login and models. ctx: { bin, run, runtimeDir, signal, info, cli,
//                 remote }. `info` is the provider's health entry, already marked available; inspect fills
//                 it in or returns an entry of its own. If inspect throws, `info` is reported with the
//                 error message. `signal` belongs to the health checker, not to a discussion. Every check
//                 runs inspect, and a discussion checks its participants first, so inspect keeps the cost
//                 low with two memos, and runs independent commands at the same time:
//                   ctx.cli(check)          for version and help checks, which depend only on the
//                                           executable. Resolves to check()'s result, reused until the
//                                           executable changes (path, modification time, size, inode) as
//                                           long as it has ok: true.
//                   ctx.remote(key, check)  for model catalogues and other calls to the model service.
//                                           Resolves to check()'s result, reused for HEALTH_TTL after a
//                                           result with ok: true while `key` (e.g. the login status
//                                           output) is the same; "重新检查连接" runs it again.
//                 Concurrent callers share a check() that is still running. The login status itself is
//                 read on every inspect, so a discussion always sees the current login method.
//   invoke(ctx)   answers one prompt. ctx: { bin, run, workDir, signal, prompt, instructions, model,
//                 reasoning, webSearch, timeout }. Resolves to { text, model }; the caller trims the text
//                 and rejects empty or overlong answers.
// `run` is runProcess bound to the server's runtime folder and scrubbed environment (see process.mjs).
import codex from './codex.mjs';
import claude from './claude.mjs';
import cursor from './cursor.mjs';

/** Providers in display order. The first two form the default discussion. */
export const PROVIDERS = Object.freeze([codex, claude, cursor]);
export const PROVIDER_IDS = Object.freeze(PROVIDERS.map((provider) => provider.id));

const byId = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

export function isProviderId(value) {
  return byId.has(value);
}

export function getProvider(id) {
  return byId.get(id);
}

/** The provider's display name, or undefined for an unknown id. */
export function providerLabel(id) {
  return byId.get(id)?.label;
}

/** Every variable any provider wants removed; all CLIs start without all of them. */
export const CHILD_ENV_DENYLIST = Object.freeze([
  ...new Set(PROVIDERS.flatMap((provider) => provider.envDenylist))
]);
