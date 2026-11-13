// Browser test of preferences across a restart: the configuration and the open room chosen before the
// server stops come back after it starts again on the same DECISION_ROOM_PORT with the same data folder,
// in the same browser profile and in a new one, which only has what the server saved. Neither the room's
// own configuration (that of its last round) nor its saved shared context replaces them: the same profile
// keeps the shared context edited there and not sent yet. Goal mode's "最多几版", chosen there before
// switching to another mode, comes back with the rest.
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
const SAVED_CONTEXT = '旧背景：预算 20 万';
const EDITED_CONTEXT = '新的背景：预算 30 万，年底前搬完';

/** Checks that `page` shows the room, the configuration chosen before the restart and `context`. */
async function assertRestored(page, context) {
  await page.locator('#roomHeading', { hasText: TITLE }).waitFor();
  await page.locator('#messages .message.user', { hasText: '要不要搬家？' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '分别回答' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await page.locator('#activeParticipants .participant').allTextContents(), [
    'Codex',
    'Cursor'
  ]);
  assert.equal(await page.getByLabel('允许查找网页').isChecked(), true);
  assert.equal(await page.evaluate(async () => (await import('/js/state.js')).state.maxRounds), 5);
  await page.getByRole('button', { name: '模型与能力' }).click();
  assert.equal(await page.locator('#participant-claude').isChecked(), false);
  assert.equal(await page.locator('#participant-cursor').isChecked(), true);
  assert.equal(await page.locator('#model-cursor').inputValue(), 'mock-cursor');
  await page.getByRole('button', { name: '关闭模型与能力' }).click();
  await page.locator('#contextButton').click();
  assert.equal(await page.locator('#contextInput').inputValue(), context);
  await page.getByRole('button', { name: '关闭共同背景' }).click();
}

test('preferences survive a restart on the same port', { timeout: 120000 }, async (t) => {
  const port = await freePort();
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'decision-room-ui-data-'));
  t.after(() => fs.rm(data, { recursive: true, force: true }));
  // Saved as a round saves it: with the context and the configuration that round was asked with.
  await seedRoom(data, {
    ...savedRoom(roomId(1), TITLE, [['user', 'question', '要不要搬家？']]),
    context: SAVED_CONTEXT,
    configuration: {
      mode: 'debate',
      participants: ['codex', 'claude'],
      moderator: 'codex',
      settings: {
        codex: { model: '', reasoning: '', capability: 'general' },
        claude: { model: '', reasoning: '', capability: 'general' }
      },
      webSearch: false
    }
  });
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
    assert.equal(await page.getByRole('button', { name: '联合讨论' }).getAttribute('aria-pressed'), 'true');
    // "最多几版" shows in goal mode only, and is kept after switching away from it.
    assert.equal(await page.locator('#roundsControl').isHidden(), true);
    await page.getByRole('button', { name: '目标模式' }).click();
    await page.getByRole('combobox', { name: '方案最多几版' }).selectOption('5');
    await page.getByRole('button', { name: '分别回答' }).click();
    await page.locator('#roundsControl').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '模型与能力' }).click();
    await page.locator('#participant-claude').click();
    await page.locator('#participant-cursor').click();
    await page.locator('#model-cursor').selectOption('mock-cursor');
    await page.getByRole('button', { name: '应用设置' }).click();
    await page.getByLabel('允许查找网页').check();
    // A new shared context, kept in this browser until a question sends it.
    await page.locator('#contextButton').click();
    assert.equal(await page.locator('#contextInput').inputValue(), SAVED_CONTEXT);
    await page.locator('#contextInput').fill(EDITED_CONTEXT);
    await page.getByRole('button', { name: '使用这份背景' }).click();
    await until(
      () => page.evaluate(() => localStorage.getItem('decision-room-draft')?.includes('预算 30 万')),
      'the draft holds the new context'
    );
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
        webSearch: true,
        maxRounds: 5
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
    await assertRestored(same.page, EDITED_CONTEXT);
    assertClean(same);
    // A new profile has nothing of its own: everything comes from the server, the room's context included.
    const fresh = await openApp(t, browser, h);
    await assertRestored(fresh.page, SAVED_CONTEXT);
    assertClean(fresh);
  });
});
