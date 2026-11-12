// Rooms are saved as one JSON file each, written atomically. The saves, renames and removals of a room run
// one at a time, in the order they were asked for, and a load waits for the ones asked for before it.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOM_ID_PATTERN } from './config.mjs';
import { AppError } from './errors.mjs';
import { roomMessages } from './messages.mjs';

const ROOM_FILE = /^[a-f0-9-]{36}\.json$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const timeOf = (value) => (typeof value === 'string' ? Date.parse(value) : NaN);

/**
 * A room as read from the file of room `id`, safe for the code that uses it even when the file was edited
 * by hand: the id is the one in the file name, title and context are strings and messages is a list of
 * message objects. null when the file does not hold a room.
 */
function readRoom(data, id) {
  if (!isObject(data)) return null;
  return {
    ...data,
    id,
    title: typeof data.title === 'string' ? data.title : '',
    context: typeof data.context === 'string' ? data.context : '',
    messages: roomMessages(data)
  };
}

/**
 * A room's createdAt and updatedAt as ISO strings. A room without a valid updatedAt is dated by its
 * createdAt, else by `fileTime`, the modification time of its file.
 */
function roomDates(data, fileTime) {
  const created = timeOf(data.createdAt);
  const updated = timeOf(data.updatedAt);
  const updatedTime = Number.isNaN(updated) ? (Number.isNaN(created) ? fileTime : created) : updated;
  return {
    createdAt: new Date(Number.isNaN(created) ? updatedTime : created).toISOString(),
    updatedAt: new Date(updatedTime).toISOString()
  };
}

/** The summary of a room listed in the sidebar; see roomDates for its dates. */
function roomSummary(data, id, fileTime) {
  if (!isObject(data)) return null;
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    ...roomDates(data, fileTime),
    messageCount: roomMessages(data).length
  };
}

const checkId = (id) => {
  if (!ROOM_ID_PATTERN.test(id || '')) throw new AppError('无效的讨论编号。', 400);
};

/** Room storage in `directory`, which must already exist. */
export function createRoomStore(directory) {
  // Room id → the latest operation (save, rename or removal) asked for on that room's file.
  const queues = new Map();
  // File name → { mtimeMs, size, ino, summary } as last read by list(); summary is null for a file that
  // does not hold a room. A file is read again only once one of the three has changed.
  const summaries = new Map();
  const fileOf = (id) => path.join(directory, `${id}.json`);

  /** Runs `task` once every operation asked for earlier on room `id` has settled; settles as it does. */
  function enqueue(id, task) {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(task);
    queues.set(id, next);
    const forget = () => {
      if (queues.get(id) === next) queues.delete(id);
    };
    next.then(forget, forget);
    return next;
  }

  /** Reads room `id` from its file, normalized by readRoom. */
  async function read(id) {
    let raw;
    try {
      raw = await fs.readFile(fileOf(id), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new AppError('找不到这次讨论。', 404);
      throw e;
    }
    let room = null;
    try {
      room = readRoom(JSON.parse(raw), id);
    } catch {}
    if (!room) throw new AppError('这次讨论的记录文件已损坏，无法读取。', 500);
    return room;
  }

  /** Replaces room `id`'s file with `serialized` in one step, so that readers see the old or the new file. */
  async function write(id, serialized) {
    const temporary = path.join(directory, `.${id}-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, serialized, { mode: 0o600 });
      await fs.rename(temporary, fileOf(id));
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function load(id) {
    checkId(id);
    await queues.get(id)?.catch(() => {});
    return read(id);
  }

  /** Saves `room` as it is now, after the operations on it asked for earlier. */
  async function save(room) {
    const serialized = JSON.stringify(room);
    return enqueue(room.id, () => write(room.id, serialized));
  }

  /**
   * Gives room `id` the title `title` (checked by the caller, see titles.mjs readTitle). The room keeps its
   * update time, the time of its latest message, so the list keeps its order. Resolves to
   * { id, title, updatedAt } with updatedAt as list() gives it; rejects with an AppError 404 when there is
   * no such room.
   */
  async function rename(id, title) {
    checkId(id);
    return enqueue(id, async () => {
      const room = await read(id);
      room.title = title;
      await write(id, JSON.stringify(room));
      const fileTime = (await fs.stat(fileOf(id)).catch(() => null))?.mtimeMs ?? Date.now();
      return { id, title, updatedAt: roomDates(room, fileTime).updatedAt };
    });
  }

  /** Deletes room `id`; rejects with an AppError 404 when there is no such room. */
  async function remove(id) {
    checkId(id);
    return enqueue(id, async () => {
      try {
        await fs.unlink(fileOf(id));
      } catch (e) {
        if (e.code === 'ENOENT') throw new AppError('找不到这次讨论。', 404);
        throw e;
      }
      summaries.delete(`${id}.json`);
    });
  }

  /** The summary of one room file, from the cache while the file is unchanged; null when unreadable. */
  async function summarize(file) {
    const filePath = path.join(directory, file);
    let stat;
    let raw;
    try {
      stat = await fs.stat(filePath);
      if (!stat.isFile()) return null;
      const cached = summaries.get(file);
      if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino)
        return cached.summary;
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return null; // skipped now, read again by the next list()
    }
    let summary = null;
    try {
      summary = roomSummary(JSON.parse(raw), file.slice(0, -5), stat.mtimeMs);
    } catch {}
    summaries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, summary });
    return summary;
  }

  /** Summaries of all readable rooms, most recently updated first. */
  async function list() {
    const files = (await fs.readdir(directory)).filter((file) => ROOM_FILE.test(file));
    const present = new Set(files);
    for (const file of summaries.keys()) if (!present.has(file)) summaries.delete(file);
    const records = (await Promise.all(files.map(summarize))).filter(Boolean);
    return records.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  /** Settles once every save, rename and removal in progress has finished. */
  function flush() {
    return Promise.allSettled([...queues.values()]);
  }

  return { load, save, rename, remove, list, flush };
}
