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
//   supportsWeb   web search support reported when the CLI is missing (inspect may report its own).
//   inspect(ctx)  checks version, login and models. ctx: { bin, run, runtimeDir, signal, cachedCatalog,
//                 info }. `info` is the provider's health entry, already marked available; inspect fills
//                 it in or returns an entry of its own. If inspect throws, `info` is reported with the
//                 error message.
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
