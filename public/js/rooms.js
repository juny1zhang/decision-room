// Rooms and the sidebar: the saved-room list, opening, starting and exporting a room, the page
// heading and the off-canvas sidebar on narrow screens.
import { api, normalError, savePreferences, token } from './api.js';
import { autosize, updateControls } from './composer.js';
import { $, element } from './dom.js';
import { replaceMessages } from './messages.js';
import { clearError, showError, toast } from './notices.js';
import { SELECTED_ROOM_KEY, storage } from './storage.js';
import { restoreConfiguration, state } from './state.js';

export function setHeading(title) {
  $('roomHeading').textContent = title || '新的讨论';
  document.title = `${title ? title + ' · ' : ''}议事间`;
}

/** Remembers the open room (null: none) in this browser and on the server, for the next visit. */
export function rememberRoom(id) {
  if (id) storage.set(SELECTED_ROOM_KEY, id);
  else storage.remove(SELECTED_ROOM_KEY);
  savePreferences({ selectedRoomId: id || null });
}

export function setSidebar(open) {
  $('sidebar').classList.toggle('open', open);
  $('mobileOverlay').classList.toggle('visible', open);
  $('menuButton').setAttribute('aria-expanded', String(open));
}

export async function refreshRooms() {
  if (!token) return;
  try {
    const data = await (await api('/api/rooms')).json();
    const list = $('roomList');
    list.replaceChildren();
    if (!data.rooms?.length) {
      list.append(element('p', 'history-empty', '你的讨论会保存在这里。'));
      return;
    }
    for (const room of data.rooms) {
      const button = element('button', `room-item${room.id === state.roomId ? ' active' : ''}`);
      button.type = 'button';
      button.append(element('span', 'room-item-title', room.title || '未命名讨论'));
      const date = new Date(room.updatedAt || room.createdAt);
      const dateText = Number.isNaN(date.valueOf())
        ? ''
        : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      button.append(
        element(
          'span',
          'room-item-date',
          `${dateText}${dateText ? ' · ' : ''}${room.messageCount || 0} 条消息`
        )
      );
      button.addEventListener('click', () => {
        if (state.busy) {
          toast('请等待当前讨论完成，或先停止讨论。');
          return;
        }
        loadRoom(room.id);
      });
      list.append(button);
    }
  } catch (error) {
    $('roomList').replaceChildren(element('p', 'history-empty', '暂时无法读取记录。'));
    if (state.roomId) showError(normalError(error));
  }
}

/**
 * Opens a saved room. restoreOptions also restores its shared context and configuration; silent
 * suppresses the error banner (used for background refreshes).
 */
export async function loadRoom(id, { silent = false, restoreOptions = true } = {}) {
  try {
    const room = await (await api(`/api/rooms/${encodeURIComponent(id)}`)).json();
    state.roomId = room.id;
    state.room = room;
    if (restoreOptions) {
      state.context = room.context || '';
      restoreConfiguration(room.configuration);
    }
    rememberRoom(room.id);
    setHeading(room.title);
    replaceMessages(room.messages || []);
    updateControls();
    setSidebar(false);
    await refreshRooms();
    if (!silent) clearError();
  } catch (error) {
    if (!silent) showError(normalError(error));
  }
}

async function exportRoom() {
  if (!state.roomId) return;
  try {
    const response = await api(`/api/rooms/${encodeURIComponent(state.roomId)}/export`);
    const blob = new Blob([await response.text()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob),
      anchor = element('a');
    anchor.href = url;
    anchor.download =
      ($('roomHeading').textContent || 'decision').replace(/[\\/:*?"<>|]/g, '-').slice(0, 70) + '.md';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast('已导出当前讨论');
  } catch (error) {
    showError(normalError(error));
  }
}

function newRoom() {
  if (state.busy) return;
  state.roomId = null;
  state.room = null;
  state.context = '';
  rememberRoom(null);
  setHeading('');
  replaceMessages([]);
  $('prompt').value = '';
  state.statuses.clear();
  clearError();
  autosize();
  updateControls();
  refreshRooms();
  setSidebar(false);
  $('prompt').focus();
}

export function setupRooms() {
  $('newRoom').addEventListener('click', newRoom);
  $('exportButton').addEventListener('click', exportRoom);
  $('mobileExport').addEventListener('click', exportRoom);
  $('menuButton').addEventListener('click', () => setSidebar(!$('sidebar').classList.contains('open')));
  $('mobileOverlay').addEventListener('click', () => setSidebar(false));
}
