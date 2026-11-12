// Shared UI state, the constants that describe providers and stages, and the predicates and
// configuration snapshots derived from them. Every other module reads and writes this one object.
import { token } from './api.js';
import { $ } from './dom.js';

export const providers = ['codex', 'claude', 'cursor'];

export const names = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  user: '你',
  summary: '主持人总结',
  system: '讨论提示'
};

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
  participants: ['codex', 'claude'],
  moderator: 'codex',
  settings: {},
  selectionRestored: false,
  context: '',
  statuses: new Map(),
  streamController: null,
  runStartedAt: null
};

/** "Single" mode is stored as the id of the one provider being asked. */
export const isSingle = () => providers.includes(state.mode);
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

// The web-search checkbox is the source of truth for the webSearch flag, so the two functions below
// read and write it directly.

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
    webSearch: $('webSearch').checked && supportsWeb(state.participants)
  };
}

/** Restores a selection saved in a draft or a room; ignores anything malformed. */
export function restoreConfiguration(config) {
  if (!config || !['debate', 'both', ...providers].includes(config.mode)) return;
  const members = providers.includes(config.mode)
    ? [config.mode]
    : Array.isArray(config.participants)
      ? providers.filter((id) => config.participants.includes(id))
      : ['codex', 'claude'];
  if (!providers.includes(config.mode) && members.length < 2) return;
  state.mode = config.mode;
  state.participants = members;
  state.moderator = members.includes(config.moderator) ? config.moderator : members[0];
  state.settings = {};
  for (const id of providers) {
    const settings = config.settings?.[id] || {};
    state.settings[id] = {
      model: typeof settings.model === 'string' ? settings.model : '',
      reasoning: typeof settings.reasoning === 'string' ? settings.reasoning : '',
      capability: typeof settings.capability === 'string' ? settings.capability : 'general'
    };
  }
  $('webSearch').checked = Boolean(config.webSearch);
  state.selectionRestored = true;
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
