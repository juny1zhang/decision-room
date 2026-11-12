// Rooms are saved as one JSON file each, written atomically and one save at a time per room.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOM_ID_PATTERN } from './config.mjs';
import { AppError } from './errors.mjs';

const ROOM_FILE = /^[a-f0-9-]{36}\.json$/;

/** Room storage in `directory`, which must already exist. */
export function createRoomStore(directory) {
  const saveQueues = new Map();

  async function load(id) {
    if (!ROOM_ID_PATTERN.test(id || '')) throw new AppError('无效的讨论编号。', 400);
    try {
      return JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') throw new AppError('找不到这次讨论。', 404);
      throw e;
    }
  }

  async function save(room) {
    const serialized = JSON.stringify(room, null, 2);
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

  /** Summaries of all readable rooms, most recently updated first. */
  async function list() {
    const files = await fs.readdir(directory);
    const records = await Promise.all(
      files
        .filter((f) => ROOM_FILE.test(f))
        .map(async (file) => {
          try {
            const r = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
            return {
              id: r.id,
              title: r.title,
              createdAt: r.createdAt,
              updatedAt: r.updatedAt,
              messageCount: r.messages.length
            };
          } catch {
            return null;
          }
        })
    );
    return records.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Settles once every save in progress has finished. */
  function flush() {
    return Promise.allSettled([...saveQueues.values()]);
  }

  return { load, save, list, flush };
}
