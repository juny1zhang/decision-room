// Goal mode (目标模式): runDiscussion with a stubbed invoke and an in-memory room store. Participants propose,
// the moderator merges the proposals into version 1 of a plan and revises it from the others' feedback until
// all of them approve one version or the cap on versions is reached; every interrupted turn resumes from its
// saved messages alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityPrompt } from '../../src/capabilities.mjs';
import { runDiscussion, turnComplete, turnProgress } from '../../src/discussion.mjs';
import { AppError } from '../../src/errors.mjs';
import { finalPlans, goalProgress, goalTurns, parseVerdict } from '../../src/goal.mjs';
import { historyFor } from '../../src/prompts.mjs';
import { PROVIDER_IDS } from '../../src/providers/index.mjs';
import { readConfiguration } from '../../src/validation.mjs';

const THREE = { mode: 'goal', participants: ['codex', 'claude', 'cursor'], moderator: 'claude' };
const READY = {
  subscription: true,
  supportsWeb: true,
  reasoningLevels: [],
  reasoningByModel: {},
  message: ''
};
const health = { check: async () => Object.fromEntries(PROVIDER_IDS.map((id) => [id, READY])) };

/** An in-memory room store that keeps a copy of every room as it was saved. */
function store() {
  const saved = new Map();
  return {
    saved,
    save: async (room) => void saved.set(room.id, structuredClone(room)),
    load: async (id) => {
      if (!saved.has(id)) throw new AppError('找不到这次讨论。', 404);
      return structuredClone(saved.get(id));
    }
  };
}

/** The stage, version and reviewer of a goal-mode prompt, read from its task. */
function stageOf(prompt) {
  const feedback = prompt.match(/请以 (\S+) 的身份评审方案 v(\d+)/);
  if (feedback) return { stage: 'feedback', version: Number(feedback[2]) };
  const revision = prompt.match(/的身份写出完整的方案 v(\d+)/);
  if (revision) return { stage: 'draft', version: Number(revision[1]) };
  if (prompt.includes('合并成一份完整、可以直接执行的方案 v1')) return { stage: 'draft', version: 1 };
  if (prompt.includes('请独立提出一份达成这个目标的完整方案')) return { stage: 'proposal' };
  return { stage: 'other' };
}

/**
 * An invoke that answers every goal-mode call and records it in `calls` ({ agent, stage, version, prompt }).
 * verdict(agent, version) is the verdict a feedback ends with ('approve' or 'revise'); fail(call) tells which
 * calls fail instead.
 */
function goal({ verdict = () => 'approve', fail = () => false } = {}) {
  const calls = [];
  const invoke = async (agent, prompt) => {
    const call = { agent, ...stageOf(prompt), prompt };
    calls.push(call);
    if (fail(call)) throw Object.assign(new Error(`${agent} 出错`), { category: 'other' });
    const name = call.version ? `${call.stage} v${call.version}` : call.stage;
    let text = `${agent} 的 ${name}`;
    if (call.stage === 'feedback')
      text += `\n\n结论：${verdict(agent, call.version) === 'approve' ? '认可' : '需修改'}`;
    return { text, model: `${agent}-model`, durationMs: 1000 };
  };
  return { invoke, calls };
}

/** Runs one /api/run `body` and returns its events, its messages and the room as saved. */
async function run(body, invoke, rooms, signal = new AbortController().signal) {
  const events = [];
  const response = {
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(chunk) {
      for (const line of String(chunk).split('\n').filter(Boolean)) events.push(JSON.parse(line));
    }
  };
  await runDiscussion({ prompt: '三个月内把网站首页的加载时间降到 2 秒以内。', ...body }, response, signal, {
    health,
    invoke,
    rooms
  });
  const roomId = events.find((event) => event.type === 'room').roomId;
  const messages = events.filter((event) => event.type === 'message').map((event) => event.message);
  return { events, messages, roomId, room: rooms.saved.get(roomId) };
}

/** "role:stage" (with "vN" and the verdict for goal mode) of each message, in order. */
const outline = (messages) =>
  messages.map(({ role, stage, version, verdict }) =>
    [`${role}:${stage}`, version && `v${version}`, verdict].filter(Boolean).join(' ')
  );
const notices = (messages) =>
  messages.filter((message) => message.stage === 'notice').map(({ text }) => text);
/** Calls as "agent:stage vN", in the order they were made. */
const described = (calls) =>
  calls.map(({ agent, stage, version }) => `${agent}:${stage}${version ? ` v${version}` : ''}`);
const count = (text, part) => text.split(part).length - 1;

/** Asks to resume the room's latest turn, with moreRounds when given. */
const resume = (h, roomId, turnId, extra = {}) =>
  run({ roomId, resumeTurnId: turnId, prompt: '草稿里的问题', mode: 'both', ...extra }, h.invoke, h.rooms);

/** Expects resuming to be refused with `status` and `message`, before any call. */
async function refused(h, roomId, turnId, extra, status, message) {
  const before = h.calls.length;
  await assert.rejects(
    () => resume(h, roomId, turnId, extra),
    (error) => error instanceof AppError && error.status === status && error.message === message
  );
  assert.equal(h.calls.length, before);
}

test('a goal turn that everyone approves at version 1 ends there', async () => {
  const h = { ...goal(), rooms: store() };
  const { events, messages, room, roomId } = await run(THREE, h.invoke, h.rooms);
  assert.deepEqual(described(h.calls), [
    'codex:proposal',
    'claude:proposal',
    'cursor:proposal',
    'claude:draft v1',
    'codex:feedback v1',
    'cursor:feedback v1'
  ]);
  assert.deepEqual(outline(messages), [
    'user:question',
    'codex:proposal',
    'claude:proposal',
    'cursor:proposal',
    'summary:draft v1',
    'codex:feedback v1 approve',
    'cursor:feedback v1 approve',
    'system:notice'
  ]);
  assert.deepEqual(notices(messages), ['全员认可方案 v1，目标模式结束。']);
  const [question] = messages;
  assert.ok(messages.every((message) => message.turnId === question.id));
  assert.equal(question.configuration.maxRounds, 3);
  const draft = messages.find((message) => message.stage === 'draft');
  assert.deepEqual(
    { provider: draft.provider, model: draft.model, version: draft.version, cap: draft.cap },
    { provider: 'claude', model: 'claude-model', version: 1, cap: 3 }
  );
  assert.equal(room.messages.length, messages.length, 'every message is saved');
  assert.deepEqual(
    [...finalPlans(room)].map((message) => message.id),
    [draft.id]
  );
  assert.equal(goalProgress(room, question, readConfiguration(THREE)).status, 'consensus');

  // Statuses and previews name the stage and the version of the plan.
  const statuses = events.filter((event) => event.type === 'status' && event.text.startsWith('正在'));
  assert.deepEqual(
    [...new Set(statuses.map(({ text }) => text))],
    ['正在提出方案', '正在整理方案 v1', '正在评审方案 v1']
  );
  assert.ok(statuses.filter((event) => event.stage !== 'proposal').every((event) => event.version === 1));

  // The draft merges every proposal; each reviewer reads the whole plan, which names its author.
  const merge = h.calls.find((call) => call.stage === 'draft').prompt;
  assert.equal(count(merge, '<participant_answer '), 3);
  for (const agent of THREE.participants) assert.ok(merge.includes(`${agent} 的 proposal`), agent);
  assert.match(merge, /请以主持人 Claude 的身份把这些方案合并成/);
  for (const call of h.calls.filter((item) => item.stage === 'feedback')) {
    assert.ok(call.prompt.includes('<current_plan participant="Claude" model="claude-model" version="1">'));
    assert.ok(call.prompt.includes('claude 的 draft v1\n</current_plan>'));
    assert.ok(!call.prompt.includes('<participant_feedback'), 'version 1 has no earlier feedback');
    assert.match(call.prompt, /最后单独写一行结论，只能是「结论：认可」或「结论：需修改」。$/);
  }

  await refused(h, roomId, question.id, {}, 409, '这一轮已经完成，无需重试。');
  await refused(h, roomId, question.id, { moreRounds: true }, 409, '这一轮已经完成，无需重试。');
});

test('feedback that asks for changes leads to a revision, which everyone then approves', async () => {
  const h = {
    ...goal({ verdict: (agent, version) => (version === 1 && agent === 'cursor' ? 'revise' : 'approve') }),
    rooms: store()
  };
  const { messages } = await run(THREE, h.invoke, h.rooms);
  assert.deepEqual(described(h.calls).slice(3), [
    'claude:draft v1',
    'codex:feedback v1',
    'cursor:feedback v1',
    'claude:draft v2',
    'codex:feedback v2',
    'cursor:feedback v2'
  ]);
  assert.deepEqual(outline(messages).slice(4), [
    'summary:draft v1',
    'codex:feedback v1 approve',
    'cursor:feedback v1 revise',
    'summary:draft v2',
    'codex:feedback v2 approve',
    'cursor:feedback v2 approve',
    'system:notice'
  ]);
  assert.deepEqual(notices(messages), ['全员认可方案 v2，目标模式结束。']);
  const v2 = messages.find((message) => message.stage === 'draft' && message.version === 2);
  assert.equal(v2.cap, 3);

  // The revision answers every reviewer's feedback on version 1, with its verdict, and starts with what changed.
  const revision = h.calls.find((call) => call.stage === 'draft' && call.version === 2).prompt;
  assert.ok(revision.includes('<current_plan participant="Claude" model="claude-model" version="1">'));
  assert.ok(
    revision.includes('<participant_feedback participant="Codex" verdict="认可">\ncodex 的 feedback v1')
  );
  assert.ok(
    revision.includes('<participant_feedback participant="Cursor" verdict="需修改">\ncursor 的 feedback v1')
  );
  assert.match(revision, /请以主持人 Claude 的身份写出完整的方案 v2。开头用几行列出这一版相对 v1 改了什么/);
  // Reviewers of version 2 read it whole, and each other's feedback on version 1.
  for (const call of h.calls.filter((item) => item.stage === 'feedback' && item.version === 2)) {
    assert.ok(call.prompt.includes('claude 的 draft v2\n</current_plan>'));
    assert.ok(call.prompt.includes('上一轮各位参与者对方案 v1 的评审'));
    assert.equal(count(call.prompt, '<participant_feedback '), 2);
    assert.ok(call.prompt.includes('说明哪些问题已经解决'));
  }
});

test('a turn at its cap without consensus stops, and 继续磨合 raises the cap', async () => {
  const objects = new Set(['codex', 'cursor']);
  const h = {
    ...goal({ verdict: (agent, version) => (objects.has(agent) && version < 4 ? 'revise' : 'approve') }),
    rooms: store()
  };
  const first = await run({ ...THREE, maxRounds: 2 }, h.invoke, h.rooms);
  assert.deepEqual(described(h.calls).slice(3), [
    'claude:draft v1',
    'codex:feedback v1',
    'cursor:feedback v1',
    'claude:draft v2',
    'codex:feedback v2',
    'cursor:feedback v2'
  ]);
  assert.deepEqual(notices(first.messages), [
    '已达到最多 2 版，方案 v2 仍未获得全员认可：Codex 和 Cursor 认为还需修改。可以点「继续磨合」再修改最多 2 版，或根据当前方案继续追问。'
  ]);
  const [question] = first.messages;
  const configuration = readConfiguration(question.configuration);
  const capped = goalProgress(first.room, question, configuration);
  assert.deepEqual([capped.status, capped.cap, capped.objectors], ['capped', 2, ['codex', 'cursor']]);
  assert.equal(finalPlans(first.room).size, 0);

  // Only 继续磨合 goes on: two more versions, each stored with the raised cap.
  await refused(
    h,
    first.roomId,
    question.id,
    {},
    409,
    '这一轮已达到最多版本数，可以点「继续磨合」再修改几版。'
  );
  await refused(h, first.roomId, question.id, { moreRounds: 'yes' }, 400, '「继续磨合」的请求无效。');
  const before = h.calls.length;
  const more = await resume(h, first.roomId, question.id, { moreRounds: true });
  assert.deepEqual(described(h.calls.slice(before)), [
    'claude:draft v3',
    'codex:feedback v3',
    'cursor:feedback v3',
    'claude:draft v4',
    'codex:feedback v4',
    'cursor:feedback v4'
  ]);
  assert.deepEqual(
    more.messages.filter((message) => message.stage === 'draft').map(({ version, cap }) => [version, cap]),
    [
      [3, 4],
      [4, 4]
    ]
  );
  assert.deepEqual(notices(more.messages), ['全员认可方案 v4，目标模式结束。']);
  assert.ok(more.messages.every((message) => message.turnId === question.id));
  assert.ok(!more.messages.some((message) => message.role === 'user'));

  // At the raised cap without consensus, it stops again, and 继续磨合 adds maxRounds once more.
  objects.add('claude');
  const again = { ...goal({ verdict: () => 'revise' }), rooms: store() };
  const once = await run({ ...THREE, maxRounds: 1 }, again.invoke, again.rooms);
  assert.match(
    notices(once.messages)[0],
    /^已达到最多 1 版，方案 v1 仍未获得全员认可：Codex 和 Cursor 认为还需修改。/
  );
  const twice = await resume(again, once.roomId, once.messages[0].id, { moreRounds: true });
  assert.deepEqual(outline(twice.messages), [
    'summary:draft v2',
    'codex:feedback v2 revise',
    'cursor:feedback v2 revise',
    'system:notice'
  ]);
  assert.equal(twice.messages[0].cap, 2);
  assert.match(notices(twice.messages)[0], /^已达到最多 2 版，方案 v2 仍未获得全员认可/);
});

test('a verdict is the last 结论 line, with either colon; anything else asks for changes', () => {
  assert.equal(parseVerdict('方案可行。\n结论：认可'), 'approve');
  assert.equal(parseVerdict('方案可行。\n结论: 认可'), 'approve');
  assert.equal(parseVerdict('方案可行。\n**结论：认可**'), 'approve');
  assert.equal(parseVerdict('还要改。\n结论：需修改'), 'revise');
  assert.equal(parseVerdict('先写 结论：认可，再想想。\n结论：需修改'), 'revise', 'the last one wins');
  assert.equal(parseVerdict('结论：需修改？其实\n结论：认可'), 'approve', 'the last one wins');
  for (const text of ['', '我认可这个方案。', '结论：同意', '结论 认可', 'Conclusion: approve', undefined])
    assert.equal(parseVerdict(text), 'revise', String(text));
});

test('a failed feedback stops the turn without counting as approval, and resuming finishes it', async () => {
  let broken = true;
  const h = {
    ...goal({ fail: ({ agent, stage }) => broken && agent === 'cursor' && stage === 'feedback' }),
    rooms: store()
  };
  const first = await run(THREE, h.invoke, h.rooms);
  assert.deepEqual(outline(first.messages).slice(4), [
    'summary:draft v1',
    'codex:feedback v1 approve',
    'system:error',
    'system:notice'
  ]);
  assert.equal(
    first.messages.find((message) => message.stage === 'error').text,
    'Cursor 评审方案 v1 失败：cursor 出错'
  );
  assert.deepEqual(notices(first.messages), [
    'Cursor 未完成对方案 v1 的评审，无法判断是否全员认可，本轮已暂停。可以重试未完成的部分。'
  ]);
  const [question] = first.messages;
  assert.equal(goalProgress(first.room, question, readConfiguration(THREE)).status, 'incomplete');
  assert.equal(finalPlans(first.room).size, 0);

  // Resuming asks only Cursor for its feedback on version 1; with it, everyone approved.
  broken = false;
  const before = h.calls.length;
  const resumed = await resume(h, first.roomId, question.id);
  assert.deepEqual(described(h.calls.slice(before)), ['cursor:feedback v1']);
  assert.deepEqual(outline(resumed.messages), ['cursor:feedback v1 approve', 'system:notice']);
  assert.deepEqual(notices(resumed.messages), ['全员认可方案 v1，目标模式结束。']);
});

test('fewer than two proposals stop a goal turn before its plan, and resuming asks only for those missing', async () => {
  let broken = true;
  const h = {
    ...goal({ fail: ({ agent, stage }) => broken && stage === 'proposal' && agent !== 'codex' }),
    rooms: store()
  };
  const first = await run(THREE, h.invoke, h.rooms);
  assert.deepEqual(described(h.calls), ['codex:proposal', 'claude:proposal', 'cursor:proposal']);
  assert.deepEqual(notices(first.messages), [
    '完成独立方案的参与者不足两位，本轮已停止整理和评审方案。可以重试未完成的部分，或根据已返回内容继续追问。'
  ]);
  assert.ok(!first.messages.some((message) => message.stage === 'draft'));
  broken = false;
  const before = h.calls.length;
  const resumed = await resume(h, first.roomId, first.messages[0].id);
  assert.deepEqual(described(h.calls.slice(before)), [
    'claude:proposal',
    'cursor:proposal',
    'claude:draft v1',
    'codex:feedback v1',
    'cursor:feedback v1'
  ]);
  assert.equal(count(h.calls.find((call) => call.stage === 'draft').prompt, '<participant_answer '), 3);
  assert.deepEqual(notices(resumed.messages), ['全员认可方案 v1，目标模式结束。']);
});

test('without the moderator’s proposal, the first participant who proposed writes and revises the plan', async () => {
  const h = {
    ...goal({
      fail: ({ agent, stage }) => agent === 'claude' && stage === 'proposal',
      verdict: (agent, version) => (version === 1 && agent === 'claude' ? 'revise' : 'approve')
    }),
    rooms: store()
  };
  const { messages } = await run(THREE, h.invoke, h.rooms);
  assert.deepEqual(notices(messages), [
    'Claude 未完成独立方案，方案 v1 只基于 Codex 和 Cursor 的方案整理。',
    '主持人 Claude 未完成独立方案，本轮改由 Codex 整理和修改方案。',
    '全员认可方案 v2，目标模式结束。'
  ]);
  // Codex writes both versions; Claude, still a participant, reviews them.
  assert.deepEqual(described(h.calls).slice(3), [
    'codex:draft v1',
    'claude:feedback v1',
    'cursor:feedback v1',
    'codex:draft v2',
    'claude:feedback v2',
    'cursor:feedback v2'
  ]);
  const merge = h.calls.find((call) => call.stage === 'draft' && call.version === 1).prompt;
  assert.ok(merge.includes('Claude 未完成独立方案，上面没有其内容；不要替其补写、推测或代表其观点。'));
  assert.ok(merge.includes('原定主持人 Claude 未完成独立方案，请你以 Codex 的身份代为主持'));
  assert.equal(count(merge, '<participant_answer '), 2);
  assert.ok(
    messages.filter((message) => message.stage === 'draft').every((draft) => draft.provider === 'codex')
  );
});

test('analysis focus shapes proposals and feedback, not the moderator’s plan', async () => {
  const h = {
    ...goal({ verdict: (_agent, version) => (version === 1 ? 'revise' : 'approve') }),
    rooms: store()
  };
  const settings = {
    codex: { capability: 'risk' },
    claude: { capability: 'plan' },
    cursor: { capability: 'verify' }
  };
  await run({ ...THREE, settings }, h.invoke, h.rooms);
  for (const call of h.calls) {
    const focus = capabilityPrompt(settings[call.agent].capability);
    assert.equal(
      call.prompt.includes(focus),
      call.stage !== 'draft',
      `${call.agent}:${call.stage} v${call.version}`
    );
  }
});

test('stopping during feedback keeps what was done, and the turn resumes from there', async () => {
  const controller = new AbortController();
  const h = { ...goal(), rooms: store() };
  const stopping = async (agent, prompt, ...rest) => {
    if (agent === 'cursor' && stageOf(prompt).stage === 'feedback') {
      // Stopped once Codex's feedback is saved: an answer that arrives after the stop is not kept.
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      throw new Error('已停止');
    }
    return h.invoke(agent, prompt, ...rest);
  };
  const first = await run(THREE, stopping, h.rooms, controller.signal);
  assert.deepEqual(outline(first.messages).slice(-3), [
    'summary:draft v1',
    'codex:feedback v1 approve',
    'system:notice'
  ]);
  assert.deepEqual(notices(first.messages), ['讨论已停止。已完成的方案和评审保留；未完成的调用已终止。']);
  const before = h.calls.length;
  await resume(h, first.roomId, first.messages[0].id);
  assert.deepEqual(described(h.calls.slice(before)), ['cursor:feedback v1']);
});

test('a revision that fails is written again on resume, with the cap of the turn', async () => {
  let broken = true;
  const h = {
    ...goal({
      fail: ({ stage, version }) => broken && stage === 'draft' && version === 2,
      verdict: (_agent, version) => (version === 1 ? 'revise' : 'approve')
    }),
    rooms: store()
  };
  const first = await run({ ...THREE, maxRounds: 5 }, h.invoke, h.rooms);
  assert.deepEqual(outline(first.messages).slice(-2), ['cursor:feedback v1 revise', 'system:error']);
  assert.equal(first.messages.at(-1).text, 'Claude 整理方案 v2 失败：claude 出错');
  broken = false;
  const resumed = await resume(h, first.roomId, first.messages[0].id);
  const v2 = resumed.messages[0];
  assert.deepEqual([v2.stage, v2.version, v2.cap], ['draft', 2, 5]);
  assert.deepEqual(notices(resumed.messages), ['全员认可方案 v2，目标模式结束。']);
});

test('an invalid maxRounds is refused before anything is written', async () => {
  const rooms = store();
  for (const maxRounds of [0, 7, 2.5, '3']) {
    await assert.rejects(
      () => run({ ...THREE, maxRounds }, goal().invoke, rooms),
      (error) =>
        error instanceof AppError &&
        error.status === 400 &&
        error.message === '「最多几版」必须是 1 到 6 之间的整数。'
    );
  }
  assert.equal(rooms.saved.size, 0);
});

test('rooms and turns from before goal mode run, resume and read as before', async () => {
  // A debate saved by an older version: its configuration has no maxRounds, and Claude's review is missing.
  const turnId = '00000000-0000-4000-8000-0000000000a1';
  const message = (id, role, stage, extra = {}) => ({
    id: `00000000-0000-4000-8000-0000000000${id}`,
    turnId,
    role,
    stage,
    text: `${role} ${stage}`,
    createdAt: '2026-03-01T00:00:00.000Z',
    ...extra
  });
  const configuration = { mode: 'debate', participants: ['codex', 'claude'], moderator: 'codex' };
  const room = {
    id: '00000000-0000-4000-8000-000000000001',
    title: '旧讨论',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
    context: '',
    configuration,
    messages: [
      { ...message('a1', 'user', 'question', { configuration }), id: turnId },
      message('b1', 'codex', 'analysis', { provider: 'codex' }),
      message('b2', 'claude', 'analysis', { provider: 'claude' }),
      message('b3', 'codex', 'review', { provider: 'codex' })
    ]
  };
  assert.equal(goalTurns(room).size, 0);
  const rooms = store();
  await rooms.save(room);
  const calls = [];
  const invoke = async (agent, prompt) => {
    calls.push(agent);
    return { text: prompt.includes('整理各方意见') ? '总结' : `${agent} 审查`, model: 'm' };
  };
  const resumed = await run({ roomId: room.id, resumeTurnId: turnId }, invoke, rooms);
  assert.deepEqual(outline(resumed.messages), ['claude:review', 'summary:summary']);
  const saved = resumed.room;
  const debate = readConfiguration(saved.messages[0].configuration);
  assert.equal(turnComplete(debate, turnProgress(saved, saved.messages[0], debate.participants)), true);

  // A goal-mode follow-up in the same room reads the debate as its history.
  const h = { ...goal(), rooms };
  const next = await run(
    { ...THREE, roomId: room.id, prompt: '照这个结论定一个执行方案。' },
    h.invoke,
    h.rooms
  );
  assert.ok(h.calls[0].prompt.includes('[决策归纳（Codex） / m / 讨论总结]\n总结'));
  assert.equal(next.room.configuration.mode, 'goal');
  assert.equal(goalTurns(next.room).size, 1);
});

test('later questions see each goal turn’s latest version first, named as the final plan once approved', () => {
  const turn = (id, versions, approved) => {
    const question = {
      id,
      turnId: id,
      role: 'user',
      stage: 'question',
      text: `目标 ${id}`,
      configuration: { mode: 'goal', participants: ['codex', 'claude'], moderator: 'codex', maxRounds: 3 }
    };
    const messages = [
      question,
      { turnId: id, role: 'claude', stage: 'proposal', provider: 'claude', text: 'P'.repeat(3000) }
    ];
    for (let version = 1; version <= versions; version++) {
      messages.push({
        turnId: id,
        role: 'summary',
        stage: 'draft',
        provider: 'codex',
        model: 'cm',
        version,
        cap: 3,
        // Earlier versions are long, so that with little room only the latest of each turn fits.
        text: `方案正文 ${id} v${version}` + (version < versions ? 'D'.repeat(400) : '')
      });
      const verdict = version === versions && approved ? 'approve' : 'revise';
      messages.push({
        turnId: id,
        role: 'claude',
        stage: 'feedback',
        provider: 'claude',
        version,
        verdict,
        text: `评审 ${id} v${version}` + 'R'.repeat(500)
      });
    }
    return messages;
  };
  const room = { messages: [...turn('t1', 2, true), ...turn('t2', 3, false)] };
  const { text } = historyFor(room);
  assert.ok(text.includes('[主持人（Codex） / cm / 方案 v1]\n方案正文 t1 v1'));
  assert.ok(text.includes('[主持人（Codex） / cm / 最终方案 v2]\n方案正文 t1 v2'));
  assert.ok(
    text.includes('[主持人（Codex） / cm / 方案 v3]\n方案正文 t2 v3'),
    'capped: the latest, not final'
  );
  assert.ok(text.includes('[Claude / 评审方案 v2（认可）]\n评审 t1 v2'));
  assert.ok(text.includes('[Claude / 评审方案 v1（需修改）]'));
  assert.ok(text.includes('[Claude / 独立方案]'));
  // With little room, the questions and each turn's latest version are kept before anything else.
  const tight = historyFor(room, '', { limit: 600 }).text;
  for (const part of ['目标 t1', '方案正文 t1 v2', '目标 t2', '方案正文 t2 v3'])
    assert.ok(tight.includes(part), part);
  for (const part of ['方案正文 t1 v1', '评审 t1 v2', 'PPP']) assert.ok(!tight.includes(part), part);
});
