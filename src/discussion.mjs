// One discussion round: checks, independent analyses, cross-reviews and the moderator's summary, streamed
// to the browser as NDJSON events and saved to the room after every message.
//
// Events: { type: 'room', roomId, title } first; { type: 'message', message } for every saved message;
// { type: 'status', agent, stage, text } as a participant starts, thinks, searches the web, finishes or
// fails (stage 'error'); { type: 'delta', agent, stage, append, reset? } with the text a participant's CLI
// streams before its answer is final (see livePreview); { type: 'heartbeat' } while nothing else happens;
// { type: 'done', roomId } last. Answer messages also store durationMs and, when the CLI reports it,
// usage { inputTokens, outputTokens, cachedInputTokens }.
import { randomUUID } from 'node:crypto';
import { HEARTBEAT_INTERVAL, MAX_CONTEXT, MAX_MESSAGES, MAX_PROMPT, MAX_REPLY } from './config.mjs';
import { AppError } from './errors.mjs';
import { contextInEffect, hasContextSnapshot, roomMessages } from './messages.mjs';
import {
  analysisPrompt,
  attributed,
  historyFor,
  reviewPrompt,
  roundPrompt,
  summaryPrompt,
  withCapability
} from './prompts.mjs';
import { providerLabel } from './providers/index.mjs';
import { safeDetail } from './redact.mjs';
import { defaultTitle } from './titles.mjs';
import { readConfiguration } from './validation.mjs';

const STAGE_STATUS = { analysis: '正在独立分析', review: '正在交叉审查', summary: '正在整理决策结论' };
const STAGE_TASK = { analysis: '分析', review: '审查', summary: '整理' };
/** Status of what a model does while it answers (see invoke.mjs); 'writing' shows the stage's status. */
const ACTIVITY_STATUS = { thinking: '正在思考', searching: '正在检索网页' };
/** Least time between two preview events of one call. */
const DELTA_INTERVAL = 120;

/**
 * The live preview of one call by `agent` for `stage`. text(chunk) collects the answer text the CLI
 * streams and emits it as { type: 'delta', agent, stage, append } at most once per DELTA_INTERVAL; the
 * first event of the call also carries reset: true, so the page starts this preview over (should an
 * earlier call for the same agent and stage have left one). Up to MAX_REPLY characters are previewed.
 * close() stops it; close({ flush: true }) first emits the text still waiting, so that the deltas add up
 * to all the streamed text before the final message arrives.
 */
function livePreview(emit, agent, stage) {
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
    emit({ type: 'delta', agent, stage, append: pending, ...(!started && { reset: true }) });
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

/**
 * Runs one round for a /api/run `body` and streams it to `response`. Throws an AppError, before anything
 * is written, when the request is invalid or a participant is not ready. `signal` stops the round; work
 * already finished is kept. deps: { health (a health checker), invoke (see invoke.mjs), rooms (a room store),
 * onRoom (optional: called with the room's id once it is known, before the room is first saved) }.
 */
export async function runDiscussion(body, response, signal, { health, invoke, rooms, onRoom }) {
  const configuration = readConfiguration(body);
  const { mode, participants: agents, moderator, settings, webSearch } = configuration;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const context = typeof body.context === 'string' ? body.context : '';
  if (!prompt || prompt.length > MAX_PROMPT) throw new AppError('问题不能为空，且不能超过 20,000 字符。');
  if (context.length > MAX_CONTEXT) throw new AppError('共享背景不能超过 40,000 字符。');
  // Reads every participant's login status again; version, help and model checks are reused.
  const currentHealth = await health.check('login', signal, agents);
  if (signal.aborted) throw new AppError('讨论已停止。');
  checkParticipants(currentHealth, configuration);
  const now = new Date().toISOString();
  const room = body.roomId
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
  const previous = historyFor(room, context);
  const question = { configuration, ...contextChange(room, context) };
  room.context = context;
  room.configuration = configuration;
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });
  const emit = (event) => {
    if (!response.destroyed && !response.writableEnded) response.write(JSON.stringify(event) + '\n');
  };
  const add = async (role, text, stage, metadata = {}) => {
    const message = { id: randomUUID(), role, text, stage, createdAt: new Date().toISOString(), ...metadata };
    room.messages.push(message);
    room.updatedAt = message.createdAt;
    await rooms.save(room);
    emit({ type: 'message', message });
    return message;
  };
  emit({ type: 'room', roomId: room.id, title: room.title });
  const heartbeat = setInterval(() => emit({ type: 'heartbeat' }), HEARTBEAT_INTERVAL);
  try {
    await add('user', prompt, 'question', question);
    if (previous.omitted || previous.shortened) await add('system', historyNotice(previous), 'notice');
    const base = roundPrompt({ context, history: previous.text, prompt });
    const status = (agent, stage, text) => emit({ type: 'status', agent, stage, text });
    // Resolves to the answer, or to null when the call failed (recorded as an error message) or was stopped.
    // While the call runs, its streamed text goes out as delta events and what the model does as statuses.
    const perform = async (agent, task, stage, role = agent) => {
      if (signal.aborted) return null;
      let shown = STAGE_STATUS[stage];
      status(agent, stage, shown);
      const preview = livePreview(emit, agent, stage);
      const onActivity = (kind) => {
        const text = kind === 'writing' ? STAGE_STATUS[stage] : ACTIVITY_STATUS[kind];
        if (!text || text === shown || signal.aborted) return;
        shown = text;
        status(agent, stage, text);
      };
      let answer;
      try {
        const focused = stage === 'summary' ? task : withCapability(settings[agent].capability, task);
        answer = await invoke(agent, focused, webSearch, signal, settings[agent], {
          onText: preview.text,
          onActivity
        });
      } catch (e) {
        preview.close();
        if (signal.aborted) return null;
        await add(
          'system',
          `${providerLabel(agent)} ${STAGE_TASK[stage]}失败：${safeDetail(e.message)}`,
          'error'
        );
        status(agent, 'error', '本轮未完成');
        return null;
      }
      preview.close({ flush: !signal.aborted });
      if (signal.aborted) return null;
      await add(role, answer.text, stage, {
        provider: agent,
        model: answer.model,
        ...answerMeasures(answer)
      });
      status(agent, stage, '已完成');
      return answer;
    };
    const answers = await Promise.all(
      agents.map((agent) => perform(agent, analysisPrompt(base), 'analysis'))
    );
    if (signal.aborted) {
      await add('system', '讨论已停止。已完成的回答保留；未完成的调用已终止。', 'notice');
      return;
    }
    if (mode === 'debate' && answers.every(Boolean)) {
      const analyses = attributed(answers, agents, '独立意见');
      const reviews = await Promise.all(
        agents.map((agent) => perform(agent, reviewPrompt(base, analyses, agent), 'review'))
      );
      if (signal.aborted) {
        await add('system', '讨论已停止，已完成的回答与审查保留。', 'notice');
        return;
      }
      if (reviews.every(Boolean)) {
        await perform(
          moderator,
          summaryPrompt(base, analyses, attributed(reviews, agents, '审查'), moderator),
          'summary',
          'summary'
        );
      } else
        await add(
          'system',
          '交叉审查未全部完成，因此本轮没有生成联合归纳。你可以根据已返回内容继续追问。',
          'notice'
        );
    } else if (mode === 'debate') {
      await add('system', '部分参与者未完成独立分析，本轮已停止互审和归纳。', 'notice');
    }
    if (signal.aborted) await add('system', '讨论已停止，已完成内容保留。', 'notice');
  } finally {
    clearInterval(heartbeat);
    emit({ type: 'done', roomId: room.id });
  }
}
