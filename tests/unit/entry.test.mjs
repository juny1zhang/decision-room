import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function modules(dir) {
  const found = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await modules(file)));
    else if (entry.name.endsWith('.mjs')) found.push(file);
  }
  return found;
}

test('importing server.mjs and every src module starts nothing', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-import-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const data = path.join(temp, 'data');
  const urls = [path.join(root, 'server.mjs'), ...(await modules(path.join(root, 'src')))].map(
    (file) => pathToFileURL(file).href
  );
  // A server, timer or open handle would keep this process alive until the timeout.
  const script = `for (const url of ${JSON.stringify(urls)}) await import(url); console.log('imported');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: temp,
    env: { ...process.env, DECISION_ROOM_DATA_DIR: data },
    encoding: 'utf8',
    timeout: 15000
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, 'imported\n', 'No startup banner or other output');
  assert.equal(existsSync(data), false, 'No data folder is created');
});
