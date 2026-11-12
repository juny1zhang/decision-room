// The conversation pane: message cards, live previews of answers still being written, the per-question
// "本轮设置" details, the "重试未完成的部分" button of an incomplete turn and keeping the view scrolled to
// the newest message.
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
/** Least time between two Markdown renderings of one preview. */
const PREVIEW_RENDER_INTERVAL = 200;

/**
 * Live previews, one per provider and stage being answered: `${agent}:${stage}` → { card, body, text,
 * timer, renderedAt }. Their cards sit in #livePreviews, after the messages and outside their live region,
 * so screen readers announce each answer once, when it is final.
 */
const previews = new Map();

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

/** "用时 42 秒", "用时 3 分 12 秒": how long an answer took, or '' when unknown (as in src/export.mjs). */
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
 * reported, or '' when it reported none (as in src/export.mjs).
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

/**
 * A card for a message of `kind` (see kindOf) with its head: avatar, speaker and stage. An answer takes
 * its provider's colours and avatar glyph from app.css through data-provider.
 */
function messageCard(message, kind) {
  const card = element('article', `message ${kind}`);
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
  card.append(head);
  return { card, head };
}

/** Keeps the newest content in view if the reader was at the bottom (`stick`), else offers the jump. */
function followNewContent(stick) {
  if (stick) requestAnimationFrame(toBottom);
  else $('jumpBottom').hidden = nearBottom();
}

function removePreview(key) {
  const preview = previews.get(key);
  if (!preview) return;
  clearTimeout(preview.timer);
  preview.card.remove();
  previews.delete(key);
}

function renderPreview(preview) {
  clearTimeout(preview.timer);
  preview.timer = null;
  preview.renderedAt = Date.now();
  const stick = nearBottom();
  preview.body.replaceChildren(markdown(preview.text));
  followNewContent(stick);
}

/**
 * Shows what a provider has written so far for one stage, from a run's { type: 'delta', agent, stage,
 * append, reset? } event: a card like the answer's, marked "生成中…", whose Markdown is rendered at most
 * every PREVIEW_RENDER_INTERVAL ms. reset starts the text over. The final message replaces the preview
 * (appendMessage); dropPreviews() and clearPreviews() remove previews of failed or ended calls.
 */
export function showPreview({ agent, stage, append, reset }) {
  if (!isProviderId(agent) || typeof stage !== 'string' || typeof append !== 'string') return;
  const key = `${agent}:${stage}`;
  let preview = previews.get(key);
  if (!preview) {
    const kind = stage === 'summary' ? 'summary' : 'provider';
    const { card, head } = messageCard(
      { role: kind === 'summary' ? 'summary' : agent, provider: agent, stage },
      kind
    );
    card.classList.add('preview');
    card.dataset.preview = key;
    card.setAttribute('aria-busy', 'true');
    head.append(element('span', 'preview-label', '生成中…'));
    const body = element('div', 'message-body');
    const answer = element('div', 'answer-card');
    answer.append(body);
    card.append(answer);
    preview = { card, body, text: '', timer: null, renderedAt: 0 };
    previews.set(key, preview);
    let list = $('livePreviews');
    if (!list) {
      list = element('div', 'live-previews');
      list.id = 'livePreviews';
      $('messages').after(list);
    }
    const stick = nearBottom();
    $('emptyState').hidden = true;
    list.append(card);
    followNewContent(stick);
  }
  preview.text = (reset ? '' : preview.text) + append;
  if (preview.timer) return;
  const wait = preview.renderedAt + PREVIEW_RENDER_INTERVAL - Date.now();
  if (wait > 0) preview.timer = setTimeout(() => renderPreview(preview), wait);
  else renderPreview(preview);
}

/** Removes the previews of `agent`, whose call failed. */
export function dropPreviews(agent) {
  for (const key of [...previews.keys()]) if (key.startsWith(`${agent}:`)) removePreview(key);
}

/** Removes every preview: the run ended, or another room is shown. */
export function clearPreviews() {
  for (const key of [...previews.keys()]) removePreview(key);
}

/** Renders one message unless a message with the same id is already shown. */
export function appendMessage(message, scroll = true) {
  const id = message.id || `${message.role}:${message.stage}:${message.text}`;
  if (state.seen.has(id)) return;
  state.seen.add(id);
  state.messages.push(message);
  const autoScroll = nearBottom();
  // The final answer takes the place of its preview.
  if (typeof message.provider === 'string') removePreview(`${message.provider}:${message.stage}`);
  $('emptyState').hidden = true;
  const kind = kindOf(message.role);
  const { card, head } = messageCard(message, kind);
  head.append(element('time', 'message-time', formatTime(message.createdAt)));
  if (kind !== 'user') {
    const copy = element('button', 'copy-button', '复制');
    copy.type = 'button';
    copy.setAttribute('aria-label', '复制这条回答');
    copy.addEventListener('click', () => copyText(message.text || ''));
    head.append(copy);
  }
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
  if (kind === 'provider' || (kind === 'summary' && message.provider)) {
    const model = typeof message.model === 'string' ? message.model : '';
    const note = [model, durationText(message.durationMs), usageText(message.usage)].filter(Boolean);
    if (note.length) card.append(element('div', 'message-note', note.join(' · ')));
  }
  $('messages').append(card);
  if (scroll) followNewContent(autoScroll);
}

/** Shows the registry's labels in messages rendered before the first health response named them. */
export function refreshProviderNames() {
  const list = $('conversation'); // the messages and the live previews after them
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
  clearPreviews();
  $('messages').replaceChildren();
  $('emptyState').hidden = messages.length > 0;
  for (const message of messages) appendMessage(message, false);
  updateResume();
  requestAnimationFrame(toBottom);
}

/**
 * The id of the latest question in `messages` when its turn is incomplete and can be resumed, else null.
 * The question must carry its turnId (older rooms do not) and its configuration; the turn is incomplete
 * when a participant's analysis is missing or, in a debate, a participant's review, or a summary after all
 * of them. Mirrors turnProgress and turnComplete in src/discussion.mjs.
 */
export function incompleteTurnId(messages) {
  const at = messages.findLastIndex((message) => message?.role === 'user');
  const question = messages[at];
  const config = question?.configuration;
  if (!question?.id || question.turnId !== question.id || typeof config?.mode !== 'string') return null;
  const debate = config.mode === 'debate';
  const team =
    debate || config.mode === 'both'
      ? Array.isArray(config.participants)
        ? config.participants.filter(isProviderId)
        : []
      : [config.mode];
  if (!team.every(isProviderId) || !team.length) return null;
  const analysed = new Set();
  const reviewed = new Set();
  let summaryAt = -1;
  let answerAt = -1;
  messages.slice(at + 1).forEach((message, index) => {
    if (message?.turnId !== question.id) return;
    if (message.role === 'summary' && message.stage === 'summary') summaryAt = index;
    else if (team.includes(message.role) && (message.stage === 'analysis' || message.stage === 'review')) {
      (message.stage === 'analysis' ? analysed : reviewed).add(message.role);
      answerAt = index;
    }
  });
  const complete =
    team.every((id) => analysed.has(id)) &&
    (!debate || (team.every((id) => reviewed.has(id)) && summaryAt > answerAt));
  return complete ? null : question.id;
}

/** What the "重试未完成的部分" button does: handler(turnId), set by onResume. */
let resumeHandler = null;

/** Sets what "重试未完成的部分" does with the id of the turn to resume. */
export function onResume(handler) {
  resumeHandler = handler;
}

/**
 * Shows "重试未完成的部分" after the last message while the open room's latest turn is incomplete (see
 * incompleteTurnId) and no discussion runs, and hides it otherwise.
 */
export function updateResume() {
  const running = state.busy || state.serverBusy;
  const turnId = state.roomId && !running ? incompleteTurnId(state.messages) : null;
  let bar = $('resumeBar');
  if (!turnId) {
    if (bar) bar.hidden = true;
    return;
  }
  const appearing = !bar || bar.hidden;
  const stick = nearBottom();
  if (!bar) {
    bar = element('div', 'resume-bar');
    bar.id = 'resumeBar';
    const button = element('button', 'resume-button', '重试未完成的部分');
    button.type = 'button';
    button.id = 'resumeButton';
    button.addEventListener('click', () => resumeHandler?.(bar.dataset.turnId));
    bar.append(
      button,
      element('span', 'resume-hint', '只重新运行这一轮缺少的回答、审查或归纳，已完成的内容保留。')
    );
    $('messages').after(bar);
  }
  bar.dataset.turnId = turnId;
  bar.hidden = false;
  if (appearing) followNewContent(stick);
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
