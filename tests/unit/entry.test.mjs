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

test('on Linux the browser opens a private launcher page: no command line holds the token', async (t) => {
  const { launcherPage, openBrowser } = await import('../../src/main.mjs');
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-open-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const token = 'f'.repeat(64);
  const address = `http://127.0.0.1:41710/#${token}`;
  const started = [];
  const start = (command, args, options) => {
    started.push({ command, args, options });
    return { on() {}, unref() {} };
  };

  const [command, target] = await openBrowser(address, runtimeDir, { platform: 'linux', start });
  assert.equal(command, 'xdg-open');
  assert.equal(target, path.join(runtimeDir, 'open.html'));
  assert.ok(!started[0].args.join(' ').includes(token), 'no argument holds the token');
  assert.equal(started[0].options.shell, false);
  assert.equal(await fs.readFile(target, 'utf8'), launcherPage(address));
  assert.ok(launcherPage(address).includes(`content="0;url=${address}"`));
  if (process.platform !== 'win32') assert.equal((await fs.stat(target)).mode & 0o777, 0o600);

  // macOS opens the address itself; other systems open nothing.
  assert.deepEqual(await openBrowser(address, runtimeDir, { platform: 'darwin', start }), ['open', address]);
  assert.equal(await openBrowser(address, runtimeDir, { platform: 'win32', start }), null);
  assert.equal(started.length, 2);
});
