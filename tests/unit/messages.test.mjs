import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultModel, speakerName } from '../../src/messages.mjs';

test('speakerName names people, providers and status messages', () => {
  assert.equal(speakerName({ role: 'user' }), '你');
  assert.equal(speakerName({ role: 'system' }), '状态说明');
  assert.equal(speakerName({ role: 'codex' }), 'Codex');
  assert.equal(speakerName({ role: 'claude' }), 'Claude');
  assert.equal(speakerName({ role: 'cursor' }), 'Cursor');
  assert.equal(speakerName({ role: 'someone-else' }), 'someone-else');
});

test('speakerName attributes summaries to their moderator, and legacy summaries to Codex', () => {
  assert.equal(speakerName({ role: 'summary', provider: 'cursor' }), '决策归纳（Cursor）');
  assert.equal(speakerName({ role: 'summary', provider: 'claude' }), '决策归纳（Claude）');
  // Version 1 rooms: Codex always moderated and the summary had no provider field.
  assert.equal(speakerName({ role: 'summary', model: 'codex' }), '决策归纳（Codex）');
});

test('resultModel ignores the provider id that legacy summaries stored as their model', () => {
  assert.equal(resultModel({ role: 'summary', model: 'codex' }), '');
  assert.equal(resultModel({ role: 'summary', provider: 'codex', model: 'gpt-5' }), 'gpt-5');
  assert.equal(
    resultModel({ role: 'claude', provider: 'claude', model: 'claude-sonnet-4-5' }),
    'claude-sonnet-4-5'
  );
  assert.equal(resultModel({ role: 'codex' }), '');
  assert.equal(resultModel({ role: 'user', text: '问题' }), '');
});
