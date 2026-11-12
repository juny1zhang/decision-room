// Validation of what the browser submits for a discussion round.
import { CAPABILITY_LABELS } from './capabilities.mjs';
import { AppError } from './errors.mjs';
import { MODE_NAMES } from './messages.mjs';
import { isModelId } from './providers/common.mjs';
import { PROVIDER_IDS, isProviderId, providerLabel } from './providers/index.mjs';

export { isModelId };

/** "A、B 和 C" */
function listLabels(ids) {
  const labels = ids.map(providerLabel);
  return labels.length > 1 ? `${labels.slice(0, -1).join('、')} 和 ${labels.at(-1)}` : labels.join('');
}

/**
 * Reads and checks the round settings of a /api/run body: mode, participants, moderator, per-participant
 * model, reasoning and capability, and web search. Throws an AppError (400) naming the first problem.
 * Settings may also be given for providers that do not take part; they are checked and kept.
 */
export function readConfiguration(body) {
  const { mode = 'debate', webSearch = false } = body;
  if (typeof mode !== 'string' || !Object.hasOwn(MODE_NAMES, mode))
    throw new AppError('请选择有效的讨论模式。');
  if (typeof webSearch !== 'boolean') throw new AppError('网页检索选项无效。');
  const solo = isProviderId(mode);
  const { participants = solo ? [mode] : PROVIDER_IDS.slice(0, 2) } = body;
  if (
    !Array.isArray(participants) ||
    participants.length > PROVIDER_IDS.length ||
    participants.some((agent) => typeof agent !== 'string' || !isProviderId(agent)) ||
    new Set(participants).size !== participants.length
  ) {
    throw new AppError(`参与者必须从 ${listLabels(PROVIDER_IDS)} 中选择，每位只能选择一次。`);
  }
  if (solo && (participants.length !== 1 || participants[0] !== mode))
    throw new AppError('单方模式只能选择对应的参与者。');
  if (!solo && participants.length < 2) throw new AppError('联合讨论和分别回答需要至少两位参与者。');
  const { moderator = participants[0], settings: requested = {} } = body;
  if (!participants.includes(moderator)) throw new AppError('请从本轮参与者中选择主持人。');
  if (
    !requested ||
    typeof requested !== 'object' ||
    Array.isArray(requested) ||
    Object.keys(requested).some((key) => !isProviderId(key))
  )
    throw new AppError('参与者设置无效。');

  const settings = {};
  for (const agent of new Set([...participants, ...Object.keys(requested)])) {
    const label = providerLabel(agent);
    const options = Object.hasOwn(requested, agent) ? requested[agent] : {};
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new AppError(`${label} 设置无效。`);
    const { model = '', reasoning = '', capability = 'general' } = options;
    if (model !== '' && !isModelId(model)) throw new AppError(`${label} 模型 ID 无效。`);
    if (typeof reasoning !== 'string' || reasoning.length > 32) throw new AppError(`${label} 推理强度无效。`);
    if (!CAPABILITY_LABELS.has(capability)) throw new AppError(`${label} 分析能力无效。`);
    settings[agent] = { model, reasoning, capability };
  }
  return { mode, participants, moderator, settings, webSearch };
}
