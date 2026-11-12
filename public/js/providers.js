// The providers the page shows, and how a connection pill describes one. Nothing here touches the DOM, so
// the unit tests import this module directly.
//
// The list comes from the server's registry: /api/health answers with providers: [{ id, label }] in
// registry order. Until that first answer the page shows the three providers Decision Room ships with, so
// the first paint looks as it always has. Colours and avatar glyphs live in app.css, keyed by the
// data-provider attribute; a provider without rules there gets neutral colours and the first character
// of its label as its avatar. A provider added to the server's registry needs one change here: an entry in
// DEFAULT_PROVIDERS, which a unit test keeps equal to the registry.

/** The providers Decision Room ships with, shown until the server lists its registry. */
export const DEFAULT_PROVIDERS = Object.freeze([
  Object.freeze({ id: 'codex', label: 'Codex' }),
  Object.freeze({ id: 'claude', label: 'Claude' }),
  Object.freeze({ id: 'cursor', label: 'Cursor' })
]);

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * Whether `value` is shaped like a provider id (a short lowercase identifier). It says nothing about the
 * registry: rooms keep the ids of providers a later registry may no longer list.
 */
export const isProviderId = (value) => typeof value === 'string' && PROVIDER_ID.test(value);

/**
 * The provider list of a health response: entries with a well-formed id, the first of each id, in the
 * server's order. An entry without a usable label is named by its id. Returns null when no entry is usable,
 * so the caller keeps the list it has.
 */
export function readProviders(list) {
  if (!Array.isArray(list)) return null;
  const providers = [];
  const seen = new Set();
  for (const entry of list) {
    if (!isProviderId(entry?.id) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    providers.push({ id: entry.id, label: label || entry.id });
  }
  return providers.length ? providers : null;
}

/** The avatar of a provider without a glyph of its own in app.css: the first character of its label. */
export function initialOf(label) {
  const [first = '?'] = String(label ?? '').trim();
  return first;
}

/**
 * How a connection pill shows one provider. `status` is the pill's class: checking, ready, warning (the tool
 * is installed but not ready: not logged in, or no subscription) or offline (the tool is missing, or the
 * local server did not answer). `text` says the same in words, for the pill's accessible name.
 * `health` is the last /api/health answer, null when there is none.
 */
export function connectionStatus(health, id, checking = false) {
  if (checking) return { status: 'checking', text: '正在检查' };
  if (!health) return { status: 'offline', text: '未连接' };
  const agent = health[id];
  if (agent?.available && agent.authenticated && agent.subscription)
    return { status: 'ready', text: '已就绪' };
  if (agent?.available) return { status: 'warning', text: '未就绪' };
  return { status: 'offline', text: '未找到工具' };
}

/** The accessible name of a connection pill, e.g. "Codex：已就绪，查看连接状态". */
export const connectionName = (label, text) => `${label}：${text}，查看连接状态`;
