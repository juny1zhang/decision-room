// The conversation pane: message cards, the per-question "本轮设置" details and keeping the view
// scrolled to the newest message.
import { $, element } from './dom.js';
import { markdown } from './markdown.js';
import { toast } from './notices.js';
import { initialOf, isProviderId } from './providers.js';
import { activeCapabilities, providerName, stageNames, state } from './state.js';

const ROLE_NAMES = { user: '你', system: '讨论提示' };
/** Avatars of the roles that are not providers. A provider's avatar comes from app.css or its label. */
const ROLE_AVATARS = { summary: '合', system: 'i' };
/** Version 1 rooms only had Codex moderate, and their summaries name no provider. */
const LEGACY_MODERATOR = 'codex';

/** user, summary or system, or provider for an answer, whose role is the provider's id. */
function kindOf(role) {
  if (role === 'user' || role === 'summary' || role === 'system') return role;
  return isProviderId(role) ? 'provider' : 'system';
}

/** A provider's name in a message; refreshProviderNames() updates it once the registry is known. */
function nameOf(id) {
  const node = element('span', '', providerName(id));
  node.dataset.nameOf = id;
  return node;
}

export function nearBottom() {
  const pane = $('conversation');
  return pane.scrollHeight - pane.scrollTop - pane.clientHeight < 120;
}

export function toBottom() {
  const pane = $('conversation');
  pane.scrollTop = pane.scrollHeight;
  $('jumpBottom').hidden = true;
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制这条回答');
  } catch {
    toast('复制失败，可选中文字手动复制。');
  }
}

/** Collapsed summary of the configuration a question was asked with; filled in on first open. */
function turnSettings(config) {
  const details = element('details', 'turn-settings');
  details.append(element('summary', '', '本轮设置'));
  details.addEventListener('toggle', () => {
    if (!details.open || details.children.length > 1) return;
    const team = config.participants.filter(isProviderId);
    const moderator = isProviderId(config.moderator) ? providerName(config.moderator) : '主持人';
    const flow =
      config.mode === 'debate'
        ? '联合讨论 · ' + moderator + ' 归纳'
        : config.mode === 'both'
          ? '分别回答'
          : '单独提问';
    details.append(element('div', '', flow + ' · 网页检索' + (config.webSearch ? '开启' : '关闭')));
    const list = element('ul');
    for (const id of team) {
      const choice = config.settings?.[id] || {};
      const capability = activeCapabilities().find((item) => item.id === choice.capability);
      const labels = [
        providerName(id),
        choice.model || 'CLI 默认模型',
        capability?.label || choice.capability
      ];
      if (choice.reasoning) labels.push('推理强度 ' + choice.reasoning);
      list.append(element('li', '', labels.filter(Boolean).join(' · ')));
    }
    details.append(list);
  });
  return details;
}

/** Renders one message unless a message with the same id is already shown. */
export function appendMessage(message, scroll = true) {
  const id = message.id || `${message.role}:${message.stage}:${message.text}`;
  if (state.seen.has(id)) return;
  state.seen.add(id);
  state.messages.push(message);
  const autoScroll = nearBottom();
  $('emptyState').hidden = true;
  const kind = kindOf(message.role);
  const card = element('article', `message ${kind}`);
  // An answer takes its provider's colours and avatar glyph from app.css through data-provider.
  if (kind === 'provider') card.dataset.provider = message.role;
  const head = element('div', 'message-head');
  if (kind !== 'user') {
    const avatar = element('span', 'avatar');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.dataset.initial = ROLE_AVATARS[kind] ?? initialOf(providerName(message.role));
    head.append(avatar);
  }
  const speaker = element('span', 'speaker');
  if (kind === 'summary')
    speaker.append(
      nameOf(isProviderId(message.provider) ? message.provider : LEGACY_MODERATOR),
      ' · 主持人总结'
    );
  else if (kind === 'provider') speaker.append(nameOf(message.role));
  else speaker.textContent = ROLE_NAMES[kind];
  head.append(speaker);
  if (kind !== 'user' && message.stage)
    head.append(element('span', 'stage-label', stageNames[message.stage] || message.stage));
  head.append(element('time', 'message-time', formatTime(message.createdAt)));
  if (kind !== 'user') {
    const copy = element('button', 'copy-button', '复制');
    copy.type = 'button';
    copy.setAttribute('aria-label', '复制这条回答');
    copy.addEventListener('click', () => copyText(message.text || ''));
    head.append(copy);
  }
  card.append(head);
  const body = element('div', 'message-body');
  if (kind === 'user') body.textContent = message.text || '';
  else body.append(markdown(message.text || ''));
  if (kind === 'user') {
    card.append(body);
    if (Array.isArray(message.configuration?.participants)) card.append(turnSettings(message.configuration));
  } else {
    const answer = element('div', 'answer-card');
    answer.append(body);
    card.append(answer);
  }
  // Older summaries stored the moderator's provider id in the model field.
  const model = kind === 'provider' || (kind === 'summary' && message.provider) ? message.model : '';
  if (typeof model === 'string' && model) card.append(element('div', 'message-note', model));
  $('messages').append(card);
  if (scroll && autoScroll) requestAnimationFrame(toBottom);
  else if (scroll) $('jumpBottom').hidden = nearBottom();
}

/** Shows the registry's labels in messages rendered before the first health response named them. */
export function refreshProviderNames() {
  const list = $('messages');
  for (const node of list.querySelectorAll('[data-name-of]'))
    node.textContent = providerName(node.dataset.nameOf);
  for (const card of list.querySelectorAll('.message[data-provider]')) {
    const avatar = card.querySelector('.avatar');
    if (avatar) avatar.dataset.initial = initialOf(providerName(card.dataset.provider));
  }
}

export function replaceMessages(messages) {
  state.messages = [];
  state.seen.clear();
  $('messages').replaceChildren();
  $('emptyState').hidden = messages.length > 0;
  for (const message of messages) appendMessage(message, false);
  requestAnimationFrame(toBottom);
}

export function setupMessages() {
  $('jumpBottom').addEventListener('click', toBottom);
  $('conversation').addEventListener(
    'scroll',
    () => {
      $('jumpBottom').hidden = nearBottom() || !state.messages.length;
    },
    { passive: true }
  );
}
