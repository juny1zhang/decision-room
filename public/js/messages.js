// The conversation pane: message cards, the per-question "本轮设置" details and keeping the view
// scrolled to the newest message.
import { $, element } from './dom.js';
import { markdown } from './markdown.js';
import { toast } from './notices.js';
import { activeCapabilities, names, providers, stageNames, state } from './state.js';

const avatars = { codex: '⌘', claude: '✳', cursor: '↗', summary: '合', system: 'i' };

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
    const team = config.participants.filter((id) => providers.includes(id));
    const flow =
      config.mode === 'debate'
        ? '联合讨论 · ' + names[config.moderator] + ' 归纳'
        : config.mode === 'both'
          ? '分别回答'
          : '单独提问';
    details.append(element('div', '', flow + ' · 网页检索' + (config.webSearch ? '开启' : '关闭')));
    const list = element('ul');
    for (const id of team) {
      const choice = config.settings?.[id] || {};
      const capability = activeCapabilities().find((item) => item.id === choice.capability);
      const labels = [names[id], choice.model || 'CLI 默认模型', capability?.label || choice.capability];
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
  const role = Object.hasOwn(names, message.role) ? message.role : 'system';
  const card = element('article', `message ${role}`);
  const head = element('div', 'message-head');
  if (role !== 'user') head.append(element('span', 'avatar', avatars[role]));
  head.append(
    element(
      'span',
      'speaker',
      role === 'summary' ? (names[message.provider] || 'Codex') + ' · 主持人总结' : names[role]
    )
  );
  if (role !== 'user' && message.stage)
    head.append(element('span', 'stage-label', stageNames[message.stage] || message.stage));
  head.append(element('time', 'message-time', formatTime(message.createdAt)));
  if (role !== 'user') {
    const copy = element('button', 'copy-button', '复制');
    copy.type = 'button';
    copy.setAttribute('aria-label', '复制这条回答');
    copy.addEventListener('click', () => copyText(message.text || ''));
    head.append(copy);
  }
  card.append(head);
  const body = element('div', 'message-body');
  if (role === 'user') body.textContent = message.text || '';
  else body.append(markdown(message.text || ''));
  if (role === 'user') {
    card.append(body);
    if (Array.isArray(message.configuration?.participants)) card.append(turnSettings(message.configuration));
  } else {
    const answer = element('div', 'answer-card');
    answer.append(body);
    card.append(answer);
  }
  if (providers.includes(role) || role === 'summary') {
    if (message.model && !(role === 'summary' && !message.provider && message.model === 'codex'))
      card.append(element('div', 'message-note', message.model));
  }
  $('messages').append(card);
  if (scroll && autoScroll) requestAnimationFrame(toBottom);
  else if (scroll) $('jumpBottom').hidden = nearBottom();
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
