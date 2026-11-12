// Browser tests of saved discussions: searching, renaming and deleting them in the sidebar, exporting one as
// Markdown and how answers render their Markdown. The rooms are written to the data folder before the page
// opens; every flow ends without console errors, page errors or CSP violations.
/* global document, getComputedStyle, MutationObserver */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertClean,
  assertReadable,
  getJson,
  harness,
  launchBrowser,
  openApp,
  roomId,
  savedRoom,
  seedRoom,
  until
} from './support/browser.mjs';

const TIMEOUT = { timeout: 90000 };
let browser;

before(async () => {
  browser = await launchBrowser();
});
after(() => browser?.close());

const dataDir = (h) => path.join(h.temp, 'data');
const entry = (page, n) => page.locator(`#roomList .room-entry[data-room-id="${roomId(n)}"]`);
const shownTitles = (page) =>
  page.locator('#roomList .room-entry:not([hidden]) .room-item-title').allTextContents();

/** Opens saved room `n` from the sidebar and waits for its heading. */
async function openRoom(page, n, title) {
  await entry(page, n).locator('.room-item').click();
  await page.locator('#roomHeading', { hasText: title }).waitFor();
}

test('the sidebar searches, renames and deletes saved discussions', TIMEOUT, async (t) => {
  const h = await harness(t);
  const rooms = [
    [1, '周末旅行计划', '2026-03-03T01:00:00.000Z'],
    [2, '技术方案审查', '2026-03-02T01:00:00.000Z'],
    [3, 'Budget 预算复盘', '2026-03-01T01:00:00.000Z']
  ];
  for (const [n, title, date] of rooms)
    await seedRoom(
      dataDir(h),
      savedRoom(
        roomId(n),
        title,
        [
          ['user', 'question', `关于「${title}」的问题`],
          ['codex', 'analysis', `关于「${title}」的回答`, { provider: 'codex' }]
        ],
        date
      )
    );
  const session = await openApp(t, browser, h);
  const { page } = session;
  assert.deepEqual(await shownTitles(page), ['周末旅行计划', '技术方案审查', 'Budget 预算复盘']);

  // Search: case and full-width letters do not matter.
  const search = page.getByRole('searchbox', { name: '搜索讨论标题' });
  await search.fill('方案');
  await page.locator('#roomFilterStatus', { hasText: '找到 1 条讨论' }).waitFor();
  assert.deepEqual(await shownTitles(page), ['技术方案审查']);
  await search.fill('ＢＵＤＧＥＴ');
  assert.deepEqual(await shownTitles(page), ['Budget 预算复盘']);
  await search.fill('不存在的标题');
  await page.locator('#roomFilterEmpty', { hasText: '没有匹配的讨论' }).waitFor();
  assert.equal(await page.locator('#roomFilterStatus').textContent(), '没有匹配的讨论');
  await assertReadable(page, 'with a search that matches nothing');
  await search.fill('');
  await page.locator('#roomFilterEmpty').waitFor({ state: 'hidden' });
  assert.equal((await shownTitles(page)).length, 3);

  // The live region of the messages is off while a room's saved messages are added: screen readers do not
  // read out the whole transcript.
  await page.evaluate(() => {
    const list = document.getElementById('messages');
    globalThis.liveWhenAdded = [];
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.classList?.contains('message'))
            globalThis.liveWhenAdded.push(list.getAttribute('aria-live'));
    }).observe(list, { childList: true });
  });
  await openRoom(page, 1, '周末旅行计划');
  await page.locator('#messages .message-body', { hasText: '关于「周末旅行计划」的回答' }).waitFor();
  assert.equal(await entry(page, 1).locator('.room-item').getAttribute('aria-current'), 'true');
  assert.deepEqual(await page.evaluate(() => globalThis.liveWhenAdded), ['off', 'off']);
  await page.locator('#messages[aria-live="polite"]').waitFor({ state: 'attached' });

  // Rename a room that is not open; an empty title is refused.
  const renameDialog = page.locator('#renameDialog');
  const titleInput = page.getByLabel('讨论标题', { exact: true });
  await page.getByRole('button', { name: '重命名「技术方案审查」' }).click();
  await renameDialog.waitFor();
  assert.equal(await titleInput.inputValue(), '技术方案审查');
  await titleInput.fill('   ');
  await page.getByRole('button', { name: '保存' }).click();
  await page.locator('#renameError', { hasText: '讨论标题不能为空。' }).waitFor();
  await assertReadable(page, 'in the rename dialog');
  await titleInput.fill('架构方案评审');
  await page.getByRole('button', { name: '保存' }).click();
  await renameDialog.waitFor({ state: 'hidden' });
  await page.locator('#toast', { hasText: '已重命名' }).waitFor();
  await entry(page, 2).locator('.room-item-title', { hasText: '架构方案评审' }).waitFor();
  assert.equal((await getJson(h, `/api/rooms/${roomId(2)}`)).title, '架构方案评审');
  // Renaming keeps a room's place in the list.
  assert.deepEqual(await shownTitles(page), ['周末旅行计划', '架构方案评审', 'Budget 预算复盘']);

  // Renaming the open room renames its heading too; Enter saves.
  await page.getByRole('button', { name: '重命名「周末旅行计划」' }).click();
  await titleInput.fill('周末短途旅行');
  await titleInput.press('Enter');
  await page.locator('#roomHeading', { hasText: '周末短途旅行' }).waitFor();
  await entry(page, 1).locator('.room-item-title', { hasText: '周末短途旅行' }).waitFor();

  // A rename that the search no longer matches moves focus to "新的讨论" rather than losing it.
  await search.fill('方案');
  await page.getByRole('button', { name: '重命名「架构方案评审」' }).focus();
  await page.keyboard.press('Enter');
  await titleInput.fill('架构评审');
  await titleInput.press('Enter');
  await page.locator('#roomFilterEmpty', { hasText: '没有匹配的讨论' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'newRoom');
  await search.fill('');
  assert.deepEqual(await shownTitles(page), ['周末短途旅行', '架构评审', 'Budget 预算复盘']);

  // Delete a room that is not open: cancelling keeps it.
  const deleteDialog = page.locator('#deleteDialog');
  await page.getByRole('button', { name: '删除「Budget 预算复盘」' }).click();
  await deleteDialog.waitFor();
  assert.equal(await page.locator('#deleteName').textContent(), 'Budget 预算复盘');
  await assertReadable(page, 'in the delete dialog');
  await page.getByRole('button', { name: '取消' }).click();
  await deleteDialog.waitFor({ state: 'hidden' });
  await getJson(h, `/api/rooms/${roomId(3)}`);
  await page.getByRole('button', { name: '删除「Budget 预算复盘」' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await deleteDialog.waitFor({ state: 'hidden' });
  await page.locator('#toast', { hasText: '已删除讨论' }).waitFor();
  await entry(page, 3).waitFor({ state: 'detached' });
  await getJson(h, `/api/rooms/${roomId(3)}`, 404);
  assert.equal(await page.locator('#roomHeading').textContent(), '周末短途旅行');

  // Deleting the open room returns to a new discussion, here and on the server.
  await page.getByRole('button', { name: '删除「周末短途旅行」' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('#roomHeading', { hasText: '新的讨论' }).waitFor();
  await page.locator('#emptyState').waitFor();
  assert.equal(await page.locator('#messages .message').count(), 0);
  // The list is read again from the server.
  await entry(page, 1).waitFor({ state: 'detached' });
  assert.deepEqual(await shownTitles(page), ['架构评审']);
  await until(
    async () => (await getJson(h, '/api/preferences')).selectedRoomId === null,
    'the deleted room is no longer the selected one'
  );
  assertClean(session);
});

test('exporting downloads the discussion as the server writes it', TIMEOUT, async (t) => {
  const h = await harness(t);
  const title = 'A/B 方案对比';
  await seedRoom(
    dataDir(h),
    savedRoom(roomId(7), title, [
      ['user', 'question', 'A 和 B 选哪个？'],
      [
        'codex',
        'analysis',
        '倾向 **A**。',
        {
          provider: 'codex',
          model: 'mock-codex',
          durationMs: 4200,
          usage: { inputTokens: 10, outputTokens: 5 }
        }
      ],
      ['summary', 'summary', '结论：选 A。', { provider: 'claude', model: 'mock-claude' }]
    ])
  );
  const session = await openApp(t, browser, h);
  const { page } = session;
  assert.equal(await page.locator('#exportButton').isDisabled(), true);
  await openRoom(page, 7, title);
  // One export button: the top bar's, or on a narrow screen the sidebar's.
  const exportButtons = page.getByRole('button', { name: '导出当前讨论' });
  assert.equal(await exportButtons.count(), 1);
  assert.equal(await page.locator('#mobileExport').isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#exportButton').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '打开讨论记录' }).click();
  await page.locator('#mobileExport').waitFor();
  assert.equal(await exportButtons.count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('#sidebar.open').waitFor({ state: 'detached' });
  await page.setViewportSize({ width: 1280, height: 800 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#exportButton').click()
  ]);
  // Characters a file name cannot hold become "-".
  assert.equal(download.suggestedFilename(), 'A-B 方案对比.md');
  const saved = await fs.readFile(await download.path(), 'utf8');
  const response = await h.request(`/api/rooms/${roomId(7)}/export`);
  assert.equal(saved, await response.text());
  assert.ok(saved.startsWith(`# ${title}\n`), saved);
  for (const part of ['A 和 B 选哪个？', '倾向 **A**。', '结论：选 A。'])
    assert.ok(saved.includes(part), part);
  await page.locator('#toast', { hasText: '已导出当前讨论' }).waitFor();
  await assertReadable(page, 'after an export');
  assertClean(session);
});

test('answers render Markdown: links, autolinks, nested lists, tables and code', TIMEOUT, async (t) => {
  const h = await harness(t);
  const answer = [
    '## 结论',
    '',
    '参见 [官方文档](https://example.com/docs?a=1&b=2 "文档标题") 和 <https://example.org/auto>，' +
      '也可以直接打开 https://example.net/plain。',
    '',
    '危险链接 [不要点](javascript:alert(1)) 只显示文字。',
    '',
    '> 风险：',
    '> - 成本上升',
    '> - 工期延误',
    '',
    '1. 第一步',
    '   - 子项 A',
    '   - 子项 B',
    '     1. 更深一层',
    '2. 第二步',
    '',
    '| 方案 | 成本 | 风险 |',
    '| :--- | :---: | ---: |',
    '| A | 低 | **高** |',
    '| B | 中 | 低 |',
    '',
    '```js',
    'const total = 1 + 2;',
    '```',
    '',
    '<img src=x onerror="globalThis.injected = 1"> <script>globalThis.injected = 2</script>'
  ].join('\n');
  await seedRoom(
    dataDir(h),
    savedRoom(roomId(8), 'Markdown 渲染', [
      ['user', 'question', '**问题** 本身保持原文 <b>不渲染</b>'],
      ['claude', 'analysis', answer, { provider: 'claude', model: 'mock-claude' }]
    ])
  );
  const session = await openApp(t, browser, h);
  const { page } = session;
  await openRoom(page, 8, 'Markdown 渲染');
  const body = page.locator('#messages .message.provider[data-provider="claude"] .message-body');
  await body.locator('h2', { hasText: '结论' }).waitFor();

  const links = await body.locator('a').evaluateAll((list) =>
    list.map((link) => ({
      href: link.getAttribute('href'),
      text: link.textContent,
      title: link.title,
      target: link.target,
      rel: link.rel
    }))
  );
  const external = { target: '_blank', rel: 'noopener noreferrer' };
  assert.deepEqual(links, [
    { href: 'https://example.com/docs?a=1&b=2', text: '官方文档', title: '文档标题', ...external },
    { href: 'https://example.org/auto', text: 'https://example.org/auto', title: '', ...external },
    { href: 'https://example.net/plain', text: 'https://example.net/plain', title: '', ...external }
  ]);
  // A javascript: link stays text.
  await body.locator('p', { hasText: '危险链接 [不要点](javascript:alert(1)) 只显示文字。' }).waitFor();
  // A quote keeps its line breaks, so a quoted list does not run together.
  const quote = body.locator('blockquote');
  assert.equal(await quote.evaluate((node) => getComputedStyle(node).whiteSpace), 'pre-line');
  assert.equal(await quote.evaluate((node) => node.innerText), '风险：\n- 成本上升\n- 工期延误');

  // Nested lists: an ordered list holding a bullet list holding an ordered list.
  const outer = body.locator(':scope > ol');
  assert.equal(await outer.locator(':scope > li').count(), 2);
  assert.deepEqual(
    await outer
      .locator(':scope > li > ul > li')
      .evaluateAll((items) => items.map((item) => item.firstChild.textContent.trim())),
    ['子项 A', '子项 B']
  );
  assert.equal(await outer.locator(':scope > li > ul > li > ol > li').textContent(), '更深一层');

  // A table with the alignment of each column.
  const table = body.locator('.table-wrap table');
  assert.deepEqual(await table.locator('thead th').allTextContents(), ['方案', '成本', '风险']);
  assert.deepEqual(
    await table.locator('thead th').evaluateAll((cells) => cells.map((cell) => cell.dataset.align)),
    ['left', 'center', 'right']
  );
  assert.equal(await table.locator('tbody tr').count(), 2);
  assert.equal(await table.locator('tbody tr').first().locator('td strong').textContent(), '高');

  // A code block keeps its text and names its language.
  const code = body.locator('pre[data-lang="js"] code');
  assert.equal(await code.textContent(), 'const total = 1 + 2;');

  // Raw HTML stays text, in answers and questions alike.
  assert.equal(await body.locator('img, script').count(), 0);
  await body.locator('p', { hasText: '<img src=x onerror="globalThis.injected = 1">' }).waitFor();
  const question = page.locator('#messages .message.user .message-body');
  assert.equal(await question.textContent(), '**问题** 本身保持原文 <b>不渲染</b>');
  assert.equal(await page.locator('#messages b').count(), 0);
  assert.equal(await page.evaluate(() => globalThis.injected), undefined);
  await assertReadable(page, 'with rendered Markdown');
  assertClean(session);
});
