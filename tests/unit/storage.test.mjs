import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../src/errors.mjs';
import { createRoomStore } from '../../src/storage.mjs';

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-storage-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = (id) => path.join(directory, `${id}.json`);
  return { directory, file, rooms: createRoomStore(directory) };
}

const roomId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const room = (n, fields = {}) => ({
  id: roomId(n),
  title: `讨论 ${n}`,
  createdAt: `2026-01-0${n}T00:00:00.000Z`,
  updatedAt: `2026-02-0${n}T00:00:00.000Z`,
  context: '',
  messages: [
    { id: 'q', role: 'user', stage: 'question', text: '问题', createdAt: '2026-01-01T00:00:00.000Z' }
  ],
  ...fields
});
const summary = ({ id, title, createdAt, updatedAt, messages }) => ({
  id,
  title,
  createdAt,
  updatedAt,
  messageCount: messages.length
});

test('rooms are saved as compact JSON and load back unchanged', async (t) => {
  const { file, rooms } = await setup(t);
  const saved = room(1, { context: '背景', configuration: { mode: 'both' } });
  await rooms.save(saved);
  assert.equal(await fs.readFile(file(saved.id), 'utf8'), JSON.stringify(saved));
  assert.deepEqual(await rooms.load(saved.id), saved);
  // Saves of one room run one at a time, in order.
  await Promise.all([rooms.save({ ...saved, title: '第一次' }), rooms.save({ ...saved, title: '第二次' })]);
  assert.equal((await rooms.load(saved.id)).title, '第二次');
});

test('list reads a file again only when it changed and forgets deleted files', async (t) => {
  const { file, rooms } = await setup(t);
  const [first, second] = [room(1), room(2)];
  await rooms.save(first);
  await rooms.save(second);
  const time = new Date('2026-03-01T00:00:00.000Z');
  await fs.utimes(file(first.id), time, time);
  assert.deepEqual(await rooms.list(), [summary(second), summary(first)]);

  // Same size, same modification time, same file: the cached summary is used without reading the file.
  const sameSize = JSON.stringify({ ...first, title: '讨论 X' });
  assert.equal(sameSize.length, JSON.stringify(first).length);
  await fs.writeFile(file(first.id), sameSize);
  await fs.utimes(file(first.id), time, time);
  assert.equal((await rooms.list()).find((item) => item.id === first.id).title, '讨论 1');

  // A save replaces the file, so the next list reads it again.
  await rooms.save({ ...first, title: '改名后的讨论' });
  assert.equal((await rooms.list()).find((item) => item.id === first.id).title, '改名后的讨论');

  await fs.rm(file(second.id));
  assert.deepEqual(
    (await rooms.list()).map((item) => item.id),
    [first.id]
  );
});

test('rooms without a valid update time are dated by their creation or file time', async (t) => {
  const { directory, file, rooms } = await setup(t);
  const valid = room(1);
  const noUpdate = room(2, { updatedAt: undefined });
  const noDates = room(3, { createdAt: 'unknown', updatedAt: 42, title: 7, messages: 'none' });
  for (const item of [valid, noUpdate, noDates]) await fs.writeFile(file(item.id), JSON.stringify(item));
  const fileTime = new Date('2026-03-01T00:00:00.000Z');
  await fs.utimes(file(noDates.id), fileTime, fileTime);

  // None of these is a room; listing skips them.
  await fs.writeFile(file(roomId(4)), '{broken');
  await fs.writeFile(file(roomId(5)), '[]');
  await fs.writeFile(file(roomId(6)), 'null');
  await fs.mkdir(file(roomId(7)));
  await fs.writeFile(path.join(directory, 'notes.json'), JSON.stringify(room(8)));
  await fs.writeFile(path.join(directory, `.${roomId(9)}-temporary.tmp`), JSON.stringify(room(9)));

  assert.deepEqual(await rooms.list(), [
    {
      id: noDates.id,
      title: '',
      createdAt: fileTime.toISOString(),
      updatedAt: fileTime.toISOString(),
      messageCount: 0
    },
    summary(valid),
    { ...summary(noUpdate), updatedAt: noUpdate.createdAt }
  ]);
  // The skipped files are still skipped once cached.
  assert.equal((await rooms.list()).length, 3);
});

test('hand-edited rooms load with their file id, a title, a context and a list of messages', async (t) => {
  const { file, rooms } = await setup(t);
  const id = roomId(1);
  await fs.writeFile(
    file(id),
    JSON.stringify({
      id: roomId(2),
      title: 5,
      context: null,
      messages: [null, 'text', { role: 'user', text: '问' }]
    })
  );
  assert.deepEqual(await rooms.load(id), {
    id,
    title: '',
    context: '',
    messages: [{ role: 'user', text: '问' }]
  });
  await fs.writeFile(file(id), JSON.stringify({ title: '没有消息' }));
  assert.deepEqual(await rooms.load(id), { id, title: '没有消息', context: '', messages: [] });
});

test('loading a damaged, missing or invalid room fails with a message for people', async (t) => {
  const { file, rooms } = await setup(t);
  const fails = (id, status, message) =>
    assert.rejects(rooms.load(id), (error) => {
      assert.ok(error instanceof AppError);
      assert.deepEqual([error.status, error.message], [status, message]);
      return true;
    });
  await fs.writeFile(file(roomId(1)), '{broken');
  await fs.writeFile(file(roomId(2)), '[1]');
  await fails(roomId(1), 500, '这次讨论的记录文件已损坏，无法读取。');
  await fails(roomId(2), 500, '这次讨论的记录文件已损坏，无法读取。');
  await fails(roomId(3), 404, '找不到这次讨论。');
  await fails('../etc/passwd', 400, '无效的讨论编号。');
});
