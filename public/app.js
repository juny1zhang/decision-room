// Entry point of the Decision Room page: wires up every UI module, restores the saved draft and
// connects to the local service.
//
// Module map. Each module imports only modules listed above it, so there are no import cycles:
//   js/dom.js, js/storage.js   DOM helpers; Web Storage keys and safe access
//   js/api.js                  access token and fetch wrapper for the local server
//   js/providers.js            provider list from /api/health, connection status wording (no DOM)
//   js/goal.js                 goal mode read from the messages: a turn's progress, the final plan (no DOM)
//   js/state.js                shared state, provider registry and stage names, selection snapshots
//   js/notices.js              error banner and toast
//   js/markdown-parse.js       Markdown → tree parser (no DOM)
//   js/markdown.js             tree → DOM renderer (no innerHTML)
//   js/messages.js             message cards and conversation scrolling
//   js/composer.js             composer controls, mode switch, draft persistence
//   js/context-dialog.js       "共同背景" dialog
//   js/config-dialog.js        "模型与能力" dialog
//   js/rooms.js                sidebar room list, open / new / export room
//   js/health.js               connection pills, "工具连接" dialog, health polling, provider registry
//   js/run.js                  /api/run streaming, progress, stop
import { loadPreferences, token } from './js/api.js';
import { setupComposer, autosize, updateControls } from './js/composer.js';
import { setupConfigDialog } from './js/config-dialog.js';
import { setupContextDialog } from './js/context-dialog.js';
import { $, element } from './js/dom.js';
import { checkHealth, renderHealth, setupHealth } from './js/health.js';
import { setupMessages } from './js/messages.js';
import { setupNotices, showError } from './js/notices.js';
import { loadRoom, refreshRooms, setupRooms } from './js/rooms.js';
import { setupRun } from './js/run.js';
import { DRAFT_KEY, SELECTED_ROOM_KEY, storage } from './js/storage.js';
import { restoreConfiguration, state } from './js/state.js';

async function init() {
  if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('keyHint').textContent = 'Ctrl Enter 发送';
  let draftRoomId = null; // the room the draft was written in
  try {
    const draft = JSON.parse(storage.get(DRAFT_KEY) || '{}');
    restoreConfiguration(draft.configuration || draft);
    state.context = typeof draft.context === 'string' ? draft.context : '';
    $('prompt').value = typeof draft.prompt === 'string' ? draft.prompt : '';
    if (typeof draft.roomId === 'string') draftRoomId = draft.roomId;
  } catch {}
  autosize();
  if (!token) {
    showError('请从启动终端打开完整的页面地址，以连接你电脑上的模型工具。');
    $('roomList').replaceChildren(element('p', 'history-empty', '连接本地服务后，记录会显示在这里。'));
    renderHealth();
    return;
  }
  // The browser's saved draft belongs to this page's address, which a new port changes. The server
  // keeps the configuration and the selected room for every address: use them when the browser has none.
  let selected = storage.get(SELECTED_ROOM_KEY);
  const preferences = await loadPreferences();
  if (!state.selectionRestored && preferences.configuration) {
    restoreConfiguration(preferences.configuration);
    updateControls();
  }
  selected ||= preferences.selectedRoomId;
  // Reopening the room shown last keeps what was restored above: the shared context of a draft written in
  // that room, which may not have been sent yet, and a configuration from the draft or the preferences.
  const restoreOptions = { context: draftRoomId !== selected, configuration: !state.selectionRestored };
  await Promise.allSettled([
    checkHealth(),
    refreshRooms(),
    selected ? loadRoom(selected, { silent: true, restoreOptions }) : Promise.resolve()
  ]);
}

setupComposer();
setupRun();
setupRooms();
setupNotices();
setupMessages();
setupContextDialog();
setupHealth();
setupConfigDialog();
init();
