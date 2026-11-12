// Markdown export of a saved room.
import { CAPABILITY_LABELS } from './capabilities.mjs';
import {
  MODE_NAMES,
  messageText,
  questionContexts,
  resultModel,
  roomMessages,
  speakerName,
  stageName
} from './messages.mjs';
import { providerLabel } from './providers/index.mjs';
import { savedConfiguration } from './validation.mjs';

const pad = (number) => String(number).padStart(2, '0');

/**
 * A stored ISO time as local date, time and UTC offset, such as "2026-03-02 09:15（UTC+08:00）", in the
 * server's time zone, which is the user's own: the server only runs on their computer. '' when the value is
 * missing or not a valid time.
 */
export function localDateTime(value) {
  const date = new Date(typeof value === 'string' ? value : NaN);
  if (Number.isNaN(date.valueOf())) return '';
  const offset = -date.getTimezoneOffset();
  const zone = `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}（${zone}）`;
}

/** "用时 42 秒", "用时 3 分 12 秒": how long an answer took, or '' when unknown. */
export function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return '用时不到 1 秒';
  if (seconds < 60) return `用时 ${seconds} 秒`;
  const rest = seconds % 60;
  return `用时 ${Math.floor(seconds / 60)} 分${rest ? ` ${rest} 秒` : '钟'}`;
}

const tokenCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('en-US') : '';

/**
 * "输入 12,345（缓存 8,000）/ 输出 1,234 tokens": the tokens an answer used, with only the counts its CLI
 * reported (the cached ones only when there are some), or '' when it reported none.
 */
export function usageText(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  const cached = input && usage.cachedInputTokens > 0 ? tokenCount(usage.cachedInputTokens) : '';
  const parts = [input && `输入 ${input}${cached && `（缓存 ${cached}）`}`, output && `输出 ${output}`];
  // A full-width parenthesis brings its own space.
  const text = parts.filter(Boolean).join(cached ? '/ ' : ' / ');
  return text && `${text} tokens`;
}

/** The note under an answer: its model, time and tokens, the known ones, joined by " · ". */
export function answerNote(message) {
  return [resultModel(message), durationText(message.durationMs), usageText(message.usage)]
    .filter(Boolean)
    .join(' · ');
}

function configurationMarkdown(saved) {
  const configuration = savedConfiguration(saved);
  if (!configuration) return '';
  const { mode, participants, moderator, settings, webSearch } = configuration;
  const lines = [`本轮设置 · ${MODE_NAMES[mode]} · 网页检索${webSearch ? '开启' : '关闭'}`];
  if (mode === 'debate') lines[0] += ` · 主持人 ${providerLabel(moderator)}`;
  lines.push('');
  for (const agent of participants) {
    const { model, reasoning, capability } = settings[agent];
    lines.push(
      `- ${providerLabel(agent)} · ${model || 'CLI 默认模型'} · ${CAPABILITY_LABELS.get(capability)}${reasoning ? ' · 推理强度 ' + reasoning : ''}`
    );
  }
  return lines.join('\n');
}

/**
 * The whole room as Markdown: title, the shared context of its first question, then every message with its
 * stage, time, settings, and model, time taken and tokens. A question that changed the shared context is
 * followed by the new one.
 */
export function exportRoom(room) {
  const created = localDateTime(room.createdAt);
  let out = `# ${typeof room.title === 'string' && room.title ? room.title : '未命名讨论'}\n\n`;
  if (created) out += `创建：${created}\n\n`;
  const contexts = questionContexts(room);
  const first = contexts.size ? contexts.values().next().value : room.context;
  if (typeof first === 'string' && first) out += `## 共享背景\n\n${first}\n\n`;
  let previous = first;
  for (const message of roomMessages(room)) {
    const heading = [speakerName(message), stageName(message.stage), localDateTime(message.createdAt)];
    out += `## ${heading.filter(Boolean).join(' · ')}\n\n`;
    const settings = configurationMarkdown(message.configuration);
    if (settings) out += settings + '\n\n';
    const note = answerNote(message);
    if (note) out += `${resultModel(message) ? '模型 · ' : ''}${note}\n\n`;
    out += `${messageText(message)}\n\n`;
    if (!contexts.has(message)) continue;
    const context = contexts.get(message);
    if (context !== previous) out += `### 共享背景（本轮更新）\n\n${context || '（已清空）'}\n\n`;
    previous = context;
  }
  return out;
}
