// Browser test of preferences across a restart: the configuration and the open room chosen before the
// server stops come back after it starts again on the same DECISION_ROOM_PORT with the same data folder,
// in the same browser profile and in a new one, which only has what the server saved.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertClean,
  freePort,
  getJson,
  harness,
  launchBrowser,
  openApp,
  roomId,
  savedRoom,
  seedRoom,
  until
} from './support/browser.mjs';

let browser;

before(async () => {
  browser = await launchBrowser();
});
after(() => browser?.close());

const TITLE = '是否搬到新城市';

/** Checks that `page` shows the room and the configuration chosen before the restart. */
async function assertRestored(page) {
  await page.locator('#roomHeading', { hasText: TITLE }).waitFor();
  await page.locator('#messages .message.user', { hasText: '要不要搬家？' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '分别回答' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.locator('#activeParticipants .participant').allTextContents(), [
    'Codex',
    'Cursor'
  ]);
  assert.equal(await page.getByLabel('允许查找网页').isChecked(), true);
  await page.getByRole('button', { name: '模型与能力' }).click();
  assert.equal(await page.locator('#participant-claude').isChecked(), false);
  assert.equal(await page.locator('#participant-cursor').isChecked(), true);
  assert.equal(await page.locator('#model-cursor').inputValue(), 'mock-cursor');
  await page.getByRole('button', { name: '关闭模型与能力' }).click();
}

test('preferences survive a restart on the same port', { timeout: 120000 }, async (t) => {
  const port = await freePort();
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-ui-data-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  await seedRoom(data, savedRoom(roomId(1), TITLE, [['user', 'question', '要不要搬家？']]));
  const env = { DECISION_ROOM_PORT: String(port), DECISION_ROOM_DATA_DIR: data };
  const profile = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  t.after(() => profile.close());

  // Each launch is a subtest: the harness stops its server when the subtest ends.
  await t.test('first launch: choose a room and a configuration', async (t) => {
    const h = await harness(t, {}, { env });
    assert.equal(new URL(h.origin).port, String(port));
    const session = await openApp(t, browser, h, { context: profile });
    const { page } = session;
    await page.locator(`.room-entry[data-room-id="${roomId(1)}"] .room-item`).click();
    await page.locator('#roomHeading', { hasText: TITLE }).waitFor();
    await page.getByRole('button', { name: '分别回答' }).click();
    await page.getByRole('button', { name: '模型与能力' }).click();
    await page.locator('#participant-claude').click();
    await page.locator('#participant-cursor').click();
    await page.locator('#model-cursor').selectOption('mock-cursor');
    await page.getByRole('button', { name: '应用设置' }).click();
    await page.getByLabel('允许查找网页').check();
    const saved = await until(async () => {
      const preferences = await getJson(h, '/api/preferences');
      return preferences.configuration?.webSearch && preferences;
    }, 'the preferences are saved on the server');
    assert.deepEqual(saved, {
      configuration: {
        mode: 'both',
        participants: ['codex', 'cursor'],
        moderator: 'codex',
        settings: {
          codex: { model: '', reasoning: '', capability: 'general' },
          cursor: { model: 'mock-cursor', reasoning: '', capability: 'general' }
        },
        webSearch: true
      },
      selectedRoomId: roomId(1)
    });
    assertClean(session);
    await page.close();
  });

  await t.test('second launch: the same choices come back', async (t) => {
    const h = await harness(t, {}, { env });
    assert.equal(new URL(h.origin).port, String(port));
    // The same browser profile, opened with the new launch's address.
    const same = await openApp(t, browser, h, { context: profile });
    await assertRestored(same.page);
    assertClean(same);
    // A new profile has nothing of its own: everything comes from the server.
    const fresh = await openApp(t, browser, h);
    await assertRestored(fresh.page);
    assertClean(fresh);
  });
});
