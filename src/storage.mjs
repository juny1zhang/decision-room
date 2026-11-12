// Rooms are saved as one JSON file each, written atomically and one save at a time per room.
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
 * The summary of a room listed in the sidebar. A room without a valid updatedAt is dated by its createdAt,
 * else by `fileTime`, the modification time of its file.
 */
function roomSummary(data, id, fileTime) {
  if (!isObject(data)) return null;
  const created = timeOf(data.createdAt);
  const updated = timeOf(data.updatedAt);
  const updatedTime = Number.isNaN(updated) ? (Number.isNaN(created) ? fileTime : created) : updated;
  return {
    id,
    title: typeof data.title === 'string' ? data.title : '',
    createdAt: new Date(Number.isNaN(created) ? updatedTime : created).toISOString(),
    updatedAt: new Date(updatedTime).toISOString(),
    messageCount: roomMessages(data).length
  };
}

/** Room storage in `directory`, which must already exist. */
export function createRoomStore(directory) {
  const saveQueues = new Map();
  // File name → { mtimeMs, size, ino, summary } as last read by list(); summary is null for a file that
  // does not hold a room. A file is read again only once one of the three has changed.
  const summaries = new Map();

  async function load(id) {
    if (!ROOM_ID_PATTERN.test(id || '')) throw new AppError('无效的讨论编号。', 400);
    let raw;
    try {
      raw = await fs.readFile(path.join(directory, `${id}.json`), 'utf8');
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

  async function save(room) {
    const serialized = JSON.stringify(room);
    const previous = saveQueues.get(room.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const temporary = path.join(directory, `.${room.id}-${randomUUID()}.tmp`);
        await fs.writeFile(temporary, serialized, { mode: 0o600 });
        await fs.rename(temporary, path.join(directory, `${room.id}.json`));
      });
    saveQueues.set(room.id, next);
    try {
      await next;
    } finally {
      if (saveQueues.get(room.id) === next) saveQueues.delete(room.id);
    }
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

  /** Settles once every save in progress has finished. */
  function flush() {
    return Promise.allSettled([...saveQueues.values()]);
  }

  return { load, save, list, flush };
}
