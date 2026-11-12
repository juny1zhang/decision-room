// Server correctness end to end: the history sent to the models, failure messages, context snapshots,
// the Markdown export and rooms edited by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { harness } from '../support/harness.mjs';

const date = '2026-03-02T01:15:00.000Z';
const roomId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const message = (id, role, stage, text, extra = {}) => ({ id, role, stage, text, createdAt: date, ...extra });

async function writeRoom(h, room) {
  await fs.writeFile(path.join(h.temp, 'data', 'rooms', `${room.id}.json`), JSON.stringify(room));
}

async function getRoom(h, id) {
  const response = await h.request(`/api/rooms/${id}`);
  assert.equal(response.status, 200);
  return response.json();
}

/** Runs one round and returns the model calls it made. */
async function ask(h, payload) {
  const before = (await h.calls()).length;
  const { res, raw, events } = await h.run({ mode: 'codex', participants: ['codex'], ...payload });
  assert.equal(res.status, 200, raw);
  assert.ok(
    events.some((event) => event.type === 'done'),
    raw
  );
  return { events, calls: (await h.calls()).slice(before) };
}

test('server correctness with fake official CLIs', { timeout: 60000 }, async (t) => {
  await t.test(
    'a very long latest answer is shortened and earlier rounds still reach the models',
    async (t) => {
      const h = await harness(t);
      const long = 'H'.repeat(200) + '长'.repeat(49600) + 'T'.repeat(200);
      const id = roomId(1);
      await writeRoom(h, {
        id,
        title: '长回答',
        createdAt: date,
        updatedAt: date,
        context: '预算固定',
        messages: [
          message('1', 'user', 'question', '第一个问题', { context: '预算固定' }),
          message('2', 'codex', 'analysis', '第一轮分析', { provider: 'codex', model: 'gpt-5' }),
          message('3', 'summary', 'summary', '第一轮总结', { provider: 'codex', model: 'gpt-5' }),
          message('4', 'user', 'question', '第二个问题'),
          message('5', 'claude', 'analysis', long, { provider: 'claude', model: 'sonnet' })
        ]
      });
      const { calls, events } = await ask(h, { roomId: id, prompt: '第三个问题', context: '预算固定' });
      const [{ prompt }] = calls;
      for (const part of [
        '第一个问题',
        '第一轮分析',
        '第一轮总结',
        '第二个问题',
        'H'.repeat(200),
        'T'.repeat(200)
      ])
        assert.ok(prompt.includes(part), part);
      assert.equal(long.length, 50000);
      assert.ok(prompt.includes('\n…（中间省略约 38000 字）…\n'));
      assert.ok(!prompt.includes('这是新讨论'));
      const added = events.filter((event) => event.type === 'message').map((event) => event.message);
      assert.deepEqual(
        added.filter((item) => item.role === 'system').map((item) => item.text),
        [
          '为控制长度，本轮发送给模型的讨论记录缩短了 1 条较长的发言（保留开头和结尾）；完整记录仍可查看和导出。'
        ]
      );
      assert.ok(!Object.hasOwn(added[0], 'context'), 'an unchanged context is not stored again');

      // A new room has no earlier discussion and gets no notice.
      const fresh = await ask(h, { prompt: '全新的问题', context: '' });
      assert.ok(fresh.calls[0].prompt.includes('这是新讨论'));
      assert.ok(!fresh.events.some((event) => event.type === 'message' && event.message.role === 'system'));
    }
  );

  await t.test('failures are explained from stderr, never from what the model wrote', async (t) => {
    const answer = '这个方案会碰到 rate limit 与 quota 上限，需要重新 login，并可能出现 401。';
    const h = await harness(t, {
      codex: {
        failure: { answer, stderr: 'ERROR stream disconnected before completion: error sending request' }
      },
      claude: { failure: { answer } },
      cursor: { failure: { answer, stderr: 'ConnectError: [unavailable] Connection lost' } }
    });
    const { res, raw, events } = await h.run({ mode: 'both', participants: ['codex', 'claude', 'cursor'] });
    assert.equal(res.status, 200, raw);
    const errors = events
      .filter((event) => event.type === 'message' && event.message.stage === 'error')
      .map((event) => event.message.text)
      .sort();
    assert.deepEqual(errors, [
      'Claude 分析失败：官方 CLI 未成功完成（退出码 1）。请在对应 CLI 中检查所选模型、账号权限和网络。',
      'Codex 分析失败：未能连接官方模型服务，请检查本机网络和证书设置。',
      'Cursor 分析失败：Cursor 与模型服务的连接已中断。请检查网络后重试。'
    ]);
  });

  await t.test('context snapshots follow each change, and history and export use them', async (t) => {
    const h = await harness(t, {}, { env: { TZ: 'Asia/Shanghai' } });
    const first = await ask(h, { prompt: '问题一', context: '背景 A' });
    const id = first.events.find((event) => event.type === 'room').roomId;
    await ask(h, { roomId: id, prompt: '问题二', context: '背景 A' });
    const third = await ask(h, { roomId: id, prompt: '问题三', context: '背景 B' });
    await ask(h, { roomId: id, prompt: '问题四', context: '' });

    const room = await getRoom(h, id);
    const questions = room.messages.filter((item) => item.role === 'user');
    assert.deepEqual(
      questions.map((item) => [item.text, Object.hasOwn(item, 'context') ? item.context : null]),
      [
        ['问题一', '背景 A'],
        ['问题二', null],
        ['问题三', '背景 B'],
        ['问题四', '']
      ]
    );
    assert.equal(room.context, '');
    assert.ok(!Object.hasOwn(room, 'legacyContext'));

    // The third question was asked with 背景 B; the earlier rounds show the 背景 A they were asked with.
    const prompt = third.calls[0].prompt;
    assert.ok(
      prompt.includes('用户的共享背景（可能包含假设）：\n<shared_context>\n背景 B\n</shared_context>')
    );
    assert.ok(prompt.includes('[共享背景]\n背景 A\n\n[用户 / 问题]\n问题一'));
    assert.ok(prompt.includes('[用户 / 问题]\n问题二'));
    assert.ok(!prompt.includes('[共享背景（本轮更新）]'));

    const exported = await (await h.request(`/api/rooms/${id}/export`)).text();
    const time = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}（UTC\+08:00）/.source;
    assert.match(
      exported,
      new RegExp(`^# 问题一\\n\\n创建：${time}\\n\\n## 共享背景\\n\\n背景 A\\n\\n## 你 · 问题 · ${time}`)
    );
    assert.match(exported, new RegExp(`## Codex · 独立分析 · ${time}\\n\\n模型 · mock-codex-actual`));
    assert.match(exported, /\n问题二\n\n## Codex/);
    assert.match(exported, /\n问题三\n\n### 共享背景（本轮更新）\n\n背景 B\n\n## Codex/);
    assert.match(exported, /\n问题四\n\n### 共享背景（本轮更新）\n\n（已清空）\n\n## Codex/);
    assert.equal(exported.match(/共享背景/g).length, 3);
  });

  await t.test(
    'a room saved before snapshots keeps its old context when a question changes it',
    async (t) => {
      const h = await harness(t);
      const id = roomId(2);
      const legacy = {
        id,
        title: '旧讨论',
        createdAt: date,
        updatedAt: date,
        context: '旧背景',
        messages: [
          message('1', 'user', 'question', '旧问题'),
          message('2', 'summary', 'summary', '旧归纳', { model: 'codex' })
        ]
      };
      await writeRoom(h, legacy);
      const { calls } = await ask(h, { roomId: id, prompt: '新问题', context: '新背景' });
      assert.ok(calls[0].prompt.includes('[共享背景]\n旧背景\n\n[用户 / 问题]\n旧问题'));
      const room = await getRoom(h, id);
      assert.equal(room.context, '新背景');
      assert.equal(room.legacyContext, '旧背景');
      assert.deepEqual(room.messages.slice(0, 2), legacy.messages);
      assert.equal(room.messages[2].context, '新背景');
      const exported = await (await h.request(`/api/rooms/${id}/export`)).text();
      assert.ok(exported.includes('## 共享背景\n\n旧背景\n\n## 你 · 问题'));
      assert.ok(exported.includes('新问题\n\n### 共享背景（本轮更新）\n\n新背景\n\n'));
    }
  );

  await t.test(
    'hand-edited room files never break the room list, a room, its export or a follow-up',
    async (t) => {
      const h = await harness(t);
      const dir = path.join(h.temp, 'data', 'rooms');
      const valid = {
        id: roomId(3),
        title: '正常',
        createdAt: date,
        updatedAt: date,
        context: '',
        messages: []
      };
      const noDates = { id: roomId(4), title: '无日期', messages: [] };
      const noMessages = { id: roomId(5), title: '无消息', createdAt: date };
      const partialSettings = {
        id: roomId(6),
        title: '设置不全',
        createdAt: date,
        updatedAt: date,
        messages: [
          message('1', 'user', 'question', '问题', {
            configuration: {
              mode: 'debate',
              participants: ['codex', 'claude'],
              moderator: 'claude',
              settings: { codex: null }
            }
          })
        ]
      };
      for (const room of [valid, noDates, noMessages, partialSettings]) await writeRoom(h, room);
      const fileTime = new Date('2026-04-01T00:00:00.000Z');
      await fs.utimes(path.join(dir, `${noDates.id}.json`), fileTime, fileTime);
      await fs.writeFile(path.join(dir, `${roomId(7)}.json`), '{broken');

      const listed = await h.request('/api/rooms');
      assert.equal(listed.status, 200);
      const { rooms } = await listed.json();
      assert.deepEqual(
        rooms.map((room) => [room.id, room.updatedAt, room.messageCount]),
        [
          [noDates.id, fileTime.toISOString(), 0],
          [valid.id, date, 0],
          [noMessages.id, date, 0],
          [partialSettings.id, date, 1]
        ].sort((a, b) => b[1].localeCompare(a[1]))
      );

      assert.deepEqual((await getRoom(h, noMessages.id)).messages, []);
      const exported = await h.request(`/api/rooms/${partialSettings.id}/export`);
      assert.equal(exported.status, 200);
      assert.ok(
        (await exported.text()).includes(
          '本轮设置 · 联合讨论 · 网页检索关闭 · 主持人 Claude\n\n- Codex · CLI 默认模型 · 综合分析\n- Claude · CLI 默认模型 · 综合分析'
        )
      );
      const broken = await h.request(`/api/rooms/${roomId(7)}`);
      assert.equal(broken.status, 500);
      assert.equal((await broken.json()).error, '这次讨论的记录文件已损坏，无法读取。');

      await ask(h, { roomId: noMessages.id, prompt: '继续', context: '' });
      const continued = await getRoom(h, noMessages.id);
      assert.deepEqual(
        continued.messages.map((item) => item.role),
        ['user', 'codex']
      );
    }
  );
});
