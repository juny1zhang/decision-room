import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appDataDir, dataDirNote, resolveDataDir } from '../../src/data-dir.mjs';

test('the application data folder follows each operating system', () => {
  assert.equal(
    appDataDir({ platform: 'darwin', env: { XDG_DATA_HOME: '/ignored' }, home: '/Users/ann' }),
    '/Users/ann/Library/Application Support/Decision Room'
  );
  assert.equal(
    appDataDir({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\ann\\AppData\\Roaming' },
      home: 'C:\\Users\\ann'
    }),
    'C:\\Users\\ann\\AppData\\Roaming\\Decision Room'
  );
  assert.equal(
    appDataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\ann' }),
    'C:\\Users\\ann\\AppData\\Roaming\\Decision Room'
  );
  assert.equal(
    appDataDir({ platform: 'linux', env: {}, home: '/home/ann' }),
    '/home/ann/.local/share/decision-room'
  );
  assert.equal(
    appDataDir({ platform: 'linux', env: { XDG_DATA_HOME: '/data/ann' }, home: '/home/ann' }),
    '/data/ann/decision-room'
  );
  assert.equal(
    appDataDir({ platform: 'freebsd', env: { XDG_DATA_HOME: 'relative/share' }, home: '/home/ann' }),
    '/home/ann/.local/share/decision-room',
    'A relative XDG_DATA_HOME is ignored'
  );
});

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-root-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('DECISION_ROOM_DATA_DIR wins, relative to the working folder', async (t) => {
  const root = await repository(t);
  await fs.mkdir(path.join(root, 'data', 'rooms'), { recursive: true });
  await fs.writeFile(path.join(root, 'data', 'rooms', 'a.json'), '{}');
  const options = { root, platform: 'linux', home: '/home/ann', cwd: '/work' };
  assert.deepEqual(await resolveDataDir({ ...options, env: { DECISION_ROOM_DATA_DIR: '/srv/rooms' } }), {
    dir: '/srv/rooms',
    source: 'env'
  });
  assert.deepEqual(await resolveDataDir({ ...options, env: { DECISION_ROOM_DATA_DIR: 'my-data' } }), {
    dir: '/work/my-data',
    source: 'env'
  });
});

test('the repository data folder stays in use while it holds saved rooms', async (t) => {
  const root = await repository(t);
  const options = { root, platform: 'linux', env: {}, home: '/home/ann' };
  const app = { dir: '/home/ann/.local/share/decision-room', source: 'app' };
  assert.deepEqual(await resolveDataDir(options), app, 'No data folder');
  await fs.mkdir(path.join(root, 'data', 'rooms'), { recursive: true });
  assert.deepEqual(await resolveDataDir(options), app, 'An empty rooms folder');
  await fs.writeFile(path.join(root, 'data', 'rooms', '.a-b.tmp'), '');
  await fs.writeFile(path.join(root, 'data', 'preferences.json'), '{}');
  assert.deepEqual(await resolveDataDir(options), app, 'Only other files');
  await fs.writeFile(path.join(root, 'data', 'rooms', '00000000-0000-4000-8000-000000000001.json'), '{}');
  const legacy = await resolveDataDir(options);
  assert.deepEqual(legacy, { dir: path.join(root, 'data'), source: 'legacy', appDir: app.dir });

  const note = dataDirNote(legacy);
  assert.ok(
    note.includes(path.join(root, 'data')) &&
      note.includes(app.dir) &&
      note.includes('DECISION_ROOM_DATA_DIR')
  );
  assert.equal(dataDirNote(app), '');
  assert.equal(dataDirNote({ dir: '/srv', source: 'env' }), '');
});
