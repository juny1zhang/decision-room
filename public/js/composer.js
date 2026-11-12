// The composer and the controls around it: keeps every button, the mode switch and the captions in
// sync with the state, grows the prompt with its content and saves the draft to localStorage.
import { savePreferences, token } from './api.js';
import { $, element } from './dom.js';
import { DRAFT_KEY, storage } from './storage.js';
import { canUseMode, configuration, isSingle, names, providers, ready, state, supportsWeb } from './state.js';

let draftTimer;

/** Re-derives the enabled/hidden state and labels of all controls from the current state. */
export function updateControls() {
  const running = state.busy || state.serverBusy;
  $('sendButton').disabled = running || state.checking || !canUseMode() || !$('prompt').value.trim();
  $('sendButton').hidden = running;
  $('stopButton').hidden = !running;
  $('stopButton').disabled = state.stopping;
  $('stopLabel').textContent = state.stopping ? '正在停止…' : '停止讨论';
  $('sendLabel').textContent = state.roomId ? '继续讨论' : state.mode === 'debate' ? '开始讨论' : '发送问题';
  $('prompt').disabled = running;
  $('contextButton').disabled = running;
  $('configureButton').disabled = running || !state.health;
  const webAvailable = supportsWeb(state.participants);
  if (state.health && !webAvailable) $('webSearch').checked = false;
  $('webSearch').disabled = running || !webAvailable;
  $('webControl').title =
    state.health && !webAvailable ? '当前参与者中有工具不支持网页检索' : '允许参与者在回答时搜索网页';
  for (const button of document.querySelectorAll('[data-mode]')) {
    const active = button.dataset.mode === (isSingle() ? 'single' : state.mode);
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = running || !state.health;
  }
  $('newRoom').disabled = running;
  $('exportButton').disabled = !state.roomId;
  $('mobileExport').hidden = !state.roomId;
  const team = state.participants.map((id) => names[id]).join('、');
  const teamCaption = state.mode === 'debate' ? team + ' · ' + names[state.moderator] + ' 归纳' : team;
  $('modeHelp').textContent = state.checking
    ? '正在检查本机工具…'
    : !token
      ? '请从启动终端打开完整的页面地址。'
      : !canUseMode()
        ? '当前参与者未就绪，可在「模型与能力」中更换。'
        : teamCaption;
  $('configureButton').title = '设置参与者、模型和能力 · ' + team;
  const badges = $('activeParticipants');
  if (badges.dataset.team !== team) {
    badges.dataset.team = team;
    badges.replaceChildren(
      ...state.participants.map((id) => element('span', 'participant ' + id, names[id]))
    );
  }
  $('flowDescription').textContent =
    state.mode === 'debate'
      ? '参与者先各自回答，再交换意见。由 ' + names[state.moderator] + ' 整理共识与分歧。'
      : state.mode === 'both'
        ? '参与者将独立回答同一个问题，你可以逐条比较各自的理由。'
        : '由 ' + names[state.participants[0]] + ' 回答这个问题，你可以在同一场讨论中继续追问。';
  $('contextDot').hidden = !state.context.trim();
  $('progress').hidden = !running;
  if (running) {
    const summaries = [...state.statuses.values()];
    $('progressText').textContent = summaries.length
      ? summaries.join(' · ')
      : state.busy
        ? '正在准备讨论…'
        : '有一场讨论正在运行，可以稍后查看记录。';
  }
}

/** Handles the mode switch: "debate", "both" or "single" (asks one provider). */
export function changeMode(mode) {
  if (mode === 'single') {
    const id = state.participants.find(ready) || providers.find(ready) || state.participants[0];
    state.mode = id;
    state.participants = [id];
  } else {
    if (state.participants.length < 2) {
      const others = providers.filter((id) => !state.participants.includes(id));
      state.participants = [...state.participants, others.find(ready) || others[0]];
    }
    state.mode = mode;
  }
  if (!state.participants.includes(state.moderator)) state.moderator = state.participants[0];
  state.selectionRestored = true;
  updateControls();
  persistDraft();
}

/**
 * Saves prompt, shared context and configuration to localStorage, debounced by 250 ms. The configuration
 * also goes to the server, which keeps it when the page's address changes.
 */
export function persistDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const saved = state.selectionRestored || state.health ? configuration() : undefined;
    storage.set(
      DRAFT_KEY,
      JSON.stringify({ prompt: $('prompt').value, context: state.context, configuration: saved })
    );
    if (saved) savePreferences({ configuration: saved });
  }, 250);
}

/** Grows the prompt with its content (up to a cap), then refreshes the controls and the draft. */
export function autosize() {
  const input = $('prompt');
  input.style.height = 'auto';
  input.style.height =
    Math.min(input.scrollHeight, matchMedia('(max-width:760px)').matches ? 130 : 165) + 'px';
  updateControls();
  persistDraft();
}

export function setupComposer() {
  $('prompt').addEventListener('input', autosize);
  $('prompt').addEventListener('keydown', (event) => {
    // Cmd/Ctrl+Enter sends, except while an IME composition is in progress.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (!$('sendButton').disabled) $('composer').requestSubmit();
    }
  });
  for (const button of document.querySelectorAll('[data-mode]'))
    button.addEventListener('click', () => {
      changeMode(button.dataset.mode);
    });
  for (const button of document.querySelectorAll('[data-example]'))
    button.addEventListener('click', () => {
      $('prompt').value = button.dataset.example.replace(/\\n/g, '\n');
      autosize();
      $('prompt').focus();
    });
  $('webSearch').addEventListener('change', persistDraft);
}
