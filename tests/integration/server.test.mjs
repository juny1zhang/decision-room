import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { capabilityPrompt } from '../../src/capabilities.mjs';
import { harness, delay } from '../support/harness.mjs';

test('local decision-room integration with fake official CLIs', { timeout: 45000 }, async (t) => {
  await t.test('auth/host/origin checks protect API and diagnostics redact identities', async (t) => {
    const h = await harness(t);
    const missing = await fetch(h.origin + '/api/health');
    assert.ok([401, 403].includes(missing.status));
    const evilOrigin = await h.request('/api/health', { headers: { Origin: 'https://attacker.invalid' } });
    assert.equal(evilOrigin.status, 403);
    // Fetch normalizes Host, so use the raw HTTP client for this specific boundary.
    const evilHostStatus = await new Promise((resolve, reject) => {
      const request = http.get(
        h.origin + '/api/health',
        { headers: { Host: 'attacker.invalid', 'X-Decision-Token': h.token } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        }
      );
      request.on('error', reject);
    });
    assert.equal(evilHostStatus, 403);
    const res = await h.request('/api/health');
    assert.equal(res.status, 200);
    const raw = await res.text();
    const health = JSON.parse(raw);
    for (const provider of ['codex', 'claude', 'cursor']) {
      assert.equal(health[provider].subscription, true, raw);
      assert.equal(health[provider].authenticated, true, raw);
      assert.equal(health[provider].supportsWeb, true, raw);
      assert.ok(Array.isArray(health[provider].reasoningLevels));
    }
    assert.ok(health.codex.models.includes('mock-codex'), raw);
    assert.ok(health.claude.models.includes('sonnet'), raw);
    assert.ok(health.cursor.models.includes('mock-cursor'), raw);
    assert.ok(health.codex.reasoningLevels.includes('high'));
    assert.ok(health.claude.reasoningLevels.includes('medium'));
    assert.deepEqual(health.claude.reasoningByModel.haiku, []);
    assert.deepEqual(health.cursor.reasoningLevels, []);
    assert.deepEqual(health.capabilities.map((item) => item.id).sort(), [
      'compare',
      'general',
      'plan',
      'risk',
      'verify'
    ]);
    assert.ok(!raw.includes('private-user@example.invalid'));
    assert.ok(!raw.includes('fake-test-value'));
    assert.equal((await h.calls()).length, 0, 'Health must not make model requests');
  });

  await t.test(
    'both mode runs independent calls, preserves exact user input and persists/export results',
    async (t) => {
      const h = await harness(t);
      const payload =
        '原样保留 $(touch /tmp/decision-room-shell-injection) `echo unsafe` <script>alert(1)</script>';
      const { res, events, raw } = await h.run({ prompt: payload });
      assert.equal(res.status, 200, raw);
      assert.ok(
        events.some((x) => x.type === 'done'),
        raw
      );
      const calls = await h.calls();
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((x) => x.provider).sort(), ['claude', 'codex']);
      for (const call of calls) {
        assert.ok(call.prompt.includes(payload), 'Prompt should travel through stdin intact');
        assert.deepEqual(call.apiEnvNames, [], 'Only subscription auth should reach child process');
        assert.ok(!call.prompt.includes('MOCK_'), 'Independent round must not include the other answer');
      }
      const codex = calls.find((x) => x.provider === 'codex');
      assert.ok(codex.args.includes('read-only'));
      assert.ok(!codex.args.includes('--dangerously-bypass-approvals-and-sandbox'));
      const claude = calls.find((x) => x.provider === 'claude');
      assert.ok(claude.args.includes('--safe-mode'));
      assert.ok(!claude.args.includes('--dangerously-skip-permissions'));
      const roomId = events.find((x) => x.type === 'room')?.roomId;
      assert.ok(roomId);
      const roomRes = await h.request(`/api/rooms/${roomId}`);
      const room = await roomRes.json();
      assert.ok(room.messages.some((x) => x.role === 'codex' && x.text.includes('MOCK_CODEX')));
      assert.ok(room.messages.some((x) => x.role === 'claude' && x.text.includes('MOCK_CLAUDE')));
      const exportRes = await h.request(`/api/rooms/${roomId}/export`);
      assert.equal(exportRes.status, 200);
      const exported = await exportRes.text();
      assert.ok(exported.includes(payload));
      assert.ok(exported.includes('MOCK_CODEX'));
      assert.ok(exported.includes('MOCK_CLAUDE'));
    }
  );

  await t.test(
    'debate requires independent opinions, two reviews, and labelled moderator result',
    async (t) => {
      const h = await harness(t);
      const { res, events, raw } = await h.run({ mode: 'debate' });
      assert.equal(res.status, 200, raw);
      assert.ok(
        events.some((x) => x.type === 'done'),
        raw
      );
      const calls = await h.calls();
      assert.equal(calls.length, 5, JSON.stringify(calls.map((x) => x.provider)));
      assert.ok(!calls[0].prompt.includes('MOCK_'));
      assert.ok(!calls[1].prompt.includes('MOCK_'));
      for (const review of calls.slice(2, 4)) {
        assert.ok(review.prompt.includes('MOCK_CODEX'));
        assert.ok(review.prompt.includes('MOCK_CLAUDE'));
      }
      const messages = events.filter((x) => x.type === 'message').map((x) => x.message);
      assert.equal(messages.filter((x) => x.stage === 'review').length, 2);
      const summary = messages.find((x) => x.role === 'summary');
      assert.ok(summary);
      assert.equal(summary.provider, 'codex');
      assert.equal(summary.model, 'mock-codex-actual');
      assert.ok(summary.text.includes('MOCK_CODEX'));
    }
  );

  await t.test('API-authenticated CLI is blocked before any model request', async (t) => {
    const h = await harness(t);
    const health = await (await h.request('/api/health')).json();
    assert.equal(health.claude.subscription, true);
    // A user can switch login methods while the application remains open.
    await h.setControl({ claude: { auth: 'api' } });
    const { res, events, raw } = await h.run({ mode: 'debate' });
    assert.ok(res.status >= 400 || events.some((x) => x.type === 'error'), raw);
    assert.equal(
      (await h.calls()).length,
      0,
      'No partial run should start when the required auth check fails'
    );
  });

  await t.test(
    'three participants use their own model, capability and reasoning through review and moderation',
    async (t) => {
      const h = await harness(t);
      const participants = ['cursor', 'claude', 'codex'];
      const cursorModel = 'mock-cursor[context=1m,effort=high,fast=false]';
      const settings = {
        codex: { model: 'mock-codex', reasoning: 'high', capability: 'verify' },
        claude: { model: 'sonnet', reasoning: 'medium', capability: 'risk' },
        cursor: { model: cursorModel, reasoning: '', capability: 'plan' }
      };
      const { res, raw, events } = await h.run({
        mode: 'debate',
        participants,
        moderator: 'cursor',
        settings
      });
      assert.equal(res.status, 200, raw);
      const calls = await h.calls();
      assert.equal(calls.length, 7, raw);
      const analyses = calls.slice(0, 3);
      const reviews = calls.slice(3, 6);
      const summary = calls[6];
      for (const stage of [analyses, reviews]) {
        assert.deepEqual(stage.map((call) => call.provider).sort(), ['claude', 'codex', 'cursor']);
        for (const call of stage) {
          for (const provider of participants) {
            const focus = capabilityPrompt(settings[provider].capability);
            assert.ok(focus.length > 0);
            assert.equal(call.prompt.includes(focus), provider === call.provider);
          }
        }
      }
      for (const call of analyses) assert.ok(!call.prompt.includes('MOCK_'));
      for (const reviewer of reviews) {
        for (const analysis of analyses) assert.ok(reviewer.prompt.includes(analysis.result));
      }
      assert.equal(summary.provider, 'cursor');
      for (const call of [...analyses, ...reviews]) assert.ok(summary.prompt.includes(call.result));

      for (const { provider, args, apiEnvNames, cursorConfig } of calls) {
        assert.deepEqual(apiEnvNames, []);
        assert.equal(args[args.indexOf('--model') + 1], settings[provider].model);
        if (provider === 'codex') {
          assert.ok(args.includes('model_reasoning_effort="high"'));
          assert.ok(args.includes('web_search="disabled"'));
        } else if (provider === 'claude') {
          assert.equal(args[args.indexOf('--effort') + 1], 'medium');
          assert.equal(args[args.indexOf('--tools') + 1], '');
        } else {
          assert.equal(args[args.indexOf('--mode') + 1], 'ask');
          assert.equal(args[args.indexOf('--sandbox') + 1], 'enabled');
          assert.ok(!args.includes('--force'));
          assert.ok(!args.includes('--approve-mcps'));
          assert.equal(cursorConfig.autoAcceptWebSearch, false);
          assert.ok(cursorConfig.permissions.deny.includes('WebFetch(*)'));
          assert.ok(cursorConfig.permissions.deny.includes('Shell(*)'));
          assert.equal(cursorConfig.sandbox.readBoundary, 'workspace');
        }
      }
      const roomId = events.find((event) => event.type === 'room').roomId;
      const room = await (await h.request(`/api/rooms/${roomId}`)).json();
      assert.equal(room.configuration.mode, 'debate');
      assert.equal(room.configuration.moderator, 'cursor');
      assert.deepEqual(room.configuration.participants, participants);
      assert.deepEqual(room.configuration.settings, settings);
      const summaryMessage = room.messages.find((message) => message.role === 'summary');
      assert.equal(summaryMessage.provider, 'cursor');
      assert.equal(summaryMessage.text, summary.result);
      const exported = await (await h.request(`/api/rooms/${roomId}/export`)).text();
      assert.match(exported, /归纳[^\n]*Cursor/i);
      assert.ok(exported.includes(cursorModel));
      assert.ok(exported.includes('mock-codex-actual'));
    }
  );

  await t.test(
    'a single selected CLI can answer and the same room can continue with another pair',
    async (t) => {
      const h = await harness(t, { claude: { auth: 'none' } });
      const first = await h.run({
        prompt: '请核实预算中的人数。',
        mode: 'cursor',
        participants: ['cursor'],
        webSearch: true,
        settings: { cursor: { capability: 'verify' } }
      });
      assert.equal(first.res.status, 200, first.raw);
      const [initial] = await h.calls();
      assert.equal(initial.provider, 'cursor');
      assert.ok(!initial.args.includes('--model'), 'An empty model selection delegates to the CLI');
      assert.equal(initial.cursorConfig.autoAcceptWebSearch, true);
      assert.ok(initial.cursorConfig.permissions.allow.includes('WebFetch(*)'));
      assert.ok(!initial.cursorConfig.permissions.deny.includes('WebFetch(*)'));
      const roomId = first.events.find((event) => event.type === 'room').roomId;
      const followup = await h.run({
        roomId,
        mode: 'both',
        participants: ['codex', 'cursor'],
        prompt: '比较两种分摊方式。',
        settings: { codex: { capability: 'compare' }, cursor: { capability: 'plan' } }
      });
      assert.equal(followup.res.status, 200, followup.raw);
      const calls = await h.calls();
      assert.equal(calls.length, 3);
      for (const call of calls.slice(1)) {
        assert.ok(call.prompt.includes(initial.result));
        assert.ok(call.prompt.includes('比较两种分摊方式。'));
      }
      const room = await (await h.request(`/api/rooms/${roomId}`)).json();
      assert.deepEqual(room.configuration.participants, ['codex', 'cursor']);
      assert.equal(room.configuration.mode, 'both');
      const questions = room.messages.filter((message) => message.role === 'user');
      assert.equal(questions[0].configuration.settings.cursor.capability, 'verify');
      assert.equal(questions[1].configuration.settings.codex.capability, 'compare');
    }
  );

  await t.test(
    'a stale local Cursor login rejected by the model catalogue does not start a run',
    async (t) => {
      const h = await harness(t, { cursor: { expiredCatalog: true } });
      const health = await (await h.request('/api/health')).json();
      assert.equal(health.cursor.subscription, false, health.cursor.message);
      const { res } = await h.run({ mode: 'cursor' });
      assert.equal(res.status, 409);
      assert.equal((await h.calls()).length, 0);
    }
  );

  await t.test('invalid selections fail before any model is called or room saved', async (t) => {
    const h = await harness(t);
    const invalid = [
      { mode: 'both', participants: ['codex'] },
      { mode: 'both', participants: ['claude', 'claude'] },
      { mode: 'both', participants: ['cursor', 'other'] },
      { mode: 'debate', participants: ['cursor', 'claude'], moderator: 'codex' },
      { mode: 'codex', settings: { codex: { model: '--dangerously-bypass-approvals-and-sandbox' } } },
      { mode: 'codex', settings: { codex: { model: 'a'.repeat(5000) } } },
      { mode: 'cursor', settings: { cursor: { reasoning: 'high' } } },
      { mode: 'claude', settings: { claude: { reasoning: 'invented' } } },
      { mode: 'claude', settings: { claude: { model: 'haiku', reasoning: 'medium' } } },
      { mode: 'codex', settings: { codex: { capability: 'unrecognized' } } }
    ];
    for (const selection of invalid) {
      const { res, raw } = await h.run(selection);
      assert.equal(res.status, 400, JSON.stringify(selection) + ' ' + raw);
    }
    assert.equal((await h.calls()).length, 0);
    const { rooms } = await (await h.request('/api/rooms')).json();
    assert.deepEqual(rooms, []);
  });

  await t.test(
    'legacy saved rooms retain their history and accept a newly configured follow-up',
    async (t) => {
      const h = await harness(t);
      const roomId = '00000000-0000-4000-8000-000000000001';
      const date = '2026-01-01T00:00:00.000Z';
      const oldRoom = {
        id: roomId,
        createdAt: date,
        updatedAt: date,
        title: '旧讨论',
        context: '共同预算 200 元',
        messages: [
          { id: '1', role: 'user', stage: 'question', text: '原来的问题', createdAt: date },
          { id: '2', role: 'summary', stage: 'summary', text: '原来的归纳', model: 'codex', createdAt: date }
        ]
      };
      const roomFile = path.join(h.temp, 'data', 'rooms', roomId + '.json');
      await fs.writeFile(roomFile, JSON.stringify(oldRoom));
      const markdown = await (await h.request(`/api/rooms/${roomId}/export`)).text();
      assert.match(markdown, /归纳[^\n]*Codex/);
      assert.ok(markdown.includes(oldRoom.messages[1].text));

      const { res, raw } = await h.run({
        roomId,
        mode: 'both',
        webSearch: true,
        context: oldRoom.context,
        participants: ['claude', 'codex']
      });
      assert.equal(res.status, 200, raw);
      const calls = await h.calls();
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.ok(call.prompt.includes('原来的归纳'));
        assert.ok(call.prompt.includes(oldRoom.context));
        if (call.provider === 'codex') {
          assert.ok(call.args.includes('web_search="live"'));
        } else {
          assert.match(call.args[call.args.indexOf('--tools') + 1], /WebSearch/);
          assert.ok(call.args.includes('--allowedTools'));
        }
      }
      const room = await (await h.request(`/api/rooms/${roomId}`)).json();
      assert.deepEqual(room.messages.slice(0, 2), oldRoom.messages);
      assert.deepEqual(room.configuration.participants, ['claude', 'codex']);
    }
  );

  await t.test(
    'provider failure never fabricates review/consensus and remaining output is preserved',
    async (t) => {
      const h = await harness(t, { claude: { fail: true } });
      const { events, raw } = await h.run({ mode: 'debate' });
      assert.ok(
        events.some((x) => x.type === 'error' || (x.type === 'message' && x.message.stage === 'error')),
        raw
      );
      assert.ok(!events.some((x) => x.type === 'message' && x.message.role === 'summary'), raw);
      assert.ok(
        (await h.calls()).length <= 2,
        'No review or summary should run after initial provider failure'
      );
    }
  );

  await t.test('unknown provider authentication is not accepted as a subscription', async (t) => {
    const h = await harness(t, { claude: { auth: 'third_party' } });
    const { res, events, raw } = await h.run({ mode: 'claude' });
    assert.ok(res.status >= 400 || events.some((x) => x.type === 'error'), raw);
    assert.equal((await h.calls()).length, 0);
  });

  await t.test(
    'cancel terminates children, enforces single active run and releases busy state',
    async (t) => {
      const h = await harness(t, { codex: { hang: true }, claude: { hang: true } });
      const first = await h.startRun({ mode: 'both' });
      assert.equal(first.status, 200);
      const draining = first.text();
      const deadline = Date.now() + 4000;
      while ((await h.calls()).length < 2) {
        if (Date.now() > deadline) throw new Error('Fake CLI processes never started');
        await delay(20);
      }
      const second = await h.startRun({ mode: 'both' });
      assert.equal(second.status, 409);
      await second.text();
      const cancel = await h.request('/api/cancel', { method: 'POST', body: {} });
      assert.equal(cancel.status, 200);
      await Promise.race([
        draining,
        delay(4000).then(() => {
          throw new Error('Cancelled stream stayed open');
        })
      ]);
      const terminated = await fs.readFile(path.join(h.bin, 'terminated.ndjson'), 'utf8');
      assert.equal(terminated.trim().split('\n').filter(Boolean).length, 2);
      await h.setControl({});
      const next = await h.run({ mode: 'codex' });
      assert.equal(next.res.status, 200, next.raw);
      assert.ok(
        next.events.some((x) => x.type === 'done'),
        next.raw
      );
    }
  );

  await t.test('invalid and oversized input does not launch model processes', async (t) => {
    const h = await harness(t);
    const malformed = await h.request('/api/run', { method: 'POST', body: '{broken' });
    assert.equal(malformed.status, 400);
    const invalidMode = await h.startRun({ mode: 'arbitrary-executable' });
    assert.equal(invalidMode.status, 400);
    const oversized = await h.startRun({ prompt: 'A'.repeat(3_000_000) });
    assert.ok([400, 413].includes(oversized.status));
    assert.equal((await h.calls()).length, 0);
  });

  await t.test('browser disconnection stops outstanding CLI work', async (t) => {
    const h = await harness(t, { codex: { hang: true }, claude: { hang: true } });
    const controller = new AbortController();
    const res = await h.request('/api/run', {
      method: 'POST',
      signal: controller.signal,
      body: { prompt: '断开连接测试', mode: 'both', context: '', webSearch: false }
    });
    assert.equal(res.status, 200);
    const draining = res.text().catch(() => {});
    const deadline = Date.now() + 4000;
    while ((await h.calls()).length < 2) {
      if (Date.now() > deadline) throw new Error('Fake CLI processes never started');
      await delay(20);
    }
    controller.abort();
    await draining;
    let terminated = '';
    while (Date.now() < deadline) {
      try {
        terminated = await fs.readFile(path.join(h.bin, 'terminated.ndjson'), 'utf8');
      } catch {}
      if (terminated.trim().split('\n').filter(Boolean).length === 2) break;
      await delay(20);
    }
    assert.equal(terminated.trim().split('\n').filter(Boolean).length, 2);
  });
});
