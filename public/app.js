// Entry point of the Decision Room page: wires up every UI module, restores the saved draft and
// connects to the local service.
//
// Module map. Each module imports only modules listed above it, so there are no import cycles:
//   js/dom.js, js/storage.js   DOM helpers; Web Storage keys and safe access
//   js/api.js                  access token and fetch wrapper for the local server
//   js/state.js                shared state, provider/stage names, selection snapshots
//   js/notices.js              error banner and toast
//   js/markdown.js             Markdown → DOM renderer (no innerHTML)
//   js/messages.js             message cards and conversation scrolling
//   js/composer.js             composer controls, mode switch, draft persistence
//   js/context-dialog.js       "共同背景" dialog
//   js/config-dialog.js        "模型与能力" dialog
//   js/rooms.js                sidebar room list, open / new / export room
//   js/health.js               connection pills, "工具连接" dialog, health polling
//   js/run.js                  /api/run streaming, progress, stop
import { token } from './js/api.js';
import { setupComposer, autosize } from './js/composer.js';
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
  try {
    const draft = JSON.parse(storage.get(DRAFT_KEY) || '{}');
    restoreConfiguration(draft.configuration || draft);
    state.context = typeof draft.context === 'string' ? draft.context : '';
    $('prompt').value = typeof draft.prompt === 'string' ? draft.prompt : '';
  } catch {}
  autosize();
  if (!token) {
    showError('请从启动终端打开完整的页面地址，以连接你电脑上的模型工具。');
    $('roomList').replaceChildren(element('p', 'history-empty', '连接本地服务后，记录会显示在这里。'));
    renderHealth();
    return;
  }
  const selected = storage.get(SELECTED_ROOM_KEY);
  await Promise.allSettled([
    checkHealth(),
    refreshRooms(),
    selected ? loadRoom(selected, { silent: true }) : Promise.resolve()
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
