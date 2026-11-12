import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDERS,
  PROVIDER_IDS,
  getProvider,
  isProviderId,
  providerLabel
} from '../../src/providers/index.mjs';

test('the registry lists Codex, Claude and Cursor in display order', () => {
  assert.deepEqual(PROVIDER_IDS, ['codex', 'claude', 'cursor']);
  assert.deepEqual(
    PROVIDERS.map((provider) => provider.label),
    ['Codex', 'Claude', 'Cursor']
  );
  assert.deepEqual(getProvider('cursor').binaries, ['cursor-agent', 'agent']);
  assert.equal(getProvider('cursor').missingHint, 'Cursor Agent（cursor-agent 或 agent）');
  assert.equal(providerLabel('claude'), 'Claude');
  assert.equal(providerLabel('other'), undefined);
  assert.equal(isProviderId('codex'), true);
  for (const value of ['Codex', 'toString', '__proto__', '', 5, undefined])
    assert.equal(isProviderId(value), false);
});

test('every provider implements the provider interface', () => {
  for (const provider of PROVIDERS) {
    assert.match(provider.id, /^[a-z]+$/);
    assert.equal(typeof provider.label, 'string');
    assert.ok(provider.binaries.length > 0 && provider.binaries.every((name) => typeof name === 'string'));
    assert.equal(typeof provider.missingHint, 'string');
    assert.ok(provider.envDenylist.every((key) => /^[A-Z_]+$/.test(key)));
    assert.ok(
      provider.apiKeyEnv.every((key) => provider.envDenylist.includes(key)),
      `${provider.id}: API key variables are also removed from the CLI environment`
    );
    assert.equal(typeof provider.supportsWeb, 'boolean');
    assert.equal(typeof provider.inspect, 'function');
    assert.equal(typeof provider.invoke, 'function');
  }
});
