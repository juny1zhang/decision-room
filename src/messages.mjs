// How stored messages, speakers and discussion modes are named for people (UI history, prompts, exports).
import { PROVIDERS, providerLabel } from './providers/index.mjs';

/** Discussion modes: two with several participants, then one single-participant mode per provider. */
export const MODE_NAMES = Object.freeze({
  debate: '联合讨论',
  both: '分别回答',
  ...Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider.label]))
});

const ROLE_NAMES = { user: '你', system: '状态说明' };
// Version 1 rooms only used Codex to moderate and had no provider field.
const LEGACY_MODERATOR = 'codex';

export function speakerName(message) {
  if (message.role === 'summary') return `决策归纳（${providerLabel(message.provider || LEGACY_MODERATOR)}）`;
  return providerLabel(message.role) || ROLE_NAMES[message.role] || message.role;
}

/** The model that produced a message, or '' when unknown. */
export function resultModel(message) {
  // Older summary messages stored the moderator's provider id in the model field.
  if (message.role === 'summary' && !message.provider) return '';
  return message.model || '';
}
