// The page's selection state (public/js/state.js) while the provider registry is not known yet and once a
// health response has listed it. state.js runs in the browser, so the few globals it reaches are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const memoryStorage = () => {
  const items = new Map();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key)
  };
};
const webSearch = { checked: false };
Object.assign(globalThis, {
  location: { hash: '', pathname: '/', search: '' },
  history: { replaceState() {} },
  localStorage: memoryStorage(),
  sessionStorage: memoryStorage(),
  addEventListener() {},
  document: { getElementById: (id) => (id === 'webSearch' ? webSearch : null) }
});

let instance = 0;
/** A fresh copy of state.js: its registry and selection start over. */
const freshState = () => import(`../../public/js/state.js?case=${++instance}`);
const registry = (...ids) => ids.map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) }));
const saved = (mode, participants, moderator = participants[0]) => ({
  mode,
  participants,
  moderator,
  settings: { gemini: { model: 'gemini-pro', reasoning: 'high', capability: 'general' } },
  webSearch: true
});

test('before the registry is known, a saved selection keeps a provider outside the default list', async () => {
  const { configuration, providerName, restoreConfiguration, state } = await freshState();
  restoreConfiguration(saved('both', ['gemini', 'codex'], 'gemini'));
  assert.deepEqual(state.participants, ['codex', 'gemini']);
  assert.equal(state.moderator, 'gemini');
  assert.equal(providerName('gemini'), 'gemini');
  assert.equal(providerName('claude'), 'Claude');
  const config = configuration();
  assert.deepEqual(config.participants, ['codex', 'gemini']);
  assert.deepEqual(config.settings.gemini, { model: 'gemini-pro', reasoning: 'high', capability: 'general' });
  assert.equal(config.webSearch, true);
});

test('a registry that lists the provider keeps the selection and names it', async () => {
  const page = await freshState();
  const { isSingle, providerName, restoreConfiguration, setProviders, state } = page;
  restoreConfiguration(saved('gemini', ['gemini']));
  assert.equal(isSingle(), true);
  assert.equal(setProviders(registry('codex', 'claude', 'cursor', 'gemini')), true);
  // `providers` is a live binding: read it from the module after the change.
  assert.deepEqual(page.providers, ['codex', 'claude', 'cursor', 'gemini']);
  assert.equal(providerName('gemini'), 'Gemini');
  assert.deepEqual(state.participants, ['gemini']);
  assert.equal(state.mode, 'gemini');
  // The same registry again changes nothing on the page.
  assert.equal(setProviders(registry('codex', 'claude', 'cursor', 'gemini')), false);
});

test('a registry without the provider drops it, and a selection left too small starts over', async () => {
  const { restoreConfiguration, setProviders, state } = await freshState();
  restoreConfiguration(saved('debate', ['gemini', 'claude', 'codex'], 'gemini'));
  setProviders(registry('codex', 'claude', 'cursor'));
  assert.deepEqual(state.participants, ['codex', 'claude']);
  assert.equal(state.moderator, 'codex');
  assert.equal(state.selectionRestored, true);

  const second = await freshState();
  second.restoreConfiguration(saved('both', ['gemini', 'codex']));
  second.setProviders(registry('codex', 'claude', 'cursor'));
  assert.deepEqual(second.state.participants, ['codex', 'claude']);
  assert.equal(second.state.mode, 'debate');
  assert.equal(second.state.selectionRestored, false);
});

test('once the registry is known, saved selections may only name its providers', async () => {
  const { restoreConfiguration, setProviders, state } = await freshState();
  setProviders(registry('claude', 'codex'));
  restoreConfiguration(saved('gemini', ['gemini']));
  assert.equal(state.selectionRestored, false);
  restoreConfiguration(saved('both', ['gemini', 'codex']));
  assert.equal(state.selectionRestored, false);
  restoreConfiguration(saved('both', ['codex', 'gemini', 'claude']));
  assert.deepEqual(state.participants, ['claude', 'codex']);
  assert.equal(state.moderator, 'codex');
});

test('a health response without a usable provider list keeps the current one', async () => {
  const { providers, setProviders } = await freshState();
  for (const list of [undefined, [], [{ id: 'Not valid' }]]) assert.equal(setProviders(list), false);
  assert.deepEqual(providers, ['codex', 'claude', 'cursor']);
});

test('a saved selection restores goal mode and its most versions; one without them gets the default', async () => {
  const { configuration, isSingle, restoreConfiguration, state } = await freshState();
  restoreConfiguration({ ...saved('goal', ['claude', 'codex'], 'claude'), maxRounds: 5 });
  assert.equal(isSingle(), false);
  assert.deepEqual(
    [state.mode, state.participants, state.moderator],
    ['goal', ['codex', 'claude'], 'claude']
  );
  assert.equal(configuration().maxRounds, 5);
  for (const maxRounds of [undefined, 0, 9, 2.5, '4']) {
    restoreConfiguration({ ...saved('debate', ['codex', 'claude']), maxRounds });
    assert.equal(state.maxRounds, 3, String(maxRounds));
  }
  // Goal mode needs two participants, as a debate does.
  restoreConfiguration({ ...saved('goal', ['codex']), maxRounds: 2 });
  assert.equal(state.mode, 'debate');
});
