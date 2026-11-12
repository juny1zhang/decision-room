// Preferences that outlive the page's address: the last discussion configuration and the selected room,
// saved in <data dir>/preferences.json. The browser keeps its own copy per address (origin), which a new
// port or browser loses; the page falls back to these. Nothing here runs on import.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOM_ID_PATTERN } from './config.mjs';
import { AppError } from './errors.mjs';
import { MODE_NAMES } from './messages.mjs';
import { PROVIDER_IDS, isProviderId } from './providers/index.mjs';

/** Longest string kept for each per-provider setting. */
const SETTING_LIMITS = { model: 240, reasoning: 32, capability: 32 };

const invalid = () => new AppError('偏好设置无效。');
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Checks a configuration as the page saves it, leniently: `mode` must be a known mode; `participants`,
 * `moderator` and the keys of `settings` known provider ids; settings short strings; `webSearch` a boolean.
 * Missing fields are allowed (the page completes them), unknown ones are dropped. Returns the cleaned
 * copy, or throws an AppError (400).
 */
export function readPreferredConfiguration(value) {
  if (!isObject(value) || typeof value.mode !== 'string' || !Object.hasOwn(MODE_NAMES, value.mode))
    throw invalid();
  const configuration = { mode: value.mode };
  const { participants, moderator, settings, webSearch } = value;
  if (participants !== undefined) {
    if (
      !Array.isArray(participants) ||
      participants.length > PROVIDER_IDS.length ||
      !participants.every(isProviderId) ||
      new Set(participants).size !== participants.length
    )
      throw invalid();
    configuration.participants = [...participants];
  }
  if (moderator !== undefined) {
    if (moderator !== '' && !isProviderId(moderator)) throw invalid();
    configuration.moderator = moderator;
  }
  if (settings !== undefined) {
    if (!isObject(settings)) throw invalid();
    configuration.settings = {};
    for (const [id, options] of Object.entries(settings)) {
      if (!isProviderId(id) || !isObject(options)) throw invalid();
      const kept = {};
      for (const [field, limit] of Object.entries(SETTING_LIMITS)) {
        if (options[field] === undefined) continue;
        if (typeof options[field] !== 'string' || options[field].length > limit) throw invalid();
        kept[field] = options[field];
      }
      configuration.settings[id] = kept;
    }
  }
  if (webSearch !== undefined) {
    if (typeof webSearch !== 'boolean') throw invalid();
    configuration.webSearch = webSearch;
  }
  return configuration;
}

/**
 * The fields a PUT /api/preferences body changes: `configuration` (see readPreferredConfiguration) and
 * `selectedRoomId` (a room id), each optional and null to clear it. Throws an AppError (400).
 */
export function readPreferencePatch(body) {
  const patch = {};
  if (Object.hasOwn(body, 'configuration'))
    patch.configuration = body.configuration === null ? null : readPreferredConfiguration(body.configuration);
  if (Object.hasOwn(body, 'selectedRoomId')) {
    const id = body.selectedRoomId;
    if (id !== null && !(typeof id === 'string' && ROOM_ID_PATTERN.test(id))) throw invalid();
    patch.selectedRoomId = id;
  }
  return patch;
}

function savedConfiguration(value) {
  try {
    return readPreferredConfiguration(value);
  } catch {
    return null;
  }
}

/**
 * Preferences saved in `file`, whose folder must exist. read() resolves to { configuration,
 * selectedRoomId }, null for whatever is missing or no longer valid. update(patch) merges a
 * readPreferencePatch() result into the file, written atomically with mode 0600, one update at a time.
 * forgetRoom(id) clears selectedRoomId when it is `id` (that room was deleted), in turn with the updates.
 * flush() settles once every update has finished.
 */
export function createPreferenceStore(file) {
  let queue = Promise.resolve();

  async function read() {
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {}
    const room = saved?.selectedRoomId;
    return {
      configuration: savedConfiguration(saved?.configuration),
      selectedRoomId: typeof room === 'string' && ROOM_ID_PATTERN.test(room) ? room : null
    };
  }

  /** Writes the saved preferences merged with patchFor(saved), or nothing when that returns null. */
  function change(patchFor) {
    const next = queue
      .catch(() => {})
      .then(async () => {
        const saved = await read();
        const patch = patchFor(saved);
        if (!patch) return;
        const merged = { ...saved, ...patch };
        const temporary = path.join(path.dirname(file), `.preferences-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(temporary, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
          await fs.rename(temporary, file);
        } catch (error) {
          await fs.rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
      });
    queue = next;
    return next;
  }

  return {
    read,
    update: (patch) => change(() => patch),
    forgetRoom: (id) => change((saved) => (saved.selectedRoomId === id ? { selectedRoomId: null } : null)),
    flush: () => queue.catch(() => {})
  };
}
