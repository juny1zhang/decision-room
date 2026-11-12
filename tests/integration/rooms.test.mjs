// Managing saved discussions: renaming and deleting rooms, their default titles, and the room a discussion
// is running in, through the server with the mock CLIs and through the room store on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRoomStore } from '../../src/storage.mjs';
import { harness } from '../support/harness.mjs';

const MISSING = { error: '找不到这次讨论。' };
const NO_ROUTE = { error: '未找到该操作。' };
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000099';

/** Runs a round to its end and resolves to { roomId, title } from its "room" event. */
async function discuss(h, payload) {
  const { res, events, raw } = await h.run(payload);
  assert.equal(res.status, 200, raw);
  assert.ok(
    events.some((event) => event.type === 'done'),
    raw
  );
  const { roomId, title } = events.find((event) => event.type === 'room');
  return { roomId, title };
}

const rename = (h, id, body, headers) => h.request(`/api/rooms/${id}`, { method: 'PATCH', body, headers });
const remove = (h, id) => h.request(`/api/rooms/${id}`, { method: 'DELETE' });
const listed = async (h) => (await h.request('/api/rooms')).json();
const answer = async (response) => ({ status: response.status, body: await response.json() });

/** Reads the NDJSON events of a streaming /api/run response as they arrive. */
function eventReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pending = [];
  let buffer = '';
  return {
    /** Resolves to the next event for which `match` is true, or to null once the stream has ended. */
    async find(match) {
      for (;;) {
        while (pending.length) {
          const event = pending.shift();
          if (match(event)) return event;
        }
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) pending.push(JSON.parse(line));
      }
    }
  };
}

/** Stops the running discussion and reads its stream to the end, after which the server has let go of it. */
async function stop(h, events) {
  assert.equal((await h.request('/api/cancel', { method: 'POST', body: {} })).status, 200);
  assert.ok(await events.find((event) => event.type === 'done'));
  assert.equal(await events.find(() => false), null);
}

test('a renamed room keeps its place in the list, and later rounds keep its new title', async (t) => {
  const h = await harness(t);
  const first = await discuss(h, { prompt: '  \n第一个问题：要不要   换工作？\n补充：已有两个选择' });
  assert.equal(first.title, '第一个问题：要不要 换工作？', 'The first line, with its spaces collapsed');
  const second = await discuss(h, { prompt: '第二个问题' });
  const before = await listed(h);
  assert.deepEqual(
    before.rooms.map((room) => room.id),
    [second.roomId, first.roomId]
  );
  assert.equal(before.runningRoomId, null);

  const renamed = await rename(h, first.roomId, { title: '  换工作的决定  ' });
  assert.equal(renamed.status, 200);
  const { updatedAt } = before.rooms.find((room) => room.id === first.roomId);
  assert.deepEqual(await renamed.json(), { id: first.roomId, title: '换工作的决定', updatedAt });
  const after = await listed(h);
  assert.deepEqual(
    after.rooms.map((room) => [room.id, room.title, room.updatedAt]),
    [
      [second.roomId, second.title, before.rooms[0].updatedAt],
      [first.roomId, '换工作的决定', updatedAt]
    ],
    'Renaming is not new activity: the list keeps its order'
  );
  const room = await (await h.request(`/api/rooms/${first.roomId}`)).json();
  assert.equal(room.title, '换工作的决定');
  assert.equal(room.messages.length, 3, 'Only the title changed');
  assert.ok(
    (await (await h.request(`/api/rooms/${first.roomId}/export`)).text()).startsWith('# 换工作的决定')
  );

  const followUp = await discuss(h, { roomId: first.roomId, prompt: '再追问一句' });
  assert.equal(followUp.title, '换工作的决定');
  assert.equal((await (await h.request(`/api/rooms/${first.roomId}`)).json()).title, '换工作的决定');
  assert.equal((await listed(h)).rooms[0].id, first.roomId, 'A new round moves the room up');
});

test('renaming refuses invalid titles and unknown rooms', async (t) => {
  const h = await harness(t);
  const { roomId, title } = await discuss(h, { prompt: '原来的标题' });
  for (const [body, error] of [
    [{}, '讨论标题不能为空。'],
    [{ title: 5 }, '讨论标题不能为空。'],
    [{ title: ' \u3000 ' }, '讨论标题不能为空。'],
    [{ title: '两行\n标题' }, '讨论标题不能包含换行或其他控制字符。'],
    [{ title: '题'.repeat(81) }, '讨论标题不能超过 80 个字符。']
  ]) {
    assert.deepEqual(await answer(await rename(h, roomId, body)), { status: 400, body: { error } });
  }
  assert.deepEqual(await answer(await rename(h, roomId, '{broken')), {
    status: 400,
    body: { error: '请求格式无效。' }
  });
  assert.equal((await rename(h, roomId, { title: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await (await h.request(`/api/rooms/${roomId}`)).json()).title, title, 'Nothing was saved');

  assert.deepEqual(await answer(await rename(h, UNKNOWN_ID, { title: '新标题' })), {
    status: 404,
    body: MISSING
  });
  for (const route of ['/api/rooms/not-a-room', `/api/rooms/${roomId}/export`, '/api/rooms']) {
    const response = await h.request(route, { method: 'PATCH', body: { title: '新标题' } });
    assert.deepEqual(await answer(response), { status: 404, body: NO_ROUTE }, route);
  }
  const anonymous = await fetch(`${h.origin}/api/rooms/${roomId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '新标题' })
  });
  assert.equal(anonymous.status, 401);
  const longest = '题'.repeat(80);
  assert.equal((await (await rename(h, roomId, { title: longest })).json()).title, longest);
});

test('deleting a room removes its file and clears it as the selected room', async (t) => {
  const h = await harness(t);
  const kept = await discuss(h, { prompt: '保留的讨论' });
  const deleted = await discuss(h, { prompt: '要删除的讨论' });
  const file = (id) => path.join(h.temp, 'data', 'rooms', `${id}.json`);
  await fs.access(file(deleted.roomId));
  const preferences = async () => (await h.request('/api/preferences')).json();
  const select = (selectedRoomId) =>
    h.request('/api/preferences', { method: 'PUT', body: { selectedRoomId } });

  // Another room is selected: deleting this one leaves the selection alone.
  assert.equal((await select(kept.roomId)).status, 200);
  assert.deepEqual(await answer(await remove(h, deleted.roomId)), { status: 200, body: { ok: true } });
  assert.equal((await preferences()).selectedRoomId, kept.roomId);
  await assert.rejects(fs.access(file(deleted.roomId)), { code: 'ENOENT' });
  assert.deepEqual(await answer(await h.request(`/api/rooms/${deleted.roomId}`)), {
    status: 404,
    body: MISSING
  });
  assert.equal((await h.request(`/api/rooms/${deleted.roomId}/export`)).status, 404);
  assert.deepEqual(
    (await listed(h)).rooms.map((room) => room.id),
    [kept.roomId]
  );
  assert.deepEqual(await answer(await remove(h, deleted.roomId)), { status: 404, body: MISSING });
  assert.deepEqual(await answer(await remove(h, UNKNOWN_ID)), { status: 404, body: MISSING });

  // The selected room is deleted: the selection is cleared, the configuration kept.
  const configuration = { mode: 'both', participants: ['codex', 'claude'] };
  await h.request('/api/preferences', { method: 'PUT', body: { configuration } });
  assert.deepEqual(await answer(await remove(h, kept.roomId)), { status: 200, body: { ok: true } });
  assert.deepEqual(await preferences(), { configuration, selectedRoomId: null });
  assert.deepEqual((await listed(h)).rooms, []);
  for (const route of ['/api/rooms/not-a-room', `/api/rooms/${kept.roomId}/export`, '/api/rooms']) {
    const response = await h.request(route, { method: 'DELETE' });
    assert.deepEqual(await answer(response), { status: 404, body: NO_ROUTE }, route);
  }
});

test('the room a discussion runs in cannot be renamed or deleted until the discussion ends', async (t) => {
  const h = await harness(t);
  const other = await discuss(h, { prompt: '另一个讨论' });
  const busy = await discuss(h, { prompt: '正在进行的讨论' });
  await h.setControl({ codex: { hang: true } });
  const response = await h.startRun({ roomId: busy.roomId, prompt: '继续追问' });
  assert.equal(response.status, 200);
  const events = eventReader(response);
  assert.ok(await events.find((event) => event.type === 'status' && event.agent === 'codex'));

  assert.equal((await listed(h)).runningRoomId, busy.roomId);
  assert.deepEqual(await answer(await rename(h, busy.roomId, { title: '新名字' })), {
    status: 409,
    body: { error: '这次讨论正在进行，请等它结束或停止后再改名。' }
  });
  assert.deepEqual(await answer(await remove(h, busy.roomId)), {
    status: 409,
    body: { error: '这次讨论正在进行，请等它结束或停止后再删除。' }
  });
  // Other rooms stay free to change.
  assert.equal((await rename(h, other.roomId, { title: '改名不受影响' })).status, 200);
  assert.equal((await remove(h, other.roomId)).status, 200);

  await stop(h, events);
  assert.equal((await listed(h)).runningRoomId, null);
  const room = await (await h.request(`/api/rooms/${busy.roomId}`)).json();
  assert.equal(room.title, busy.title, 'The refused rename changed nothing');
  assert.equal((await rename(h, busy.roomId, { title: '结束后改名' })).status, 200);
  assert.equal((await remove(h, busy.roomId)).status, 200);
});

test('a new room is protected from the moment the page learns its id', async (t) => {
  const h = await harness(t, { codex: { hang: true } });
  const response = await h.startRun({ prompt: '全新的讨论\n第二行不进标题' });
  assert.equal(response.status, 200);
  const events = eventReader(response);
  const { roomId, title } = await events.find((event) => event.type === 'room');
  assert.equal(title, '全新的讨论');
  assert.equal((await listed(h)).runningRoomId, roomId);
  assert.equal((await remove(h, roomId)).status, 409);
  assert.equal((await rename(h, roomId, { title: '新名字' })).status, 409);
  await stop(h, events);
  assert.equal((await rename(h, roomId, { title: '新名字' })).status, 200);
  assert.equal((await remove(h, roomId)).status, 200);
});

test('rooms started from the same suggestion get different default titles', async (t) => {
  const h = await harness(t);
  const opening = '我在两个选择之间犹豫。请先帮我梳理判断标准，再分别分析取舍。';
  const ask = (a, b) =>
    discuss(h, { prompt: `${opening}\n\n选项 A：${a}\n选项 B：${b}\n我最在意的三件事：` });
  assert.equal((await ask('去上海工作', '留在北京')).title, '去上海工作 / 留在北京');
  assert.equal((await ask('读博', '直接工作')).title, '读博 / 直接工作');
  assert.equal((await ask('', '')).title, opening, 'Nothing filled in: the opening line');
});

test('renames and removals of a stored room wait for the saves asked for before them', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-rooms-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const rooms = createRoomStore(directory);
  const room = {
    id: '00000000-0000-4000-8000-000000000001',
    title: '原标题',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    context: '背景',
    messages: [{ id: 'q', role: 'user', stage: 'question', text: '问题' }],
    configuration: { mode: 'both' }
  };
  const file = path.join(directory, `${room.id}.json`);

  // Asked for together: the save, then the rename, then the load see each other's results in that order.
  const saved = rooms.save(room);
  const renamed = rooms.rename(room.id, '新标题');
  const loaded = rooms.load(room.id);
  await saved;
  assert.deepEqual(await renamed, { id: room.id, title: '新标题', updatedAt: room.updatedAt });
  assert.deepEqual(await loaded, { ...room, title: '新标题' }, 'Only the title changed');

  // A removal asked for right after a save runs after it, so the room does not come back.
  const resaved = rooms.save({ ...room, title: '再保存' });
  const removed = rooms.remove(room.id);
  await Promise.all([resaved, removed]);
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  assert.deepEqual(await rooms.list(), []);
  await assert.rejects(rooms.load(room.id), { message: '找不到这次讨论。', status: 404 });
  await assert.rejects(rooms.rename(room.id, '标题'), { message: '找不到这次讨论。', status: 404 });
  await assert.rejects(rooms.remove(room.id), { message: '找不到这次讨论。', status: 404 });
  for (const id of ['../room', '', undefined]) {
    await assert.rejects(rooms.rename(id, '标题'), { message: '无效的讨论编号。', status: 400 });
    await assert.rejects(rooms.remove(id), { message: '无效的讨论编号。', status: 400 });
  }

  // A damaged file is left as it is.
  await fs.writeFile(file, '{broken');
  await assert.rejects(rooms.rename(room.id, '标题'), { status: 500 });
  assert.equal(await fs.readFile(file, 'utf8'), '{broken');
  // A room without dates is dated by its file, as in the list.
  await fs.writeFile(file, JSON.stringify({ title: '无日期', messages: [] }));
  const undated = await rooms.rename(room.id, '有标题');
  assert.deepEqual(undated, { id: room.id, title: '有标题', updatedAt: (await rooms.list())[0].updatedAt });
  await rooms.flush();
  assert.deepEqual(
    (await fs.readdir(directory)).filter((name) => name.endsWith('.tmp')),
    [],
    'No temporary file is left'
  );
});
