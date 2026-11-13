// Goal mode (目标模式) end to end over HTTP with the mock CLIs: proposals, versions of one plan and feedback
// streamed as NDJSON and saved to the room, consensus after a revision, the export, and a turn that reaches
// its cap and goes on with 继续磨合. The mock CLIs end their feedback with the verdicts their control sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from '../support/harness.mjs';

const THREE = { mode: 'goal', participants: ['codex', 'claude', 'cursor'], moderator: 'codex' };

/** "provider:stage vN" of a mock CLI's call, read from its prompt. */
function describe({ provider, prompt }) {
  const feedback = prompt.match(/的身份评审方案 v(\d+)/);
  if (feedback) return `${provider}:feedback v${feedback[1]}`;
  const revision = prompt.match(/的身份写出完整的方案 v(\d+)/);
  if (revision) return `${provider}:draft v${revision[1]}`;
  if (prompt.includes('合并成一份完整、可以直接执行的方案 v1')) return `${provider}:draft v1`;
  if (prompt.includes('请独立提出一份达成这个目标的完整方案')) return `${provider}:proposal`;
  return `${provider}:other`;
}
const messagesOf = (events) =>
  events.filter((event) => event.type === 'message').map((event) => event.message);
/** "role:stage" with the version and the verdict of each message. */
const outline = (messages) =>
  messages.map(({ role, stage, version, verdict }) =>
    [`${role}:${stage}`, version && `v${version}`, verdict].filter(Boolean).join(' ')
  );
/**
 * `items` cut into consecutive groups of `sizes`, each as its sorted labels: the calls of one stage run at
 * once, so their order within it is not fixed.
 */
function grouped(items, sizes, label) {
  let start = 0;
  return sizes.map((size) =>
    items
      .slice(start, (start += size))
      .map(label)
      .sort()
  );
}
const notices = (messages) =>
  messages.filter((message) => message.stage === 'notice').map(({ text }) => text);

test('a goal turn revises its plan until everyone approves, streamed, saved and exported', async (t) => {
  const h = await harness(t, {
    claude: { verdicts: ['revise', 'approve'] },
    cursor: { verdicts: 'approve' }
  });
  const prompt = '下个季度把客服首次响应时间降到 1 小时以内。完成标准：连续四周达标。';
  const { res, raw, events } = await h.run({ ...THREE, prompt, maxRounds: 3 });
  assert.equal(res.status, 200, raw);
  assert.equal(events[0].type, 'room');
  assert.deepEqual(events.at(-1), { type: 'done', roomId: events[0].roomId });

  // Three proposals at once, then the moderator's version 1, feedback, version 2 and feedback again.
  const calls = await h.calls();
  assert.equal(calls.length, 9);
  assert.deepEqual(grouped(calls, [3, 1, 2, 1, 2], describe), [
    ['claude:proposal', 'codex:proposal', 'cursor:proposal'],
    ['codex:draft v1'],
    ['claude:feedback v1', 'cursor:feedback v1'],
    ['codex:draft v2'],
    ['claude:feedback v2', 'cursor:feedback v2']
  ]);
  const messages = messagesOf(events);
  assert.equal(messages.length, 11);
  assert.deepEqual(
    grouped(messages, [1, 3, 1, 2, 1, 2, 1], (message) => outline([message])[0]),
    [
      ['user:question'],
      ['claude:proposal', 'codex:proposal', 'cursor:proposal'],
      ['summary:draft v1'],
      ['claude:feedback v1 revise', 'cursor:feedback v1 approve'],
      ['summary:draft v2'],
      ['claude:feedback v2 approve', 'cursor:feedback v2 approve'],
      ['system:notice']
    ]
  );
  assert.deepEqual(notices(messages), ['全员认可方案 v2，目标模式结束。']);
  const [question] = messages;
  assert.equal(question.text, prompt);
  assert.deepEqual(
    {
      mode: question.configuration.mode,
      moderator: question.configuration.moderator,
      maxRounds: question.configuration.maxRounds
    },
    { mode: 'goal', moderator: 'codex', maxRounds: 3 }
  );
  assert.ok(messages.every((message) => message.turnId === question.id));
  const drafts = messages.filter((message) => message.stage === 'draft');
  assert.deepEqual(
    drafts.map(({ provider, model, version, cap }) => ({ provider, model, version, cap })),
    [1, 2].map((version) => ({ provider: 'codex', model: 'mock-codex-actual', version, cap: 3 }))
  );
  // Each answer is the text its CLI wrote; a feedback keeps its verdict line.
  for (const message of messages.filter((item) => item.provider))
    assert.ok(
      calls.some((call) => call.result === message.text),
      message.stage
    );
  assert.match(messages.find((message) => message.verdict === 'revise').text, /\n\n结论：需修改$/);

  // Live statuses and previews name the stage and the version of the plan.
  const statuses = events.filter((event) => event.type === 'status').map((event) => event.text);
  for (const text of [
    '正在提出方案',
    '正在整理方案 v1',
    '正在评审方案 v1',
    '正在整理方案 v2',
    '正在评审方案 v2'
  ])
    assert.ok(statuses.includes(text), text);
  const draftDeltas = events.filter((event) => event.type === 'delta' && event.stage === 'draft');
  assert.deepEqual(
    [...new Set(draftDeltas.map((event) => `${event.agent} v${event.version}`))],
    ['codex v1', 'codex v2']
  );
  assert.ok(
    events
      .filter((event) => event.type === 'delta' && event.stage === 'proposal')
      .every((event) => !('version' in event))
  );

  // The reviewers of version 2 read it, and each other's feedback on version 1.
  const reviewsOfV2 = calls.filter((call) => describe(call).endsWith('feedback v2'));
  for (const call of reviewsOfV2) {
    assert.ok(call.prompt.includes(drafts[1].text));
    for (const feedback of messages.filter((item) => item.stage === 'feedback' && item.version === 1))
      assert.ok(call.prompt.includes(feedback.text), `${call.provider} reads ${feedback.provider}`);
  }
  const revision = calls.find((call) => describe(call) === 'codex:draft v2').prompt;
  assert.ok(revision.includes('verdict="需修改"') && revision.includes('verdict="认可"'));

  // The saved room holds the same turn, and the export names every stage, the verdicts and the final plan.
  const room = await (await h.request(`/api/rooms/${events[0].roomId}`)).json();
  assert.deepEqual(room.messages, messages);
  assert.equal(room.configuration.mode, 'goal');
  const exported = await (await h.request(`/api/rooms/${room.id}/export`)).text();
  assert.match(exported, /本轮设置 · 目标模式 · 网页检索关闭 · 主持人 Codex · 最多 3 版/);
  for (const part of [
    'Codex · 独立方案',
    '主持人（Codex） · 方案 v1',
    'Claude · 评审方案 v1（需修改）',
    'Cursor · 评审方案 v1（认可）',
    '主持人（Codex） · 最终方案 v2'
  ])
    assert.ok(exported.includes(part), part);

  // Done: nothing is left to resume.
  const again = await h.run({ roomId: room.id, resumeTurnId: question.id, moreRounds: true });
  assert.deepEqual(
    { status: again.res.status, body: JSON.parse(again.raw) },
    { status: 409, body: { error: '这一轮已经完成，无需重试。' } }
  );
  assert.equal((await h.calls()).length, calls.length);
});

test('a goal turn at its cap stops, and 继续磨合 goes on until everyone approves', async (t) => {
  const h = await harness(t, { claude: { verdicts: 'revise' }, cursor: { verdicts: 'approve' } });
  const first = await h.run({ ...THREE, maxRounds: 1 });
  assert.equal(first.res.status, 200, first.raw);
  const messages = messagesOf(first.events);
  assert.deepEqual(notices(messages), [
    '已达到最多 1 版，方案 v1 仍未获得全员认可：Claude 认为还需修改。可以点「继续磨合」再修改最多 1 版，或根据当前方案继续追问。'
  ]);
  const roomId = first.events[0].roomId;
  const turnId = messages[0].id;
  const before = (await h.calls()).length;

  // 重试未完成的部分 is refused at the cap; 继续磨合 writes one more version, with the raised cap.
  const retry = await h.run({ roomId, resumeTurnId: turnId });
  assert.deepEqual(
    { status: retry.res.status, body: JSON.parse(retry.raw) },
    {
      status: 409,
      body: { error: '这一轮已达到最多版本数，可以点「继续磨合」再修改几版。' }
    }
  );
  await h.setControl({ claude: { verdicts: 'approve' }, cursor: { verdicts: 'approve' } });
  const more = await h.run({ roomId, resumeTurnId: turnId, moreRounds: true, prompt: '草稿', mode: 'both' });
  assert.equal(more.res.status, 200, more.raw);
  const added = messagesOf(more.events);
  assert.equal(added.length, 4);
  assert.deepEqual(outline(added.slice(0, 1)), ['summary:draft v2']);
  assert.equal(added[0].cap, 2);
  assert.deepEqual(outline(added.slice(1, 3)).sort(), [
    'claude:feedback v2 approve',
    'cursor:feedback v2 approve'
  ]);
  assert.deepEqual(notices(added), ['全员认可方案 v2，目标模式结束。']);
  assert.deepEqual((await h.calls()).slice(before).map(describe).sort(), [
    'claude:feedback v2',
    'codex:draft v2',
    'cursor:feedback v2'
  ]);
  const room = await (await h.request(`/api/rooms/${roomId}`)).json();
  assert.equal(room.messages.filter((message) => message.role === 'user').length, 1);
  assert.ok(room.messages.every((message) => message.turnId === turnId));
});
