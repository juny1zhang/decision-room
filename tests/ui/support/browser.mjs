// Browser-test support: Chromium through the Playwright library, pages of the app served by
// tests/support/harness.mjs with its mock CLIs, and the checks every flow ends with: no console errors, page
// errors or Content-Security-Policy violations, and no visible text smaller than 11px.
/* global document, getComputedStyle, NodeFilter */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright';
import { delay } from '../../support/harness.mjs';

export { harness } from '../../support/harness.mjs';

/** Generous waits: a loaded CI machine runs Chromium, the server and its mock CLIs at once. */
const ACTION_TIMEOUT = 20000;

/** Launches headless Chromium: DECISION_ROOM_CHROMIUM when it names an executable, else Playwright's own. */
export function launchBrowser() {
  const { LANG, LC_ALL, LC_CTYPE } = process.env;
  return chromium.launch({
    executablePath: process.env.DECISION_ROOM_CHROMIUM || undefined,
    // Without a locale, Chromium on Linux cannot write non-ASCII file names and saves "download" instead.
    env: LANG || LC_ALL || LC_CTYPE ? process.env : { ...process.env, LANG: 'C.UTF-8' }
  });
}

/**
 * Opens the app of harness server `h` in a page that records console errors, page errors and CSP
 * violations in `problems`, and waits until every connection pill is ready and the room list has loaded.
 * Without `context` the page gets a new browser context (empty storage), closed after the test.
 * Resolves to { page, context, problems }.
 */
export async function openApp(t, browser, h, { context, ready = true } = {}) {
  if (!context) {
    context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
    t.after(() => context.close());
  }
  const page = await context.newPage();
  page.setDefaultTimeout(ACTION_TIMEOUT);
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console error: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  // Chromium also logs a violation to the console; the event says which directive was violated.
  await page.exposeFunction('reportCspViolation', (text) => problems.push(`CSP violation: ${text}`));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) =>
      globalThis.reportCspViolation(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline'}`)
    );
  });
  await page.goto(`${h.origin}/#${h.token}`);
  if (ready) await waitUntilReady(page);
  return { page, context, problems };
}

/** Waits until the health check found every mock CLI ready and the room list was read. */
export async function waitUntilReady(page) {
  await page.locator('#connectionPills .connection-pill.ready').first().waitFor();
  await page.locator('#connectionPills .connection-pill:not(.ready)').first().waitFor({ state: 'detached' });
  await page.locator('#roomList .history-empty, #roomList .room-items').first().waitFor();
  await page.locator('#roomList', { hasText: '正在读取' }).waitFor({ state: 'detached' });
}

/** Fails with the console errors, page errors and CSP violations `session` recorded, if any. */
export function assertClean({ problems }) {
  assert.deepEqual(problems, [], 'the page reported errors');
}

/**
 * The visible text drawn smaller than 11px: text nodes, the generated content of ::before and ::after
 * (avatars, captions), and the text of form fields. Text that is hidden, transparent or only for screen
 * readers (.sr-only) does not count.
 */
export function smallText(page) {
  return page.evaluate(() => {
    const MIN = 11;
    const small = [];
    const shown = (element) =>
      element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
      !element.closest('.sr-only');
    const sizeOf = (style) => Number.parseFloat(style.fontSize);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.data.trim() || !parent || !shown(parent)) continue;
      const size = sizeOf(getComputedStyle(parent));
      if (size < MIN) small.push(`${size}px "${node.data.trim().slice(0, 40)}"`);
    }
    for (const element of document.body.querySelectorAll('*')) {
      if (!shown(element)) continue;
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        if (['none', 'normal', '""', "''"].includes(style.content) || style.display === 'none') continue;
        if (sizeOf(style) < MIN) small.push(`${sizeOf(style)}px ${element.className}${pseudo}`);
      }
      if (element.matches('input:not([type=checkbox], [type=radio]), textarea, select')) {
        const size = sizeOf(getComputedStyle(element));
        if (size < MIN) small.push(`${size}px <${element.localName} id=${element.id}>`);
      }
    }
    return small;
  });
}

/** Fails when the page shows text smaller than 11px (see smallText); `where` names the page's state. */
export async function assertReadable(page, where) {
  assert.deepEqual(await smallText(page), [], `text below 11px ${where}`);
}

/**
 * Polls `check` (sync or async) until it returns a truthy value, which it resolves to, for server-side
 * state the page cannot be watched for. Rejects with `message` after `timeout` ms.
 */
export async function until(check, message, timeout = ACTION_TIMEOUT) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await delay(50);
  }
}

/** Reads a JSON answer of the server, failing unless the status is `status`. */
export async function getJson(h, route, status = 200) {
  const response = await h.request(route);
  assert.equal(response.status, status, `${route} answered ${response.status}`);
  return response.json();
}

/** A port nothing listens on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export const roomId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Writes `room` (with an `id`) into the rooms folder of data directory `dataDir`. */
export async function seedRoom(dataDir, room) {
  const dir = path.join(dataDir, 'rooms');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${room.id}.json`), JSON.stringify(room, null, 2));
}

/** A saved room with `messages`, made of [role, stage, text, extra?] tuples, all at `date`. */
export function savedRoom(id, title, messages, date = '2026-03-02T01:15:00.000Z') {
  return {
    id,
    title,
    createdAt: date,
    updatedAt: date,
    context: '',
    messages: messages.map(([role, stage, text, extra = {}], index) => ({
      id: `${title}-${index + 1}`,
      role,
      stage,
      text,
      createdAt: date,
      ...extra
    }))
  };
}
