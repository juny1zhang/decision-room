import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPreferenceStore,
  readPreferencePatch,
  readPreferredConfiguration
} from '../../src/preferences.mjs';

const ROOM_ID = '00000000-0000-4000-8000-000000000001';

async function store(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-preferences-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'preferences.json');
  return { dir, file, preferences: createPreferenceStore(file) };
}

test('a saved configuration is checked leniently and unknown fields are dropped', () => {
  const full = {
    mode: 'debate',
    participants: ['cursor', 'claude', 'codex'],
    moderator: 'cursor',
    settings: {
      codex: { model: 'gpt-5', reasoning: 'high', capability: 'verify' },
      cursor: { model: 'mock-cursor[context=1m]', reasoning: '', capability: 'plan' }
    },
    webSearch: false
  };
  assert.deepEqual(readPreferredConfiguration(full), full);
  assert.deepEqual(
    readPreferredConfiguration({ mode: 'claude' }),
    { mode: 'claude' },
    'Missing fields are fine'
  );
  // Goal mode and its most versions; maxRounds is kept in the other modes too.
  const goal = { mode: 'goal', participants: ['codex', 'claude'], moderator: 'claude', maxRounds: 6 };
  assert.deepEqual(readPreferredConfiguration(goal), goal);
  assert.deepEqual(readPreferredConfiguration({ mode: 'both', maxRounds: 1 }), {
    mode: 'both',
    maxRounds: 1
  });
  assert.deepEqual(
    readPreferredConfiguration({
      mode: 'both',
      moderator: '',
      participants: ['codex'],
      future: 1,
      settings: { claude: { model: 'opus', extra: true } }
    }),
    { mode: 'both', moderator: '', participants: ['codex'], settings: { claude: { model: 'opus' } } }
  );
});

test('configurations with unknown modes or providers, wrong types or long strings are refused', () => {
  for (const value of [
    null,
    [],
    'debate',
    {},
    { mode: 'everyone' },
    { mode: 'toString' },
    { mode: 'debate', participants: 'codex' },
    { mode: 'debate', participants: ['codex', 'codex'] },
    { mode: 'debate', participants: ['codex', 'other'] },
    { mode: 'debate', participants: ['codex', 'claude', 'cursor', 'codex'] },
    { mode: 'debate', moderator: 'other' },
    { mode: 'debate', settings: [] },
    { mode: 'debate', settings: { other: {} } },
    { mode: 'debate', settings: { __proto__: null, ['__proto__']: {} } },
    { mode: 'debate', settings: { codex: 'gpt-5' } },
    { mode: 'debate', settings: { codex: { model: 5 } } },
    { mode: 'debate', settings: { codex: { model: 'x'.repeat(241) } } },
    { mode: 'debate', settings: { codex: { reasoning: 'r'.repeat(33) } } },
    { mode: 'debate', settings: { codex: { capability: 'c'.repeat(33) } } },
    { mode: 'debate', webSearch: 'true' },
    { mode: 'goal', maxRounds: 0 },
    { mode: 'goal', maxRounds: 7 },
    { mode: 'goal', maxRounds: 2.5 },
    { mode: 'goal', maxRounds: '3' }
  ]) {
    assert.throws(
      () => readPreferredConfiguration(value),
      { message: '偏好设置无效。', status: 400 },
      JSON.stringify(value)
    );
  }
});

test('a preference change names the fields it sets, and null clears one', () => {
  assert.deepEqual(readPreferencePatch({}), {});
  assert.deepEqual(readPreferencePatch({ selectedRoomId: ROOM_ID, other: 1 }), { selectedRoomId: ROOM_ID });
  assert.deepEqual(readPreferencePatch({ configuration: null, selectedRoomId: null }), {
    configuration: null,
    selectedRoomId: null
  });
  assert.deepEqual(readPreferencePatch({ configuration: { mode: 'codex', webSearch: true } }), {
    configuration: { mode: 'codex', webSearch: true }
  });
  for (const selectedRoomId of ['', 'x', 'ABCDEF00-0000-4000-8000-000000000001', `${ROOM_ID}/..`, 5, {}])
    assert.throws(() => readPreferencePatch({ selectedRoomId }), { status: 400 }, String(selectedRoomId));
});

test('preferences are merged into a private file, written atomically one change at a time', async (t) => {
  const { dir, file, preferences } = await store(t);
  assert.deepEqual(await preferences.read(), { configuration: null, selectedRoomId: null });
  const configuration = { mode: 'both', participants: ['codex', 'claude'], webSearch: true };
  await Promise.all([
    preferences.update({ configuration }),
    preferences.update({ selectedRoomId: ROOM_ID }),
    preferences.update({ configuration: { ...configuration, webSearch: false } })
  ]);
  assert.deepEqual(await preferences.read(), {
    configuration: { ...configuration, webSearch: false },
    selectedRoomId: ROOM_ID
  });
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(dir), ['preferences.json'], 'No temporary file is left behind');
  await preferences.update({ selectedRoomId: null });
  assert.deepEqual(await preferences.read(), {
    configuration: { ...configuration, webSearch: false },
    selectedRoomId: null
  });
  await preferences.flush();
});

test('a damaged or edited preferences file reads as nothing saved', async (t) => {
  const { file, preferences } = await store(t);
  for (const content of [
    '{broken',
    'null',
    '[]',
    JSON.stringify({ configuration: { mode: 'x' }, selectedRoomId: 'y' })
  ]) {
    await fs.writeFile(file, content);
    assert.deepEqual(await preferences.read(), { configuration: null, selectedRoomId: null }, content);
  }
  await fs.writeFile(file, JSON.stringify({ configuration: { mode: 'codex' }, selectedRoomId: 'y' }));
  assert.deepEqual(await preferences.read(), { configuration: { mode: 'codex' }, selectedRoomId: null });
  await preferences.update({ selectedRoomId: ROOM_ID });
  assert.deepEqual(await preferences.read(), { configuration: { mode: 'codex' }, selectedRoomId: ROOM_ID });
});

test('a failed write leaves the saved preferences and no temporary file', async (t) => {
  const { dir, file, preferences } = await store(t);
  await preferences.update({ selectedRoomId: ROOM_ID });
  // A folder where the file should be makes the rename fail.
  await fs.rm(file);
  await fs.mkdir(file);
  await assert.rejects(preferences.update({ selectedRoomId: null }));
  assert.deepEqual(await fs.readdir(dir), ['preferences.json']);
  await fs.rmdir(file);
  await preferences.update({ selectedRoomId: ROOM_ID });
  assert.deepEqual((await preferences.read()).selectedRoomId, ROOM_ID, 'Later updates still run');
});
