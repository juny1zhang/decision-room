// One discussion turn: checks, independent analyses, cross-reviews and the moderator's summary, or in goal
// mode proposals and versions of one plan until every participant approves (see goal.mjs), streamed to the
// browser as NDJSON events and saved to the room after every message.
//
// Events: { type: 'room', roomId, title } first; { type: 'message', message } for every saved message;
// { type: 'status', agent, stage, text, version?, retry? } as a participant starts, thinks, searches the
// web, retries after a lost connection (retry: true; its preview starts over), finishes or fails (stage
// 'error'); { type: 'delta', agent, stage, version?, append, reset? } with the text a participant's CLI
// streams before its answer is final (see livePreview); { type: 'heartbeat' } while nothing else happens;
// { type: 'done', roomId } last. version is the version of the plan a goal-mode draft or feedback is about.
// Answer messages also store durationMs and, when the CLI reports it, usage { inputTokens, outputTokens,
// cachedInputTokens }.
//
// Every message of a turn carries turnId, the id of the turn's question (the question's own included). A
// call that fails for a network reason is tried once more. A debate goes on without the participants that
// failed as long as two analyses (then two reviews) succeeded; a goal turn as long as two proposals did,
// but every feedback is needed to know whether everyone approves. An incomplete turn can be resumed:
// { roomId, resumeTurnId } runs only what is missing of it (see turnProgress and goalProgress); a goal turn
// that reached its cap without consensus goes on with { roomId, resumeTurnId, moreRounds: true }.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { HEARTBEAT_INTERVAL, MAX_CONTEXT, MAX_MESSAGES, MAX_PROMPT, MAX_REPLY } from './config.mjs';
import { AppError } from './errors.mjs';
import { goalProgress, parseVerdict } from './goal.mjs';
import {
  contextInEffect,
  hasContextSnapshot,
  messageText,
  questionContexts,
  resultModel,
  roomMessages
} from './messages.mjs';
import {
  analysisPrompt,
  draftPrompt,
  feedbackPrompt,
  historyFor,
  participantNames,
  proposalPrompt,
  reviewPrompt,
  revisionPrompt,
  roundPrompt,
  summaryPrompt,
  withCapability
} from './prompts.mjs';
import { providerLabel } from './providers/index.mjs';
import { safeDetail } from './redact.mjs';
import { defaultTitle } from './titles.mjs';
import { readConfiguration, readTurnId, savedConfiguration } from './validation.mjs';

const STAGE_STATUS = {
  analysis: '正在独立分析',
  review: '正在交叉审查',
  summary: '正在整理决策结论',
  proposal: '正在提出方案',
  draft: '正在整理方案',
  feedback: '正在评审方案'
};
const STAGE_TASK = {
  analysis: '分析',
  review: '审查',
  summary: '整理',
  proposal: '提出方案',
  draft: '整理方案',
  feedback: '评审方案'
};
/** "正在整理方案 v2": the status of a call for `stage`, naming the version of the plan it is about. */
const stageStatus = (stage, version) => STAGE_STATUS[stage] + (version ? ` v${version}` : '');
/** The moderator's stages, which take no participant's analysis focus. */
const MODERATOR_STAGES = new Set(['summary', 'draft']);
/** Status of what a model does while it answers (see invoke.mjs); 'writing' shows the stage's status. */
const ACTIVITY_STATUS = { thinking: '正在思考', searching: '正在检索网页' };
/** Least time between two preview events of one call. */
const DELTA_INTERVAL = 120;
/** Wait before the one retry of a call that lost its connection. */
export const RETRY_DELAY = 1500;
const RETRY_STATUS = '连接中断，正在重试…';

/**
 * The live preview of one call by `agent` for `stage` (about `version` of a goal-mode plan, if given).
 * text(chunk) collects the answer text the CLI streams and emits it as { type: 'delta', agent, stage,
 * version?, append } at most once per DELTA_INTERVAL; the first event of the call also carries reset: true,
 * so the page starts this preview over (should an earlier call for the same agent and stage have left one).
 * Up to MAX_REPLY characters are previewed. close() stops it; close({ flush: true }) first emits the text
 * still waiting, so that the deltas add up to all the streamed text before the final message arrives.
 */
function livePreview(emit, agent, stage, version) {
  let pending = '';
  let size = 0;
  let sentAt = -Infinity;
  let timer = null;
  let started = false;
  let closed = false;
  const send = () => {
    clearTimeout(timer);
    timer = null;
    if (closed || !pending) return;
    emit({
      type: 'delta',
      agent,
      stage,
      ...(version && { version }),
      append: pending,
      ...(!started && { reset: true })
    });
    started = true;
    pending = '';
    sentAt = Date.now();
  };
  return {
    text(chunk) {
      if (closed || typeof chunk !== 'string' || !chunk || size >= MAX_REPLY) return;
      const part = chunk.slice(0, MAX_REPLY - size);
      size += part.length;
      pending += part;
      if (timer) return;
      const wait = sentAt + DELTA_INTERVAL - Date.now();
      if (wait > 0) timer = setTimeout(send, wait);
      else send();
    },
    close({ flush = false } = {}) {
      if (flush) send();
      clearTimeout(timer);
      closed = true;
    }
  };
}

/** The wall-clock time and token usage of an answer, as stored with its message, when known. */
function answerMeasures({ durationMs, usage }) {
  return {
    ...(Number.isFinite(durationMs) && { durationMs }),
    ...(usage && { usage })
  };
}

/**
 * The single discussion that may run at a time, so it can be refused, cancelled and reported as busy, and the
 * room it writes to, which may not be renamed or deleted meanwhile. begin(roomId) starts one and returns its
 * AbortController; claim(controller, roomId) records its room once known (a new room's id is made later);
 * roomId() is that room's id, or null.
 */
export function createActiveRun() {
  let controller = null;
  let room = null;
  return {
    isBusy: () => controller !== null,
    roomId: () => room,
    begin(roomId = null) {
      controller = new AbortController();
      room = roomId;
      return controller;
    },
    claim(running, roomId) {
      if (controller === running) room = roomId;
    },
    end(finished) {
      if (controller !== finished) return;
      controller = null;
      room = null;
    },
    abort() {
      controller?.abort();
    }
  };
}

/**
 * Throws an AppError when a participant cannot take part as configured: it is not logged in with a
 * subscription, cannot search the web when asked to, or its model does not offer the chosen reasoning level.
 */
function checkParticipants(currentHealth, { participants, settings, webSearch }) {
  for (const agent of participants) {
    const info = currentHealth[agent];
    const label = providerLabel(agent);
    if (!info.subscription) throw new AppError(`${label} 尚未通过登录检查。${info.message}`, 409);
    if (webSearch && !info.supportsWeb)
      throw new AppError(`${label} 当前不支持网页检索，请关闭检索或调整参与者。`);
    const { model, reasoning } = settings[agent];
    const supportedLevels = Object.hasOwn(info.reasoningByModel || {}, model)
      ? info.reasoningByModel[model]
      : info.reasoningLevels || [];
    if (reasoning && !supportedLevels.includes(reasoning))
      throw new AppError(`${label} 的所选模型不支持该推理强度。`);
  }
}

/**
 * What a new question asked with the shared `context` stores about it: { context } when that differs from the
 * context in effect for the previous question (for a room's first question: when it is not empty), else {}.
 * A room saved before questions carried snapshots keeps its old context as room.legacyContext once a question
 * changes it, so that its earlier questions still show the context they were asked with.
 */
function contextChange(room, context) {
  const previous = contextInEffect(room);
  if (context === previous) return {};
  if (previous && !roomMessages(room).some(hasContextSnapshot)) room.legacyContext = previous;
  return { context };
}

/** The status note saved when the history sent with a question had to be cut: what was cut, by count. */
function historyNotice({ omitted, shortened }) {
  const cuts = [];
  if (omitted) cuts.push(`省略了 ${omitted} 条发言`);
  if (shortened) cuts.push(`缩短了 ${shortened} 条较长的发言（保留开头和结尾）`);
  return `为控制长度，本轮发送给模型的讨论记录${cuts.join('，并')}；完整记录仍可查看和导出。`;
}

/** An answer message as material for a review, summary or goal-mode prompt. */
const materialOf = (message) => ({
  agent: message.provider,
  model: resultModel(message),
  text: messageText(message)
});
/** A feedback message as material for a goal-mode prompt, with its verdict. */
const feedbackOf = (message) => ({ ...materialOf(message), verdict: message.verdict });

/**
 * What the turn that `question` started in `room` holds for `participants`: { analyses, reviews,
 * summarized }. analyses and reviews map each participant to its latest analysis and review message;
 * summarized tells whether a summary came after the last of them.
 */
export function turnProgress(room, question, participants) {
  const analyses = new Map();
  const reviews = new Map();
  let summaryAt = -1;
  let answerAt = -1;
  roomMessages(room).forEach((message, index) => {
    if (message === question || message.turnId !== question.id) return;
    if (message.role === 'summary' && message.stage === 'summary') summaryAt = index;
    else if (participants.includes(message.role) && ['analysis', 'review'].includes(message.stage)) {
      (message.stage === 'analysis' ? analyses : reviews).set(message.role, message);
      answerAt = index;
    }
  });
  return { analyses, reviews, summarized: summaryAt > answerAt };
}

/**
 * Whether a turn asked with `configuration` is complete: every participant answered, and in a debate also
 * reviewed, and a summary came after all of that.
 */
export function turnComplete({ mode, participants }, { analyses, reviews, summarized }) {
  if (!participants.every((agent) => analyses.has(agent))) return false;
  return mode !== 'debate' || (participants.every((agent) => reviews.has(agent)) && summarized);
}

/**
 * The turn a { roomId, resumeTurnId, moreRounds? } body asks to resume, as { room, question, configuration,
 * prompt, context, history, progress }: the configuration, question and shared context it was asked with,
 * the earlier discussion as it was then (see historyFor) and what the turn holds (see turnProgress, and
 * goalProgress for goal mode). Throws an AppError when it cannot be resumed: unknown or a moreRounds that is
 * not a boolean (400), saved without turn ids by an older version, not the room's latest turn, without a
 * readable configuration, complete, or a goal turn at its cap without moreRounds (409).
 */
async function resumedTurn(body, rooms) {
  const turnId = readTurnId(body.resumeTurnId);
  const { moreRounds = false } = body;
  if (typeof moreRounds !== 'boolean') throw new AppError('「继续磨合」的请求无效。');
  if (typeof body.roomId !== 'string') throw new AppError('请指定要重试的讨论。');
  const room = await rooms.load(body.roomId);
  const messages = roomMessages(room);
  const index = messages.findIndex((message) => message.id === turnId && message.role === 'user');
  if (index < 0) throw new AppError('找不到要重试的这一轮讨论。');
  const question = messages[index];
  if (question.turnId !== question.id)
    throw new AppError('这一轮来自旧版本的记录，无法重试。请重新提问。', 409);
  if (messages.slice(index + 1).some((message) => message.role === 'user'))
    throw new AppError('只能重试最近一轮未完成的部分。', 409);
  const saved = savedConfiguration(question.configuration);
  const prompt = messageText(question).trim();
  if (!saved || !prompt) throw new AppError('这一轮的设置或问题无法读取，无法重试。请重新提问。', 409);
  const configuration = readConfiguration(saved);
  let progress;
  if (configuration.mode === 'goal') {
    progress = goalProgress(room, question, configuration);
    if (progress.status === 'consensus') throw new AppError('这一轮已经完成，无需重试。', 409);
    if (progress.status === 'capped' && !moreRounds)
      throw new AppError('这一轮已达到最多版本数，可以点「继续磨合」再修改几版。', 409);
  } else {
    progress = turnProgress(room, question, configuration.participants);
    if (turnComplete(configuration, progress)) throw new AppError('这一轮已经完成，无需重试。', 409);
  }
  // The history as the question saw it: the messages before it, with the contexts they were asked with.
  const contexts = questionContexts(room);
  const context = contexts.get(question) ?? '';
  const before = messages.slice(0, index);
  const earlier = before.findLast((message) => message.role === 'user');
  const history = historyFor(
    { ...room, messages: before, context: earlier ? contexts.get(earlier) : '' },
    context
  );
  return { room, question, configuration, prompt, context, history, progress, moreRounds };
}

/**
 * Runs what is missing of a goal turn (see goal.mjs), from `progress` (goalProgress) when resuming, else from
 * nothing: the participants' proposals and version 1 of the plan until it exists, then feedback on the latest
 * version from every participant but its author, then, until everyone approves or the cap is reached, the
 * next version by the same author. `moreRounds` lifts the cap of a turn that reached it by
 * configuration.maxRounds versions. perform, notice, base and signal are runDiscussion's.
 */
async function runGoal({ configuration, progress, moreRounds, base, perform, notice, signal }) {
  const { participants: agents, moderator, maxRounds } = configuration;
  const stopped = () => notice('讨论已停止。已完成的方案和评审保留；未完成的调用已终止。');
  const proposals = new Map(progress?.proposals);
  const rounds = progress
    ? progress.rounds.map((round) => ({ ...round, feedback: new Map(round.feedback) }))
    : [];
  // The cap is stored with every version written under it, so that a resumed turn keeps it.
  let cap = progress?.cap ?? maxRounds;
  if (progress?.status === 'capped' && moreRounds) cap = progress.latest.version + maxRounds;

  if (!rounds.length) {
    const missing = agents.filter((agent) => !proposals.has(agent));
    const answers = await Promise.all(
      missing.map((agent) => perform(agent, proposalPrompt(base), 'proposal'))
    );
    missing.forEach((agent, index) => answers[index] && proposals.set(agent, answers[index]));
    if (signal.aborted) return stopped();
    const proposed = agents.filter((agent) => proposals.has(agent));
    const unproposed = agents.filter((agent) => !proposals.has(agent));
    if (proposed.length < 2)
      return notice(
        '完成独立方案的参与者不足两位，本轮已停止整理和评审方案。可以重试未完成的部分，或根据已返回内容继续追问。'
      );
    if (unproposed.length)
      await notice(
        `${participantNames(unproposed)} 未完成独立方案，方案 v1 只基于 ${participantNames(proposed)} 的方案整理。`
      );
    // The moderator writes the plan when its own proposal succeeded, else the first participant whose did.
    const author = proposals.has(moderator) ? moderator : proposed[0];
    if (author !== moderator)
      await notice(
        `主持人 ${providerLabel(moderator)} 未完成独立方案，本轮改由 ${providerLabel(author)} 整理和修改方案。`
      );
    const draft = await perform(
      author,
      draftPrompt(base, {
        proposals: proposed.map((agent) => materialOf(proposals.get(agent))),
        missing: unproposed,
        moderator: author,
        standingInFor: author === moderator ? null : moderator
      }),
      'draft',
      { role: 'summary', version: 1, metadata: { version: 1, cap } }
    );
    if (!draft) return signal.aborted ? stopped() : undefined;
    rounds.push({ draft, version: 1, feedback: new Map() });
  }

  for (;;) {
    const { draft, version, feedback } = rounds.at(-1);
    const author = draft.provider;
    const plan = { ...materialOf(draft), version };
    const reviewers = agents.filter((agent) => agent !== author);
    // From version 2 on, the reviewers also read each other's feedback on the version before.
    const before = rounds.at(-2);
    const previous = before
      ? agents
          .filter((agent) => before.feedback.has(agent))
          .map((agent) => feedbackOf(before.feedback.get(agent)))
      : [];
    const missing = reviewers.filter((agent) => !feedback.has(agent));
    const answers = await Promise.all(
      missing.map((agent) =>
        perform(agent, feedbackPrompt(base, { plan, previous, reviewer: agent }), 'feedback', {
          version,
          metadata: (text) => ({ version, verdict: parseVerdict(text) })
        })
      )
    );
    missing.forEach((agent, index) => answers[index] && feedback.set(agent, answers[index]));
    if (signal.aborted) return stopped();
    const unreviewed = reviewers.filter((agent) => !feedback.has(agent));
    // A missing feedback is no approval: without it, no one can tell whether everyone approves.
    if (unreviewed.length)
      return notice(
        `${participantNames(unreviewed)} 未完成对方案 v${version} 的评审，无法判断是否全员认可，本轮已暂停。可以重试未完成的部分。`
      );
    const objectors = reviewers.filter((agent) => feedback.get(agent).verdict !== 'approve');
    if (!objectors.length) return notice(`全员认可方案 v${version}，目标模式结束。`);
    if (version >= cap)
      return notice(
        `已达到最多 ${cap} 版，方案 v${version} 仍未获得全员认可：${participantNames(objectors)} 认为还需修改。` +
          `可以点「继续磨合」再修改最多 ${maxRounds} 版，或根据当前方案继续追问。`
      );
    const next = await perform(
      author,
      revisionPrompt(base, {
        plan,
        feedback: reviewers.map((agent) => feedbackOf(feedback.get(agent))),
        moderator: author
      }),
      'draft',
      { role: 'summary', version: version + 1, metadata: { version: version + 1, cap } }
    );
    if (!next) return signal.aborted ? stopped() : undefined;
    rounds.push({ draft: next, version: version + 1, feedback: new Map() });
  }
}

/**
 * Runs one turn for a /api/run `body` and streams it to `response`: a new question ({ roomId?, prompt,
 * context, ...configuration }), or with { roomId, resumeTurnId } what is missing of the room's latest turn,
 * with the configuration, question and context it was asked with. Throws an AppError, before anything is
 * written, when the request is invalid or a participant is not ready. `signal` stops the turn; work already
 * finished is kept. deps: { health (a health checker), invoke (see invoke.mjs), rooms (a room store), onRoom
 * (optional: called with the room's id once it is known, before the room is first saved) }.
 */
export async function runDiscussion(body, response, signal, { health, invoke, rooms, onRoom }) {
  const resume = body.resumeTurnId !== undefined ? await resumedTurn(body, rooms) : null;
  const configuration = resume ? resume.configuration : readConfiguration(body);
  const { mode, participants: agents, moderator, settings, webSearch } = configuration;
  let prompt, context;
  if (resume) ({ prompt, context } = resume);
  else {
    prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    context = typeof body.context === 'string' ? body.context : '';
    if (!prompt || prompt.length > MAX_PROMPT) throw new AppError('问题不能为空，且不能超过 20,000 字符。');
    if (context.length > MAX_CONTEXT) throw new AppError('共享背景不能超过 40,000 字符。');
  }
  // Reads every participant's login status again; version, help and model checks are reused.
  const currentHealth = await health.check('login', signal, agents);
  if (signal.aborted) throw new AppError('讨论已停止。');
  checkParticipants(currentHealth, configuration);
  const now = new Date().toISOString();
  const room = resume
    ? resume.room
    : body.roomId
      ? await rooms.load(body.roomId)
      : {
          id: randomUUID(),
          title: defaultTitle(prompt),
          createdAt: now,
          updatedAt: now,
          context,
          messages: []
        };
  onRoom?.(room.id);
  if (room.messages.length >= MAX_MESSAGES) throw new AppError('本次讨论已较长，请新开讨论并填写简短背景。');
  const turnId = resume ? resume.question.id : randomUUID();
  const previous = resume ? resume.history : historyFor(room, context);
  let question;
  if (!resume) {
    question = { configuration, ...contextChange(room, context) };
    room.context = context;
    room.configuration = configuration;
  }
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });
  const emit = (event) => {
    if (!response.destroyed && !response.writableEnded) response.write(JSON.stringify(event) + '\n');
  };
  const add = async (role, text, stage, metadata = {}) => {
    const message = {
      id: randomUUID(),
      turnId,
      role,
      text,
      stage,
      createdAt: new Date().toISOString(),
      ...metadata
    };
    room.messages.push(message);
    room.updatedAt = message.createdAt;
    await rooms.save(room);
    emit({ type: 'message', message });
    return message;
  };
  const notice = (text) => add('system', text, 'notice');
  emit({ type: 'room', roomId: room.id, title: room.title });
  const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), HEARTBEAT_INTERVAL);
  try {
    if (!resume) {
      await add('user', prompt, 'question', { id: turnId, ...question });
      if (previous.omitted || previous.shortened) await notice(historyNotice(previous));
    }
    const base = roundPrompt({ context, history: previous.text, prompt });
    const status = (agent, stage, text, extra) => emit({ type: 'status', agent, stage, text, ...extra });

    // Resolves to the saved answer message, or to null when the call failed (recorded as an error message)
    // or was stopped. While the call runs, its streamed text goes out as delta events and what the model
    // does as statuses. A call that fails for a network reason is tried once more after RETRY_DELAY.
    // options: role (of the message; the agent's id by default); version, the version of the plan a
    // goal-mode call is about, named in its statuses, previews and error; metadata, stored with the answer,
    // or a function of the answer's text that returns it.
    const perform = async (agent, task, stage, { role = agent, version, metadata = {} } = {}) => {
      if (signal.aborted) return null;
      // A participant's analysis focus shapes its own answers, not the moderator's summary or plan.
      const focused = MODERATOR_STAGES.has(stage) ? task : withCapability(settings[agent].capability, task);
      const writing = stageStatus(stage, version);
      const extra = version ? { version } : {};
      let shown = writing;
      status(agent, stage, shown, extra);
      const onActivity = (kind) => {
        const text = kind === 'writing' ? writing : ACTIVITY_STATUS[kind];
        if (!text || text === shown || signal.aborted) return;
        shown = text;
        status(agent, stage, text, extra);
      };
      for (let attempt = 1; ; attempt++) {
        const preview = livePreview(emit, agent, stage, version);
        let answer;
        try {
          answer = await invoke(agent, focused, webSearch, signal, settings[agent], {
            onText: preview.text,
            onActivity
          });
        } catch (e) {
          preview.close();
          if (signal.aborted) return null;
          if (attempt === 1 && e.category === 'network') {
            shown = RETRY_STATUS;
            status(agent, stage, RETRY_STATUS, { ...extra, retry: true });
            await sleep(RETRY_DELAY, undefined, { signal }).catch(() => {});
            if (signal.aborted) return null;
            shown = writing;
            status(agent, stage, shown, extra);
            continue;
          }
          const failed = STAGE_TASK[stage] + (version ? ` v${version} ` : '');
          await add('system', `${providerLabel(agent)} ${failed}失败：${safeDetail(e.message)}`, 'error');
          status(agent, 'error', '本轮未完成');
          return null;
        }
        preview.close({ flush: !signal.aborted });
        if (signal.aborted) return null;
        const message = await add(role, answer.text, stage, {
          provider: agent,
          model: answer.model,
          ...answerMeasures(answer),
          ...(typeof metadata === 'function' ? metadata(answer.text) : metadata)
        });
        status(agent, stage, '已完成', extra);
        return message;
      }
    };

    if (mode === 'goal')
      return void (await runGoal({
        configuration,
        progress: resume?.progress,
        moreRounds: Boolean(resume?.moreRounds),
        base,
        perform,
        notice,
        signal
      }));

    // What the turn holds: from the stored turn when resuming, else nothing yet.
    const analyses = new Map(resume?.progress.analyses);
    const reviews = new Map(resume?.progress.reviews);
    const summarized = Boolean(resume?.progress.summarized);
    let added = false; // whether this run added an analysis or a review
    /** Runs `stage` for `members` at once, `task(agent)` being each one's prompt, and keeps what succeeded. */
    const runStage = async (stage, members, task) => {
      const answers = await Promise.all(members.map((agent) => perform(agent, task(agent), stage)));
      members.forEach((agent, index) => {
        if (!answers[index]) return;
        (stage === 'analysis' ? analyses : reviews).set(agent, answers[index]);
        added = true;
      });
    };

    await runStage(
      'analysis',
      agents.filter((agent) => !analyses.has(agent)),
      () => analysisPrompt(base)
    );
    if (signal.aborted) return void (await notice('讨论已停止。已完成的回答保留；未完成的调用已终止。'));
    if (mode !== 'debate') return;
    const analysed = agents.filter((agent) => analyses.has(agent));
    const unanalysed = agents.filter((agent) => !analyses.has(agent));
    if (analysed.length < 2)
      return void (await notice(
        '完成独立分析的参与者不足两位，本轮已停止交叉审查和归纳。可以重试未完成的部分，或根据已返回内容继续追问。'
      ));
    const reviewers = analysed.filter((agent) => !reviews.has(agent));
    // Nothing to review and nothing new to summarize: a resumed turn whose missing analysis failed again.
    if (!reviewers.length && !added && summarized) return;
    if (unanalysed.length)
      await notice(
        `${participantNames(unanalysed)} 未完成独立分析，交叉审查和归纳只基于 ${participantNames(analysed)} 的分析继续。`
      );
    const analysisMaterial = analysed.map((agent) => materialOf(analyses.get(agent)));
    await runStage('review', reviewers, (agent) =>
      reviewPrompt(base, { analyses: analysisMaterial, missing: unanalysed, reviewer: agent })
    );
    if (signal.aborted) return void (await notice('讨论已停止，已完成的回答与审查保留。'));
    const reviewed = analysed.filter((agent) => reviews.has(agent));
    if (reviewed.length < 2)
      return void (await notice(
        '完成交叉审查的参与者不足两位，因此本轮没有生成联合归纳。可以重试未完成的部分，或根据已返回内容继续追问。'
      ));
    if (!added && summarized) return;
    const unreviewed = analysed.filter((agent) => !reviews.has(agent));
    if (unreviewed.length)
      await notice(
        `${participantNames(unreviewed)} 未完成交叉审查，归纳只基于 ${participantNames(reviewed)} 的审查。`
      );
    // The moderator summarizes when its own analysis succeeded, else the first participant whose did.
    const summarizer = analyses.has(moderator) ? moderator : analysed[0];
    if (summarizer !== moderator)
      await notice(
        `主持人 ${providerLabel(moderator)} 未完成独立分析，本轮改由 ${providerLabel(summarizer)} 整理决策结论。`
      );
    await perform(
      summarizer,
      summaryPrompt(base, {
        analyses: analysisMaterial,
        reviews: reviewed.map((agent) => materialOf(reviews.get(agent))),
        missingAnalyses: unanalysed,
        missingReviews: unreviewed,
        moderator: summarizer,
        standingInFor: summarizer === moderator ? null : moderator
      }),
      'summary',
      { role: 'summary' }
    );
    if (signal.aborted) await notice('讨论已停止，已完成内容保留。');
  } finally {
    clearInterval(heartbeat);
    emit({ type: 'done', roomId: room.id });
  }
}
