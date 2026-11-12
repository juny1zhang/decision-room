// One discussion round: checks, independent analyses, cross-reviews and the moderator's summary, streamed
// to the browser as NDJSON events and saved to the room after every message.
import { randomUUID } from 'node:crypto';
import { HEARTBEAT_INTERVAL, MAX_CONTEXT, MAX_MESSAGES, MAX_PROMPT, TITLE_LENGTH } from './config.mjs';
import { AppError } from './errors.mjs';
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
import { readConfiguration } from './validation.mjs';

const STAGE_STATUS = { analysis: '正在独立分析', review: '正在交叉审查', summary: '正在整理决策结论' };
const STAGE_TASK = { analysis: '分析', review: '审查', summary: '整理' };

/** The single discussion that may run at a time, so it can be refused, cancelled and reported as busy. */
export function createActiveRun() {
  let controller = null;
  return {
    isBusy: () => controller !== null,
    begin() {
      controller = new AbortController();
      return controller;
    },
    end(finished) {
      if (controller === finished) controller = null;
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
 * Runs one round for a /api/run `body` and streams it to `response`. Throws an AppError, before anything
 * is written, when the request is invalid or a participant is not ready. `signal` stops the round; work
 * already finished is kept. deps: { health (a health checker), invoke (see invoke.mjs), rooms (a room store) }.
 */
export async function runDiscussion(body, response, signal, { health, invoke, rooms }) {
  const configuration = readConfiguration(body);
  const { mode, participants: agents, moderator, settings, webSearch } = configuration;
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const context = typeof body.context === 'string' ? body.context : '';
  if (!prompt || prompt.length > MAX_PROMPT) throw new AppError('问题不能为空，且不能超过 20,000 字符。');
  if (context.length > MAX_CONTEXT) throw new AppError('共享背景不能超过 40,000 字符。');
  const currentHealth = await health.check(true, signal, agents);
  if (signal.aborted) throw new AppError('讨论已停止。');
  checkParticipants(currentHealth, configuration);
  const now = new Date().toISOString();
  const room = body.roomId
    ? await rooms.load(body.roomId)
    : {
        id: randomUUID(),
        title: prompt.slice(0, TITLE_LENGTH),
        createdAt: now,
        updatedAt: now,
        context,
        messages: []
      };
  if (room.messages.length >= MAX_MESSAGES) throw new AppError('本次讨论已较长，请新开讨论并填写简短背景。');
  room.context = context;
  room.configuration = configuration;
  const previous = historyFor(room.messages);
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
    await add('user', prompt, 'question', { configuration });
    if (previous.dropped)
      await add(
        'system',
        '较早的讨论记录超过本轮上下文上限，已暂不发送给模型；当前问题和共享背景完整保留。历史记录仍可查看和导出。',
        'notice'
      );
    const base = roundPrompt({ context, history: previous.text, prompt });
    const status = (agent, stage, text) => emit({ type: 'status', agent, stage, text });
    // Resolves to the answer, or to null when the call failed (recorded as an error message) or was stopped.
    const perform = async (agent, task, stage, role = agent) => {
      if (signal.aborted) return null;
      status(agent, stage, STAGE_STATUS[stage]);
      let answer;
      try {
        const focused = stage === 'summary' ? task : withCapability(settings[agent].capability, task);
        answer = await invoke(agent, focused, webSearch, signal, settings[agent]);
      } catch (e) {
        if (signal.aborted) return null;
        await add(
          'system',
          `${providerLabel(agent)} ${STAGE_TASK[stage]}失败：${safeDetail(e.message)}`,
          'error'
        );
        status(agent, 'error', '本轮未完成');
        return null;
      }
      if (signal.aborted) return null;
      await add(role, answer.text, stage, { provider: agent, model: answer.model });
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
