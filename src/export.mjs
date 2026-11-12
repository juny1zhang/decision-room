// Markdown export of a saved room.
import { CAPABILITY_LABELS } from './capabilities.mjs';
import { MODE_NAMES, resultModel, speakerName } from './messages.mjs';
import { providerLabel } from './providers/index.mjs';

function configurationMarkdown(configuration) {
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

/** The whole room as Markdown: title, shared background, then every message with its settings and model. */
export function exportRoom(room) {
  let out = `# ${room.title}\n\n创建：${room.createdAt}\n\n`;
  if (room.context) out += `## 共享背景\n\n${room.context}\n\n`;
  for (const message of room.messages) {
    out += `## ${speakerName(message)} · ${message.stage}\n\n`;
    if (message.configuration) out += configurationMarkdown(message.configuration) + '\n\n';
    const model = resultModel(message);
    if (model) out += `模型 · ${model}\n\n`;
    out += `${message.text}\n\n`;
  }
  return out;
}
