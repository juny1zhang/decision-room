// Browser tests of goal mode (目标模式): choosing it with its moderator and "最多几版", a turn whose plan is
// revised once before everyone approves it, with the stage named in the progress and the previews, the
// verdict badges and the 最终方案 badge, also after a reload; and a turn whose failed feedback is finished by
// "重试未完成的部分", which then stops at its cap and goes on with "继续磨合". The mock CLIs of
// tests/support/mock-cli.mjs end their feedback with the verdicts the tests set.
/* global document, getComputedStyle, MutationObserver */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertClean,
  assertReadable,
  getJson,
  harness,
  launchBrowser,
  openApp,
  until,
  waitUntilReady
} from './support/browser.mjs';

const TIMEOUT = { timeout: 90000 };
let browser;

before(async () => {
  browser = await launchBrowser();
});
after(() => browser?.close());

/** Types `prompt` into the composer and sends it; resolves to the /api/run body. */
async function send(page, prompt) {
  await page.locator('#prompt').fill(prompt);
  const [request] = await Promise.all([
    page.waitForRequest((request) => request.url().endsWith('/api/run')),
    page.locator('#sendButton').click()
  ]);
  return request.postDataJSON();
}

/** Waits until the round has ended: the send button is back. */
const roundEnded = (page) => page.locator('#sendButton').waitFor();

/** Waits until keyboard focus is on the element with `id`. */
const focusOn = (page, id) =>
  until(() => page.evaluate((id) => document.activeElement?.id === id, id), `focus is on #${id}`);

/** The WCAG contrast ratio of two CSS colours given as "rgb(r, g, b)". */
function contrast(...colours) {
  const [lighter, darker] = colours
    .map((colour) => {
      const [r, g, b] = colour
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map((value) => {
          const channel = Number(value) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    })
    .sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

test('目标模式 revises the plan until everyone approves it and marks the final plan', TIMEOUT, async (t) => {
  // Claude moderates; Codex reviews, asking for changes to version 1 and approving version 2.
  const h = await harness(t, {
    codex: { verdicts: ['revise', 'approve'], streamDelayMs: 120 },
    claude: { streamDelayMs: 120 }
  });
  const session = await openApp(t, browser, h);
  const { page } = session;
  // Every text the progress line showed, and the stage label of every preview card.
  await page.evaluate(() => {
    globalThis.progressTexts = [];
    globalThis.previewStages = [];
    const progress = document.getElementById('progressText');
    new MutationObserver(() => globalThis.progressTexts.push(progress.textContent)).observe(progress, {
      childList: true,
      characterData: true,
      subtree: true
    });
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node.dataset?.preview)
            globalThis.previewStages.push(
              `${node.dataset.preview} ${node.querySelector('.stage-label')?.textContent}`
            );
    }).observe(document.getElementById('conversation'), { childList: true, subtree: true });
  });

  // The mode, "最多几版" beside it, the placeholder and the captions.
  const rounds = page.getByRole('combobox', { name: '方案最多几版' });
  assert.equal(await rounds.isHidden(), true);
  await page.getByRole('button', { name: '目标模式' }).click();
  assert.equal(await page.getByRole('button', { name: '目标模式' }).getAttribute('aria-pressed'), 'true');
  assert.equal(await rounds.inputValue(), '3');
  assert.equal(
    await page.locator('#prompt').getAttribute('placeholder'),
    '写下要达成的目标，以及怎样算完成…'
  );
  await page.locator('#modeHelp', { hasText: 'Codex、Claude · Codex 主持 · 最多 3 版' }).waitFor();
  await rounds.selectOption('4');
  await page.locator('#flowDescription', { hasText: '直到全员认可，最多 4 版。' }).waitFor();
  // The moderator is chosen as for a debate.
  await page.getByRole('button', { name: '模型与能力' }).click();
  await page.getByLabel('方案主持人').selectOption('claude');
  await page.getByRole('button', { name: '应用设置' }).click();
  await page.locator('#modeHelp', { hasText: 'Codex、Claude · Claude 主持 · 最多 4 版' }).waitFor();
  await assertReadable(page, 'in goal mode');

  const body = await send(page, '三个月内把首页加载时间降到 2 秒以内。完成标准：移动端 P75 低于 2 秒。');
  assert.deepEqual(
    {
      mode: body.mode,
      participants: body.participants,
      moderator: body.moderator,
      maxRounds: body.maxRounds
    },
    { mode: 'goal', participants: ['codex', 'claude'], moderator: 'claude', maxRounds: 4 }
  );
  await page.locator('#messages .message.system', { hasText: '全员认可方案 v2，目标模式结束。' }).waitFor();
  await roundEnded(page);

  // Proposals, then each version of the plan and Codex's feedback on it.
  assert.deepEqual(await page.locator('#messages .message .stage-label').allTextContents(), [
    '独立方案',
    '独立方案',
    '方案 v1',
    '评审方案 v1',
    '方案 v2',
    '评审方案 v2',
    '提示'
  ]);
  const plans = page.locator('#messages .message.plan');
  assert.deepEqual(await plans.locator('.speaker').allTextContents(), ['Claude · 主持人', 'Claude · 主持人']);
  // Only the version everyone approved is the final plan.
  assert.equal(await plans.nth(0).locator('.plan-badge').isHidden(), true);
  assert.equal(await plans.nth(1).locator('.plan-badge').textContent(), '最终方案');
  assert.equal(await plans.nth(1).locator('.plan-badge').isVisible(), true);
  // A verdict is told in words, with its conclusion for screen readers; its mark is decoration.
  const verdicts = page.locator('#messages .verdict-badge');
  assert.deepEqual(await verdicts.allTextContents(), ['结论：✎需修改', '结论：✓认可']);
  assert.deepEqual(await verdicts.locator('.sr-only').allTextContents(), ['结论：', '结论：']);
  assert.deepEqual(
    await verdicts
      .locator('.verdict-mark')
      .evaluateAll((marks) => marks.map((mark) => mark.getAttribute('aria-hidden'))),
    ['true', 'true']
  );
  // Every badge meets WCAG AA contrast.
  const colours = await page
    .locator('#messages .verdict-badge, #messages .plan-badge:not([hidden])')
    .evaluateAll((badges) =>
      badges.map((badge) => [getComputedStyle(badge).color, getComputedStyle(badge).backgroundColor])
    );
  assert.equal(colours.length, 3);
  for (const [colour, background] of colours)
    assert.ok(contrast(colour, background) >= 4.5, `${colour} on ${background}`);

  // The progress line and the previews named the stage and the version.
  const progress = await page.evaluate(() => globalThis.progressTexts);
  for (const text of [
    'Codex 正在提出方案',
    'Claude 正在整理方案 v1',
    'Codex 正在评审方案 v1',
    'Claude 正在整理方案 v2',
    'Codex 正在评审方案 v2'
  ])
    assert.ok(
      progress.some((shown) => shown.includes(text)),
      text
    );
  const previews = await page.evaluate(() => globalThis.previewStages);
  for (const preview of ['claude:draft 方案 v1', 'claude:draft 方案 v2', 'codex:feedback 评审方案 v2'])
    assert.ok(previews.includes(preview), preview);
  assert.equal(await page.locator('#livePreviews .message').count(), 0);

  // The turn is complete: nothing to resume. The question keeps how it was asked.
  assert.equal(await page.locator('#resumeBar:not([hidden])').count(), 0);
  const question = page.locator('#messages .message.user');
  await question.locator('.turn-settings summary').click();
  await question
    .locator('.turn-settings', { hasText: '目标模式 · Claude 主持 · 最多 4 版 · 网页检索关闭' })
    .waitFor();
  await assertReadable(page, 'after a goal turn');

  // Reopened, the room shows the same badges, and the composer the same mode and "最多几版".
  await page.reload();
  await waitUntilReady(page);
  await page.locator('#messages .message.plan.final .stage-label', { hasText: '方案 v2' }).waitFor();
  assert.equal(await page.locator('#messages .plan-badge:not([hidden])').count(), 1);
  assert.equal(await page.locator('#messages .verdict-badge').count(), 2);
  assert.equal(await rounds.inputValue(), '4');
  assertClean(session);
});

test('a failed feedback offers 重试未完成的部分, and a turn at its cap 继续磨合', TIMEOUT, async (t) => {
  // Codex moderates; Claude answers its proposal, then fails its first feedback and asks for changes.
  const h = await harness(t, {
    claude: { failOnce: { after: 1, stderr: 'Error: boom' }, verdicts: 'revise' }
  });
  const session = await openApp(t, browser, h);
  const { page } = session;
  await page.getByRole('button', { name: '目标模式' }).click();
  await page.getByRole('combobox', { name: '方案最多几版' }).selectOption('1');
  await send(page, '下个月搬完家。完成标准：月底前住进新家。');
  await page.locator('#messages .message.system', { hasText: 'Claude 未完成对方案 v1 的评审' }).waitFor();
  await roundEnded(page);

  // Interrupted: the missing feedback can be asked for again.
  const retry = page.getByRole('button', { name: '重试未完成的部分' });
  await retry.waitFor();
  await page
    .locator('#resumeBar .resume-hint', { hasText: '只重新运行这一轮缺少的方案、评审或修改' })
    .waitFor();
  const [retried] = await Promise.all([
    page.waitForRequest((request) => request.url().endsWith('/api/run')),
    retry.click()
  ]);
  assert.deepEqual(Object.keys(retried.postDataJSON()).sort(), ['resumeTurnId', 'roomId']);
  await page
    .locator('#messages .message.system', { hasText: '已达到最多 1 版，方案 v1 仍未获得全员认可' })
    .waitFor();
  await roundEnded(page);

  // At its cap: only 继续磨合 goes on, and says how many more versions it allows.
  const more = page.getByRole('button', { name: '继续磨合' });
  await more.waitFor();
  assert.equal(await retry.count(), 0);
  assert.equal(
    await page.locator('#resumeBar .resume-hint').textContent(),
    '已达到最多 1 版，仍有参与者认为需要修改。继续磨合会在当前方案的基础上再修改最多 1 版。'
  );
  assert.equal(await page.locator('#messages .verdict-badge').textContent(), '结论：✎需修改');
  assert.equal(await page.locator('#messages .plan-badge:not([hidden])').count(), 0);
  await assertReadable(page, 'with 继续磨合');

  await h.setControl({ claude: { verdicts: 'approve' } });
  const [request] = await Promise.all([
    page.waitForRequest((request) => request.url().endsWith('/api/run')),
    more.click()
  ]);
  const { roomId, resumeTurnId, ...rest } = request.postDataJSON();
  assert.deepEqual(rest, { moreRounds: true });
  await page.locator('#messages .message.plan.final .stage-label', { hasText: '方案 v2' }).waitFor();
  await roundEnded(page);
  await page.locator('#resumeBar').waitFor({ state: 'hidden' });
  // Focus went to the stop button while the turn ran, and then to the prompt.
  await focusOn(page, 'prompt');
  assert.equal(await page.locator('#messages .message.user').count(), 1);

  const room = await getJson(h, `/api/rooms/${roomId}`);
  assert.deepEqual(
    room.messages.filter((message) => message.stage === 'draft').map(({ version, cap }) => [version, cap]),
    [
      [1, 1],
      [2, 2]
    ]
  );
  assert.ok(room.messages.every((message) => message.turnId === resumeTurnId));
  assertClean(session);
});
