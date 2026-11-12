// Shared UI state, the providers and stage names, and the predicates and configuration snapshots derived
// from them. Every other module reads and writes this one object.
import { token } from './api.js';
import { $ } from './dom.js';
import { DEFAULT_PROVIDERS, isProviderId, readProviders } from './providers.js';

/**
 * Provider ids in registry order. Until the first health response this is the default list (see
 * providers.js); setProviders() then replaces it, and every importer sees the new list.
 */
export let providers = DEFAULT_PROVIDERS.map((provider) => provider.id);
/** The label of every provider id seen so far, also of one a newer registry no longer lists. */
const labels = new Map(DEFAULT_PROVIDERS.map(({ id, label }) => [id, label]));
/** Whether `providers` is the server's registry rather than the default list. */
let registryKnown = false;

/** A provider's label. An id without one (not in the registry, or not known yet) is shown as it is. */
export const providerName = (id) => labels.get(id) ?? String(id);

export const stageNames = {
  notice: '提示',
  analysis: '独立分析',
  review: '交叉审查',
  summary: '讨论总结',
  error: '提示',
  question: '问题'
};

export const state = {
  roomId: null,
  room: null,
  messages: [],
  seen: new Set(),
  health: null,
  checking: false,
  busy: false,
  serverBusy: false,
  stopping: false,
  mode: 'debate',
  participants: providers.slice(0, 2),
  moderator: providers[0],
  settings: {},
  selectionRestored: false,
  context: '',
  statuses: new Map(),
  streamController: null,
  runStartedAt: null
};

/** "Single" mode is stored as the id of the one provider being asked. */
export const isSingle = () => state.mode !== 'debate' && state.mode !== 'both';
export const ready = (id) =>
  Boolean(state.health?.[id]?.subscription && state.health[id].authenticated && state.health[id].available);
export const supportsWeb = (members) =>
  Boolean(state.health && members.length && members.every((id) => state.health[id]?.supportsWeb));
export const canUseMode = () =>
  Boolean(
    token &&
    state.health &&
    state.participants.every(ready) &&
    state.participants.length >= (isSingle() ? 1 : 2)
  );
export const activeCapabilities = () =>
  state.health?.capabilities || [{ id: 'general', label: '通用分析', description: '' }];

// The web-search checkbox is the source of truth for the webSearch flag: configuration() reads it and
// restoreConfiguration() sets it.

/** Snapshot of the current selection, as sent to /api/run and saved with the draft. */
export function configuration() {
  const settings = {};
  for (const id of state.participants) {
    const { model = '', reasoning = '', capability = 'general' } = state.settings[id] || {};
    settings[id] = { model, reasoning, capability };
  }
  return {
    mode: state.mode,
    participants: [...state.participants],
    moderator: state.moderator,
    settings,
    // Until the first health check answers, keep the saved choice instead of saving "off".
    webSearch: $('webSearch').checked && (!state.health || supportsWeb(state.participants))
  };
}

/**
 * Whether a saved selection may name `id`. Before the registry is known any well-formed id may, so that a
 * selection of a provider outside the default list survives until the registry confirms or drops it.
 */
const selectable = (id) => (registryKnown ? providers.includes(id) : isProviderId(id));

/** Restores a selection saved in a draft or a room; ignores anything malformed. */
export function restoreConfiguration(config) {
  if (!config || typeof config.mode !== 'string') return;
  const single = config.mode !== 'debate' && config.mode !== 'both';
  if (single && !selectable(config.mode)) return;
  const listed = Array.isArray(config.participants)
    ? [...new Set(config.participants.filter(selectable))]
    : providers.slice(0, 2);
  // Registry order first; ids the default list does not know keep their saved order after it.
  const members = single
    ? [config.mode]
    : [...providers.filter((id) => listed.includes(id)), ...listed.filter((id) => !providers.includes(id))];
  if (!single && members.length < 2) return;
  state.mode = config.mode;
  state.participants = members;
  state.moderator = members.includes(config.moderator) ? config.moderator : members[0];
  const saved = config.settings && typeof config.settings === 'object' ? config.settings : {};
  state.settings = {};
  for (const id of new Set([...providers, ...members])) {
    const settings = (Object.hasOwn(saved, id) && saved[id]) || {};
    state.settings[id] = {
      model: typeof settings.model === 'string' ? settings.model : '',
      reasoning: typeof settings.reasoning === 'string' ? settings.reasoning : '',
      capability: typeof settings.capability === 'string' ? settings.capability : 'general'
    };
  }
  $('webSearch').checked = Boolean(config.webSearch);
  state.selectionRestored = true;
}

/**
 * Takes the provider registry of a health response ([{ id, label }]). Participants it does not list leave
 * the selection; when too few remain, the selection starts over as on a first visit. Returns whether an id,
 * their order or a label changed, i.e. whether names already on the page need refreshing.
 */
export function setProviders(list) {
  const next = readProviders(list);
  if (!next) return false;
  const changed =
    next.length !== providers.length ||
    next.some(({ id, label }, index) => id !== providers[index] || label !== labels.get(id));
  providers = next.map(({ id }) => id);
  for (const { id, label } of next) labels.set(id, label);
  registryKnown = true;
  const members = providers.filter((id) => state.participants.includes(id));
  if (members.length === state.participants.length) state.participants = members;
  else if (members.length >= (isSingle() ? 1 : 2)) {
    state.participants = members;
    if (!members.includes(state.moderator)) state.moderator = members[0];
  } else {
    state.participants = providers.slice(0, 2);
    state.moderator = providers[0];
    state.mode = state.participants.length > 1 ? 'debate' : providers[0];
    state.selectionRestored = false;
  }
  return changed;
}

/** Until the user picks participants, default to the first two (or the only) connected tools. */
export function defaultParticipants() {
  if (state.selectionRestored) return;
  const connected = providers.filter(ready);
  if (!connected.length) return;
  state.participants = connected.slice(0, 2);
  state.moderator = state.participants[0];
  state.mode = connected.length === 1 ? connected[0] : 'debate';
}
