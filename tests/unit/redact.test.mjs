import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeDetail, stripAnsi } from '../../src/redact.mjs';

test('safeDetail hides API keys, session ids and bearer tokens', () => {
  assert.equal(safeDetail('key sk-proj-abcdefgh1234 rejected'), 'key [credential hidden] rejected');
  assert.equal(safeDetail('SK-ABCDEFGH1234'), '[credential hidden]');
  assert.equal(safeDetail('session sess-AbCdEfGh12/34'), 'session [credential hidden]');
  assert.equal(safeDetail('Authorization: Bearer abc.def-123_456+/x'), 'Authorization: [credential hidden]');
  assert.equal(safeDetail('authorization: bearer   abcdefgh'), 'authorization: [credential hidden]');
});

test('safeDetail keeps prefixes that are too short to be credentials', () => {
  assert.equal(safeDetail('sk-short and Bearer abc'), 'sk-short and Bearer abc');
  assert.equal(safeDetail('risk-assessment'), 'risk-assessment');
});

test('safeDetail hides JSON web tokens and e-mail addresses', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl_-x';
  assert.equal(safeDetail(`token ${jwt} expired`), 'token [token hidden] expired');
  assert.equal(safeDetail('Logged in as Private.User+cli@Example.co.uk'), 'Logged in as [account]');
});

test('safeDetail removes colour codes and keeps at most 1200 characters', () => {
  assert.equal(safeDetail('\u001b[1;31merror\u001b[0m: failed'), 'error: failed');
  assert.equal(safeDetail('x'.repeat(5000)).length, 1200);
  assert.equal(safeDetail('数'.repeat(1300)), '数'.repeat(1200));
});

test('safeDetail turns missing values into an empty string and other values into text', () => {
  for (const value of [undefined, null, '', 0, false]) assert.equal(safeDetail(value), '');
  assert.equal(safeDetail(404), '404');
});

test('stripAnsi removes only colour escape sequences', () => {
  assert.equal(stripAnsi('\u001b[32mgpt-5\u001b[0m - GPT-5'), 'gpt-5 - GPT-5');
  assert.equal(stripAnsi('plain [32m text'), 'plain [32m text');
});
