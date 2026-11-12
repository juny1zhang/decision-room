// How stored messages, speakers, stages and discussion modes are named for people (UI history, prompts,
// exports), and which shared context was in effect for each question.
import { PROVIDERS, providerLabel } from './providers/index.mjs';

/** Discussion modes: two with several participants, then one single-participant mode per provider. */
export const MODE_NAMES = Object.freeze({
  debate: '联合讨论',
  both: '分别回答',
  ...Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.label]))
});

/** Message stages as people see them. */
export const STAGE_NAMES = Object.freeze({
  question: '问题',
  analysis: '独立分析',
  review: '交叉审查',
  summary: '讨论总结',
  notice: '提示',
  error: '提示'
});

const ROLE_NAMES = { user: '你', system: '状态说明' };
// Version 1 rooms only used Codex to moderate and had no provider field.
const LEGACY_MODERATOR = 'codex';

export function speakerName(message) {
  if (message.role === 'summary') {
    const moderator = message.provider || LEGACY_MODERATOR;
    return `决策归纳（${providerLabel(moderator) || moderator}）`;
  }
  if (Object.hasOwn(ROLE_NAMES, message.role)) return ROLE_NAMES[message.role];
  return providerLabel(message.role) || message.role;
}

/** The name of a message stage: an unknown stage keeps its stored name, a missing one is ''. */
export function stageName(stage) {
  if (typeof stage !== 'string') return '';
  return Object.hasOwn(STAGE_NAMES, stage) ? STAGE_NAMES[stage] : stage;
}

/** The model that produced a message, or '' when unknown. */
export function resultModel(message) {
  // Older summary messages stored the moderator's provider id in the model field.
  if (message.role === 'summary' && !message.provider) return '';
  return typeof message.model === 'string' ? message.model : '';
}

/** A message's text, or '' when a hand-edited message has none. */
export function messageText(message) {
  return typeof message.text === 'string' ? message.text : '';
}

/** The messages of a room that are objects; a room without a message list has none. */
export function roomMessages(room) {
  return Array.isArray(room?.messages)
    ? room.messages.filter((message) => message && typeof message === 'object' && !Array.isArray(message))
    : [];
}

/** Whether a question carries a snapshot of the shared context, which it does when it changed the context. */
export function hasContextSnapshot(message) {
  return message.role === 'user' && typeof message.context === 'string';
}

const text = (value) => (typeof value === 'string' ? value : '');

/**
 * The shared context in effect for each question (a message with role 'user') of `room`, as a Map from
 * question to text. A question that changed the context carries a snapshot of it; the others keep the one
 * before. Questions before the first snapshot use room.legacyContext, or room.context when no question has a
 * snapshot: rooms saved before snapshots existed kept only their latest context.
 */
export function questionContexts(room) {
  const questions = roomMessages(room).filter((message) => message.role === 'user');
  let context = text(questions.some(hasContextSnapshot) ? room.legacyContext : room.context);
  const contexts = new Map();
  for (const question of questions) {
    if (hasContextSnapshot(question)) context = question.context;
    contexts.set(question, context);
  }
  return contexts;
}

/** The shared context in effect for the latest question of `room`, or '' when it has none. */
export function contextInEffect(room) {
  const contexts = [...questionContexts(room).values()];
  return contexts.length ? contexts.at(-1) : '';
}
