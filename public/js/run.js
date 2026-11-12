// Running a discussion: POST /api/run, read its newline-delimited JSON event stream into the
// conversation, show live previews, progress and elapsed time, resume an incomplete turn ("重试未完成的部分")
// and stop a run through /api/cancel.
import { api, normalError } from './api.js';
import { autosize, updateControls } from './composer.js';
import { $ } from './dom.js';
import { checkHealth } from './health.js';
import {
  appendMessage,
  clearPreviews,
  dropPreviews,
  onResume,
  showPreview,
  updateResume
} from './messages.js';
import { clearError, showError } from './notices.js';
import { loadRoom, refreshRooms, rememberRoom, setHeading } from './rooms.js';
import { canUseMode, configuration, providerName, stageNames, state } from './state.js';

let elapsedTimer;
/** Set while a new room waits for its first saved message, which puts it in the sidebar. */
let newRoomPending = false;
/** Set while the run resumes an incomplete turn rather than asking the question in the composer. */
let resuming = false;

/**
 * Applies one event of the run stream: room | message | delta | status | error | done (see
 * src/discussion.mjs). A delta adds to the live preview of an answer, which its message replaces; the
 * previews of a participant that failed (status stage 'error') or retries its call (status retry) go, and
 * any left go when the run ends.
 */
function eventReceived(event) {
  if (event.type === 'delta') {
    showPreview(event);
    return;
  }
  if (event.type === 'room') {
    newRoomPending = state.roomId !== event.roomId;
    state.roomId = event.roomId;
    rememberRoom(event.roomId);
    setHeading(event.title);
    // A resumed turn leaves the composer's draft alone.
    if (!resuming) {
      $('prompt').value = '';
      autosize();
    }
  } else if (event.type === 'message') {
    appendMessage(event.message);
    if (event.message.role !== 'user') state.statuses.delete(event.message.provider || event.message.role);
    updateControls();
    if (newRoomPending) {
      newRoomPending = false;
      refreshRooms();
    }
  } else if (event.type === 'status') {
    if (event.agent && (event.stage === 'error' || event.retry)) dropPreviews(event.agent);
    const agent = event.agent ? providerName(event.agent) : '讨论';
    state.statuses.set(
      event.agent || 'system',
      event.text ? `${agent} ${event.text}` : `${agent} 正在${stageNames[event.stage] || '分析'}…`
    );
    updateControls();
  } else if (event.type === 'error') {
    showError(event.message || '本次讨论未完成。');
  } else if (event.type === 'done') {
    clearPreviews();
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

/**
 * Runs a discussion with the /api/run `body` and streams it into the conversation: a new question, or
 * with `resume` the missing part of the open room's latest turn.
 */
async function startRun(body, { resume = false } = {}) {
  clearError();
  resuming = resume;
  state.busy = true;
  state.stopping = false;
  state.statuses.clear();
  startElapsedClock();
  state.streamController = new AbortController();
  updateControls();
  let streamed = false; // the server started the round and streamed events
  let complete = false; // the stream ended with "done"
  let failed = false; // the stream reported an error
  try {
    const response = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify(body),
      signal: state.streamController.signal
    });
    if (!response.body) throw new Error('浏览器无法读取实时回答，请使用较新的 Chrome 或 Safari。');
    streamed = true;
    await readNdjson(response.body, (item) => {
      if (item.type === 'done') complete = true;
      if (item.type === 'error') failed = true;
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
    clearPreviews();
    newRoomPending = false;
    resuming = false;
    stopElapsedClock();
    updateControls();
    // A complete stream already showed every message; only the sidebar's counts and order changed.
    // After an early end or an error, show what the server saved.
    if (streamed && complete && !failed) await refreshRooms();
    else if (streamed && state.roomId) await loadRoom(state.roomId, { silent: true, restoreOptions: false });
    await checkHealth();
  }
}

async function submit(event) {
  event.preventDefault();
  const prompt = $('prompt').value.trim();
  if (!prompt || state.busy || state.serverBusy || !canUseMode()) return;
  await startRun({ roomId: state.roomId, prompt, context: state.context, ...configuration() });
}

/** Runs what is missing of turn `turnId`, the open room's latest, with the settings it was asked with. */
async function resume(turnId) {
  if (!turnId || !state.roomId || state.busy || state.serverBusy) return;
  const run = startRun({ roomId: state.roomId, resumeTurnId: turnId }, { resume: true });
  // The button goes while the turn runs; keep the keyboard focus on the way to stop it.
  $('stopButton').focus();
  await run;
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
  onResume(resume);
  // The composer disables "新的讨论" exactly while a discussion runs, here or in another tab (see
  // updateControls): the resume button follows it.
  new MutationObserver(updateResume).observe($('newRoom'), { attributeFilter: ['disabled'] });
  window.addEventListener('beforeunload', (event) => {
    if (state.busy) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
