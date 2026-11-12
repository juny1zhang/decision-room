// The page's provider list and connection wording (public/js/providers.js), which has no DOM dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROVIDERS,
  connectionName,
  connectionStatus,
  initialOf,
  isProviderId,
  readProviders
} from '../../public/js/providers.js';
import { PROVIDERS } from '../../src/providers/index.mjs';

test('the page shows the server registry until the first health response', () => {
  // The first paint uses the default list, so it must be the registry as the server ships it.
  assert.deepEqual(
    DEFAULT_PROVIDERS,
    PROVIDERS.map(({ id, label }) => ({ id, label }))
  );
});

test('a health response lists providers in registry order, each id once', () => {
  assert.deepEqual(
    readProviders([
      { id: 'claude', label: 'Claude' },
      { id: 'gemini', label: ' Gemini ' },
      { id: 'claude', label: 'Another' },
      { id: 'qwen-code' }
    ]),
    [
      { id: 'claude', label: 'Claude' },
      { id: 'gemini', label: 'Gemini' },
      { id: 'qwen-code', label: 'qwen-code' }
    ]
  );
});

test('malformed provider entries are skipped, and a list without any keeps the current one', () => {
  for (const id of ['', 'Codex', 'a b', '__proto__', '1abc', 'x'.repeat(41), 7, null, undefined])
    assert.equal(isProviderId(id), false, String(id));
  assert.equal(
    readProviders([null, 'codex', { id: 'Codex' }, { id: '<b>' }, { label: 'x' }, { id: 'ok', label: 5 }])
      .length,
    1
  );
  for (const list of [undefined, null, {}, 'codex', [], [{ id: 'Bad' }]])
    assert.equal(readProviders(list), null);
});

test('an avatar without a glyph shows the first character of the label', () => {
  assert.equal(initialOf('Gemini'), 'G');
  assert.equal(initialOf('  通义千问'), '通');
  assert.equal(initialOf('🦊 Fox'), '🦊');
  assert.equal(initialOf(''), '?');
  assert.equal(initialOf(undefined), '?');
});

test('a connection pill names its status in words as well as with its dot', () => {
  const health = {
    codex: { available: true, authenticated: true, subscription: true },
    claude: { available: true, authenticated: true, subscription: false },
    cursor: { available: false }
  };
  assert.deepEqual(connectionStatus(health, 'codex', true), { status: 'checking', text: '正在检查' });
  assert.deepEqual(connectionStatus(null, 'codex'), { status: 'offline', text: '未连接' });
  assert.deepEqual(connectionStatus(health, 'codex'), { status: 'ready', text: '已就绪' });
  assert.deepEqual(connectionStatus(health, 'claude'), { status: 'warning', text: '未就绪' });
  assert.deepEqual(connectionStatus(health, 'cursor'), { status: 'offline', text: '未找到工具' });
  assert.deepEqual(connectionStatus(health, 'gemini'), { status: 'offline', text: '未找到工具' });
  assert.equal(connectionName('Codex', '已就绪'), 'Codex：已就绪，查看连接状态');
});
