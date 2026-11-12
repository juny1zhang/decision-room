// Browser tests of the conversation: the first load, the "模型与能力" dialog, a "分别回答" round with live
// previews, stopping a hanging call and "重试未完成的部分" after a failed one. The server runs the mock CLIs
// of tests/support/mock-cli.mjs; every flow ends without console errors, page errors or CSP violations.
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
  until
} from './support/browser.mjs';

const TIMEOUT = { timeout: 90000 };
let browser;

before(async () => {
  browser = await launchBrowser();
});
after(() => browser?.close());

/** Whether process `pid` still runs. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Switches the composer to `mode` (the button's text), types `prompt` and sends it; resolves to the body. */
async function ask(page, mode, prompt) {
  await page.getByRole('button', { name: mode, exact: true }).click();
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

test('the first load shows every tool as ready, by name and by status', TIMEOUT, async (t) => {
  const h = await harness(t);
  const session = await openApp(t, browser, h);
  const { page } = session;
  // The access token leaves the address bar.
  assert.equal(new URL(page.url()).hash, '');
  // One pill per provider of the server's registry, in its order, named by provider and status.
  const { providers } = await getJson(h, '/api/health');
  const pills = page.locator('#connectionPills .connection-pill');
  assert.deepEqual(
    await pills.evaluateAll((list) => list.map((pill) => pill.dataset.provider)),
    providers.map(({ id }) => id)
  );
  for (const { label } of providers)
    await page.getByRole('button', { name: `${label}：已就绪，查看连接状态`, exact: true }).waitFor();
  // Until a choice is made, a debate between the first two connected tools.
  assert.deepEqual(
    await page.locator('#activeParticipants .participant').allTextContents(),
    providers.slice(0, 2).map(({ label }) => label)
  );
  assert.equal(await page.getByRole('button', { name: '联合讨论' }).getAttribute('aria-pressed'), 'true');
  await page.locator('#roomList', { hasText: '你的讨论会保存在这里。' }).waitFor();
  assert.equal(await page.locator('#sendButton').isDisabled(), true);
  await page.locator('#prompt').fill('先比较两个方案的成本');
  assert.equal(await page.locator('#sendButton').isEnabled(), true);
  // The focused prompt shows a ring of the composer in the page's green, 6.4:1 on white.
  await page.locator('#prompt').focus();
  assert.equal(
    await page.locator('#composer').evaluate((form) => getComputedStyle(form).borderTopColor),
    'rgb(39, 105, 91)'
  );
  await assertReadable(page, 'on the first load');

  // A pill opens the connection dialog, which also names the ignored API-key variables.
  await page.getByRole('button', { name: 'Claude：已就绪，查看连接状态' }).click();
  const dialog = page.locator('#healthDialog');
  await dialog.waitFor();
  assert.deepEqual(
    await dialog.locator('.health-badge.ok').allTextContents(),
    providers.map(() => '账号登录已就绪')
  );
  await dialog.locator('.health-note', { hasText: 'OPENAI_API_KEY' }).waitFor();
  await assertReadable(page, 'in the connection dialog');
  await page.getByRole('button', { name: '关闭工具连接' }).click();
  await dialog.waitFor({ state: 'hidden' });

  // A narrow screen, with the sidebar drawer open.
  await page.setViewportSize({ width: 390, height: 844 });
  await assertReadable(page, 'on a narrow screen');
  await page.getByRole('button', { name: '打开讨论记录' }).click();
  await page.locator('#sidebar.open').waitFor();
  await assertReadable(page, 'in the sidebar drawer');
  // Focus does not reach the page the drawer covers, and Escape closes the drawer wherever focus is.
  for (let step = 0; step < 6; step++) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('.main'))), false);
  }
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await page.locator('#sidebar.open').waitFor({ state: 'detached' });
  await focusOn(page, 'menuButton');
  assertClean(session);

  // The guard does see a violation: a <style> element, which the policy refuses.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = 'body { color: red; }';
    document.head.append(style);
  });
  await until(
    () => session.problems.some((problem) => problem.startsWith('CSP violation: style-src')),
    'the test sees a CSP violation'
  );
  session.problems.length = 0;
});

test(
  'the configuration dialog applies participants, models, reasoning and capability',
  TIMEOUT,
  async (t) => {
    const h = await harness(t);
    const session = await openApp(t, browser, h);
    const { page } = session;
    const dialog = page.locator('#configDialog');
    await page.getByRole('button', { name: '模型与能力' }).click();
    await dialog.waitFor();
    await dialog
      .locator('#participantHint', { hasText: '选择两到三位参与者，可分别设置模型和能力。' })
      .waitFor();
    assert.deepEqual(await dialog.locator('.provider-state').allTextContents(), [
      '已登录',
      '已登录',
      '已登录'
    ]);
    assert.equal(await page.locator('#participant-codex').isChecked(), true);
    assert.equal(await page.locator('#participant-claude').isChecked(), true);
    assert.equal(await page.locator('#participant-cursor').isChecked(), false);

    // A debate needs two participants. (The cards are rendered again on every change, so click, not check.)
    await page.locator('#participant-claude').click();
    await dialog.locator('#configCount', { hasText: '此模式至少需要两位参与者' }).waitFor();
    assert.equal(await page.locator('#applyConfig').isDisabled(), true);
    await page.locator('#participant-claude').click();
    await page.locator('#participant-cursor').click();
    await dialog.locator('#configCount', { hasText: '已选 3 位参与者' }).waitFor();
    // Every card has the same fields; their names say whose they are.
    for (const name of ['Codex 模型', 'Claude 分析能力', 'Cursor 模型'])
      await dialog.getByRole('combobox', { name, exact: true }).waitFor();
    assert.equal(await dialog.getByRole('combobox', { name: '模型', exact: true }).count(), 0);

    // Codex: a listed model and its reasoning levels.
    await page.locator('#model-codex').selectOption('mock-codex');
    assert.deepEqual(await page.locator('#reasoning-codex option').allTextContents(), [
      'CLI 默认强度',
      'low',
      'medium',
      'high'
    ]);
    await page.locator('#reasoning-codex').selectOption('high');
    // A status check that fails while the dialog is open clears the page's health. The cards, drawn again
    // on the next change, keep the listed model and the reasoning level chosen here.
    await page.evaluate(async () => {
      const { state } = await import('/js/state.js');
      state.health = null;
    });
    await page.locator('#participant-cursor').click();
    await page.locator('#participant-cursor').click();
    await dialog.locator('#configCount', { hasText: '已选 3 位参与者' }).waitFor();
    assert.equal(await page.locator('#model-codex').inputValue(), 'mock-codex');
    assert.equal(await page.locator('#reasoning-codex').inputValue(), 'high');
    await page.evaluate(async () => (await import('/js/health.js')).checkHealth());
    // Claude: a model without reasoning levels hides the field; a capability shows its description.
    await page.locator('#model-claude').selectOption('haiku');
    await page.locator('#reasoning-claude').waitFor({ state: 'hidden' });
    await page.locator('#capability-claude').selectOption({ label: '风险审查' });
    await dialog
      .locator('[data-provider="claude"] .capability-note', { hasText: '识别主要风险、预警信号和应对办法。' })
      .waitFor();
    // Cursor: a model ID typed by hand.
    await page.locator('#model-cursor').selectOption('__custom');
    const custom = page.getByRole('textbox', { name: 'Cursor 自定义模型 ID' });
    await custom.waitFor();
    assert.equal(await custom.evaluate((input) => input === document.activeElement), true);
    await custom.fill('cursor-custom-1');
    await page.getByLabel('归纳主持人').selectOption('claude');
    await assertReadable(page, 'in the configuration dialog');
    await page.getByRole('button', { name: '应用设置' }).click();
    await dialog.waitFor({ state: 'hidden' });

    await page.locator('#modeHelp', { hasText: 'Codex、Claude、Cursor · Claude 归纳' }).waitFor();
    assert.deepEqual(await page.locator('#activeParticipants .participant').allTextContents(), [
      'Codex',
      'Claude',
      'Cursor'
    ]);
    const expected = {
      mode: 'debate',
      participants: ['codex', 'claude', 'cursor'],
      moderator: 'claude',
      settings: {
        codex: { model: 'mock-codex', reasoning: 'high', capability: 'general' },
        claude: { model: 'haiku', reasoning: '', capability: 'risk' },
        cursor: { model: 'cursor-custom-1', reasoning: '', capability: 'general' }
      },
      webSearch: false
    };
    // The server keeps the applied configuration for the next visit.
    const saved = await until(async () => {
      const { configuration } = await getJson(h, '/api/preferences');
      return configuration?.moderator === 'claude' && configuration;
    }, 'the configuration is saved on the server');
    assert.deepEqual(saved, expected);

    // Closing the dialog without applying discards its changes.
    await page.getByRole('button', { name: '模型与能力' }).click();
    assert.equal(await page.locator('#custom-cursor').inputValue(), 'cursor-custom-1');
    assert.equal(await page.locator('#reasoning-codex').inputValue(), 'high');
    await page.locator('#participant-cursor').click();
    await dialog.locator('#configCount', { hasText: '已选 2 位参与者' }).waitFor();
    await page.getByRole('button', { name: '关闭模型与能力' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#activeParticipants .participant').count(), 3);

    // A round is asked with the applied configuration, and the chosen moderator sums it up.
    await page.locator('#prompt').fill('三位一起评估这个方案');
    const [request] = await Promise.all([
      page.waitForRequest((request) => request.url().endsWith('/api/run')),
      page.getByRole('button', { name: '开始讨论' }).click()
    ]);
    const { prompt, context, roomId, ...sent } = request.postDataJSON();
    assert.deepEqual(sent, expected);
    assert.equal(prompt, '三位一起评估这个方案');
    assert.equal(context, '');
    assert.equal(roomId, null);
    await page.locator('#messages .message.summary .speaker', { hasText: 'Claude · 主持人总结' }).waitFor();
    await roundEnded(page);
    assertClean(session);
  }
);

test('分别回答 shows live previews that the final answers replace', TIMEOUT, async (t) => {
  const h = await harness(t, {
    codex: { answer: '**Codex** 建议选 A：成本更低。', streamDelayMs: 300 },
    claude: { answer: '## Claude 的看法\n\n选 B，风险更小。', streamDelayMs: 300 }
  });
  const session = await openApp(t, browser, h);
  const { page } = session;
  // Every preview card added, kept even after its answer replaced it, and the state of the messages' live
  // region as each message was added.
  await page.evaluate(() => {
    globalThis.previewCards = [];
    globalThis.liveWhenAdded = [];
    const list = document.getElementById('messages');
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes) {
          if (node.dataset?.preview) globalThis.previewCards.push(node);
          if (record.target === list && node.classList?.contains('message'))
            globalThis.liveWhenAdded.push(list.getAttribute('aria-live'));
        }
    }).observe(document.getElementById('conversation'), { childList: true, subtree: true });
  });

  const body = await ask(page, '分别回答', '选方案 A 还是 B？');
  assert.equal(body.mode, 'both');
  assert.deepEqual(body.participants, ['codex', 'claude']);
  // While the answers are written, the composer is locked and the round can be stopped.
  await page.locator('#livePreviews .message.preview').first().waitFor();
  assert.equal(await page.getByRole('button', { name: '停止讨论' }).isVisible(), true);
  assert.equal(await page.locator('#prompt').isDisabled(), true);
  await assertReadable(page, 'with live previews');

  const codex = page.locator('#messages .message.provider[data-provider="codex"]');
  const claude = page.locator('#messages .message.provider[data-provider="claude"]');
  await codex.locator('.message-body strong', { hasText: 'Codex' }).waitFor();
  await claude.locator('.message-body h2', { hasText: 'Claude 的看法' }).waitFor();
  await roundEnded(page);
  assert.equal(await page.locator('#livePreviews .message').count(), 0);
  assert.equal(await page.locator('#messages .message.preview').count(), 0);
  // The question and both answers were announced as they arrived.
  assert.deepEqual(await page.evaluate(() => globalThis.liveWhenAdded), ['polite', 'polite', 'polite']);

  const previews = await page.evaluate(() =>
    globalThis.previewCards.map((card) => ({
      key: card.dataset.preview,
      provider: card.dataset.provider,
      busy: card.getAttribute('aria-busy'),
      label: card.querySelector('.preview-label')?.textContent,
      written: card.querySelector('.message-body').textContent.length > 0
    }))
  );
  assert.deepEqual(
    previews.sort((a, b) => a.key.localeCompare(b.key)),
    ['claude', 'codex'].map((id) => ({
      key: `${id}:analysis`,
      provider: id,
      busy: 'true',
      label: '生成中…',
      written: true
    }))
  );

  // Each answer notes its time and tokens.
  const note = (card) => card.locator('.message-note').textContent();
  assert.match(await note(codex), /用时.* · 输入 12,345（缓存 2,048）\/ 输出 1,234 tokens$/);
  assert.match(await note(claude), /用时.* · 输入 4,320（缓存 4,000）\/ 输出 456 tokens$/);
  // The question keeps how it was asked.
  const question = page.locator('#messages .message.user');
  assert.equal(await question.locator('.message-body').textContent(), '选方案 A 还是 B？');
  await question.locator('.turn-settings summary').click();
  await question.locator('.turn-settings', { hasText: '分别回答 · 网页检索关闭' }).waitFor();
  // The new room is open and listed.
  const heading = await page.locator('#roomHeading').textContent();
  assert.notEqual(heading, '新的讨论');
  await page.locator('.room-item[aria-current="true"] .room-item-title', { hasText: heading }).waitFor();
  assert.equal(await page.locator('#sendLabel').textContent(), '继续讨论');
  await assertReadable(page, 'after a round');
  assertClean(session);
});

test('停止讨论 ends a hanging call and keeps the answers already given', TIMEOUT, async (t) => {
  const h = await harness(t, { claude: { hang: true } });
  const session = await openApp(t, browser, h);
  const { page } = session;
  // Sent from the keyboard: focus moves to the stop button, as the prompt is locked during the round.
  await page.getByRole('button', { name: '分别回答', exact: true }).click();
  await page.locator('#prompt').fill('这个决定有哪些风险？');
  await Promise.all([
    page.waitForRequest((request) => request.url().endsWith('/api/run')),
    page.locator('#prompt').press('Control+Enter')
  ]);
  await focusOn(page, 'stopButton');
  await page.locator('#messages .message.provider[data-provider="codex"]').waitFor();
  const hanging = await until(
    async () => (await h.calls()).find((call) => call.provider === 'claude'),
    'Claude is called'
  );
  // The room of the running discussion is marked, and can be neither renamed nor deleted meanwhile.
  const { runningRoomId } = await until(async () => {
    const rooms = await getJson(h, '/api/rooms');
    return rooms.runningRoomId && rooms;
  }, 'the server names the running room');
  const entry = page.locator(`.room-entry[data-room-id="${runningRoomId}"]`);
  await entry.locator('.room-item-running').waitFor();
  assert.equal(await entry.locator('.room-action.rename').isDisabled(), true);
  assert.equal(await entry.locator('.room-action.delete').isDisabled(), true);
  assert.equal(await page.locator('#newRoom').isDisabled(), true);
  await assertReadable(page, 'while a discussion runs');

  await focusOn(page, 'stopButton');
  await page.keyboard.press('Enter');
  await page
    .locator('#messages .message.system', { hasText: '讨论已停止。已完成的回答保留；未完成的调用已终止。' })
    .waitFor();
  await roundEnded(page);
  // The stop button is gone: focus is back in the prompt, ready for a follow-up question.
  await focusOn(page, 'prompt');
  await until(() => !alive(hanging.pid), 'the hanging CLI ends');
  await entry.locator('.room-item-running').waitFor({ state: 'hidden' });
  assert.equal(await entry.locator('.room-action.rename').isEnabled(), true);
  assert.equal(await page.locator('#prompt').isEnabled(), true);
  assert.equal(await page.locator('#errorBanner').isHidden(), true);
  // Claude's answer is missing, so the turn can be finished later.
  await page.getByRole('button', { name: '重试未完成的部分' }).waitFor();
  const room = await getJson(h, `/api/rooms/${runningRoomId}`);
  assert.deepEqual(
    room.messages.map((message) => `${message.role}:${message.stage}`),
    ['user:question', 'codex:analysis', 'system:notice']
  );
  assertClean(session);
});

test('重试未完成的部分 runs only what a failed call left out', TIMEOUT, async (t) => {
  const h = await harness(t, { codex: { answer: 'Codex 的分析' }, claude: { fail: true } });
  const session = await openApp(t, browser, h);
  const { page } = session;
  await ask(page, '分别回答', '要不要换工作？');
  await page.locator('#messages .message.system', { hasText: 'Claude 分析失败：' }).waitFor();
  await roundEnded(page);
  const resumeButton = page.getByRole('button', { name: '重试未完成的部分' });
  await resumeButton.waitFor();
  await assertReadable(page, 'with the resume button');

  await h.setControl({ claude: { answer: 'Claude 补上的分析' } });
  // A draft in the composer is left alone.
  await page.locator('#prompt').fill('下一个问题的草稿');
  const [request] = await Promise.all([
    page.waitForRequest((request) => request.url().endsWith('/api/run')),
    resumeButton.click()
  ]);
  const { roomId, resumeTurnId, ...rest } = request.postDataJSON();
  assert.deepEqual(rest, {});
  await page
    .locator('#messages .message.provider[data-provider="claude"]', { hasText: 'Claude 补上的分析' })
    .waitFor();
  await roundEnded(page);
  await page.locator('#resumeBar').waitFor({ state: 'hidden' });
  // Focus went to the stop button while the turn ran, and then to the prompt.
  await focusOn(page, 'prompt');
  assert.equal(await page.locator('#messages .message.user').count(), 1);
  assert.equal(await page.locator('#prompt').inputValue(), '下一个问题的草稿');

  // Only Claude was asked again, and every message belongs to the one turn.
  const calls = await h.calls();
  assert.deepEqual(calls.map((call) => call.provider).sort(), ['claude', 'claude', 'codex']);
  const room = await getJson(h, `/api/rooms/${roomId}`);
  assert.deepEqual(room.messages.map((message) => `${message.role}:${message.stage}`).sort(), [
    'claude:analysis',
    'codex:analysis',
    'system:error',
    'user:question'
  ]);
  assert.equal(room.messages[0].id, resumeTurnId);
  assert.ok(room.messages.every((message) => message.turnId === resumeTurnId));
  assertClean(session);
});
