// Running a discussion: POST /api/run, read its newline-delimited JSON event stream into the
// conversation, show progress and elapsed time, and stop a run through /api/cancel.
import { api, normalError } from './api.js';
import { autosize, updateControls } from './composer.js';
import { $ } from './dom.js';
import { checkHealth } from './health.js';
import { appendMessage } from './messages.js';
import { clearError, showError } from './notices.js';
import { loadRoom, refreshRooms, setHeading } from './rooms.js';
import { SELECTED_ROOM_KEY, storage } from './storage.js';
import { canUseMode, configuration, names, stageNames, state } from './state.js';

let elapsedTimer;

/** Applies one event of the run stream: room | message | status | error | done. */
function eventReceived(event) {
  if (event.type === 'room') {
    state.roomId = event.roomId;
    storage.set(SELECTED_ROOM_KEY, event.roomId);
    setHeading(event.title);
    $('prompt').value = '';
    autosize();
    refreshRooms();
  } else if (event.type === 'message') {
    appendMessage(event.message);
    if (event.message.role !== 'user') state.statuses.delete(event.message.provider || event.message.role);
    updateControls();
  } else if (event.type === 'status') {
    const agent = names[event.agent] || event.agent || '讨论';
    state.statuses.set(
      event.agent || 'system',
      event.text ? `${agent} ${event.text}` : `${agent} 正在${stageNames[event.stage] || '分析'}…`
    );
    updateControls();
  } else if (event.type === 'error') {
    showError(event.message || '本次讨论未完成。');
  } else if (event.type === 'done') {
    state.roomId = event.roomId || state.roomId;
  }
}

/** Reads a newline-delimited JSON stream to its end, calling onItem for every non-empty line. */
async function readNdjson(body, onItem) {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      onItem(JSON.parse(line));
    }
  }
  if (buffer.trim()) onItem(JSON.parse(buffer.trim()));
}

function startElapsedClock() {
  state.runStartedAt = Date.now();
  $('progressElapsed').textContent = '00:00';
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - state.runStartedAt) / 1000);
    $('progressElapsed').textContent =
      String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  }, 1000);
}

function stopElapsedClock() {
  clearInterval(elapsedTimer);
  state.runStartedAt = null;
  $('progressElapsed').textContent = '';
}

async function submit(event) {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || state.busy || state.serverBusy || !canUseMode()) return;
  clearError();
  state.busy = true;
  state.stopping = false;
  state.statuses.clear();
  startElapsedClock();
  state.streamController = new AbortController();
  updateControls();
  let complete = false;
  try {
    const response = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({ roomId: state.roomId, prompt, context: state.context, ...configuration() }),
      signal: state.streamController.signal
    });
    if (!response.body) throw new Error('浏览器无法读取实时回答，请使用较新的 Chrome 或 Safari。');
    await readNdjson(response.body, (item) => {
      if (item.type === 'done') complete = true;
      eventReceived(item);
    });
    if (!complete && !state.stopping)
      showError('连接在讨论完成前结束。已完成的回答仍会保留，请检查讨论记录。');
  } catch (error) {
    showError(normalError(error));
  } finally {
    state.busy = false;
    state.serverBusy = false;
    state.stopping = false;
    state.streamController = null;
    state.statuses.clear();
    stopElapsedClock();
    updateControls();
    if (state.roomId) await loadRoom(state.roomId, { silent: true, restoreOptions: false });
    await refreshRooms();
    await checkHealth();
  }
}

async function stop() {
  if (state.stopping) return;
  state.stopping = true;
  updateControls();
  try {
    await api('/api/cancel', { method: 'POST', body: '{}' });
    // Without a local stream (the run was started elsewhere) nothing else will refresh the view.
    if (!state.busy) {
      state.serverBusy = false;
      state.stopping = false;
      updateControls();
      if (state.roomId) await loadRoom(state.roomId, { silent: true });
      await checkHealth();
    }
  } catch (error) {
    state.stopping = false;
    updateControls();
    showError(normalError(error));
  }
}

export function setupRun() {
  $('composer').addEventListener('submit', submit);
  $('stopButton').addEventListener('click', stop);
  window.addEventListener('beforeunload', (event) => {
    if (state.busy) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
