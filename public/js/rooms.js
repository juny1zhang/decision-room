// Rooms and the sidebar: the saved-room list with its search, renaming and deleting a room, opening,
// starting and exporting a room, the page heading and the off-canvas sidebar on narrow screens.
import { api, normalError, savePreferences, token } from './api.js';
import { autosize, updateControls } from './composer.js';
import { $, closeOnBackdropClick, element } from './dom.js';
import { replaceMessages } from './messages.js';
import { clearError, showError, toast } from './notices.js';
import { SELECTED_ROOM_KEY, storage } from './storage.js';
import { restoreConfiguration, state } from './state.js';

const UNTITLED = '未命名讨论';
const SVG = 'http://www.w3.org/2000/svg';
/** Icon paths (20 × 20, stroked) of the room actions. */
const ICONS = {
  rename: 'm12.5 4.5 3 3L8 15H5v-3l7.5-7.5ZM11 6l3 3',
  delete: 'M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.7 9v3.5m2.6-3.5v3.5'
};

/** Room summaries from the latest GET /api/rooms, most recently updated first. */
let rooms = [];
/** The room a discussion was running in when that list was read, or null. */
let listedRunningRoomId = null;
// Every room list or room request takes the next number; an answer to an older one is ignored.
let listRequest = 0;
let loadRequest = 0;
/** The room (summary) the rename or delete dialog acts on. */
let dialogRoom = null;

export function setHeading(title) {
  $('roomHeading').textContent = title || '新的讨论';
  document.title = `${title ? title + ' · ' : ''}议事间`;
}

/** Remembers the open room (null: none) in this browser and on the server, for the next visit. */
export function rememberRoom(id) {
  if (id) storage.set(SELECTED_ROOM_KEY, id);
  else storage.remove(SELECTED_ROOM_KEY);
  savePreferences({ selectedRoomId: id || null });
  syncRoomItems();
}

/**
 * Opens or closes the sidebar drawer of narrow screens. Focus moves into the drawer when it opens, and back to
 * the menu button when it closes with focus inside (the closed drawer is hidden, see app.css).
 */
export function setSidebar(open) {
  const sidebar = $('sidebar');
  const wasOpen = sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  $('mobileOverlay').classList.toggle('visible', open);
  $('menuButton').setAttribute('aria-expanded', String(open));
  if (open && !wasOpen) sidebar.focus();
  else if (!open && wasOpen && sidebar.contains(document.activeElement)) $('menuButton').focus();
}

/** The room a discussion is running in, as far as this page knows, or null. */
function runningRoomId() {
  if (state.busy) return state.roomId;
  return state.serverBusy ? listedRunningRoomId : null;
}

/** Marks the open room, and the room a discussion is running in, whose rename and delete are disabled. */
function syncRoomItems() {
  const running = runningRoomId();
  for (const entry of $('roomList').querySelectorAll('.room-entry')) {
    const id = entry.dataset.roomId;
    const open = id === state.roomId;
    const item = entry.querySelector('.room-item');
    entry.classList.toggle('active', open);
    item.classList.toggle('active', open);
    if (open) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
    entry.querySelector('.room-item-running').hidden = id !== running;
    for (const action of entry.querySelectorAll('.room-action')) action.disabled = id === running;
  }
}

/** Text compared by the search: full-width letters and digits as ASCII, upper case as lower case. */
const searchText = (text) => text.normalize('NFKC').toLocaleLowerCase();

/** Shows only the rooms whose title contains the search text, ignoring case. */
function applyFilter() {
  const query = searchText($('roomSearch').value.trim());
  const entries = [...$('roomList').querySelectorAll('.room-entry')];
  let shown = 0;
  for (const entry of entries) {
    entry.hidden = Boolean(query) && !entry.dataset.search.includes(query);
    if (!entry.hidden) shown++;
  }
  const searching = Boolean(query) && entries.length > 0;
  $('roomFilterEmpty').hidden = !searching || shown > 0;
  $('roomFilterStatus').textContent = !searching ? '' : shown ? `找到 ${shown} 条讨论` : '没有匹配的讨论';
}

function icon(path) {
  const svg = document.createElementNS(SVG, 'svg');
  const attributes = { width: 14, height: 14, viewBox: '0 0 20 20', fill: 'none', 'aria-hidden': 'true' };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  const line = document.createElementNS(SVG, 'path');
  line.setAttribute('d', path);
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '1.4');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  svg.append(line);
  return svg;
}

function actionButton(action, label, hint, onClick) {
  const button = element('button', `room-action ${action}`);
  button.type = 'button';
  button.dataset.action = action;
  button.setAttribute('aria-label', label);
  button.title = hint;
  button.append(icon(ICONS[action]));
  button.addEventListener('click', onClick);
  return button;
}

/** The list item of one saved room: the button that opens it, then its rename and delete buttons. */
function roomEntry(room) {
  const title = room.title || UNTITLED;
  const entry = element('li', 'room-entry');
  entry.dataset.roomId = room.id;
  entry.dataset.search = searchText(title);
  const item = element('button', 'room-item');
  item.type = 'button';
  item.dataset.action = 'open';
  const date = new Date(room.updatedAt || room.createdAt);
  const dateText = Number.isNaN(date.valueOf())
    ? ''
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  const details = element(
    'span',
    'room-item-date',
    `${dateText}${dateText ? ' · ' : ''}${room.messageCount || 0} 条消息`
  );
  const running = element('span', 'room-item-running', ' · 进行中');
  running.hidden = true;
  details.append(running);
  item.append(element('span', 'room-item-title', title), details);
  item.addEventListener('click', () => {
    if (state.busy) {
      toast('请等待当前讨论完成，或先停止讨论。');
      return;
    }
    loadRoom(room.id);
  });
  const actions = element('div', 'room-actions');
  actions.append(
    actionButton('rename', `重命名「${title}」`, '重命名', () => openRename(room)),
    actionButton('delete', `删除「${title}」`, '删除', () => openDelete(room))
  );
  entry.append(item, actions);
  return entry;
}

/** Focuses the button that opens room `id`; when that room is not shown, "新的讨论" or else the search. */
function focusRoom(id) {
  const entry = [...$('roomList').querySelectorAll('.room-entry')].find((item) => item.dataset.roomId === id);
  if (entry && !entry.hidden) entry.querySelector('.room-item').focus();
  else ($('newRoom').disabled ? $('roomSearch') : $('newRoom')).focus();
}

/** Shows `rooms`, keeping the search filter and the focus of a keyboard user inside the list. */
function renderRooms() {
  const list = $('roomList');
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focus = focused && {
    id: focused.closest('.room-entry')?.dataset.roomId,
    action: focused.dataset.action
  };
  if (rooms.length) {
    const items = element('ul', 'room-items');
    items.setAttribute('aria-labelledby', 'historyLabel');
    items.append(...rooms.map(roomEntry));
    list.replaceChildren(items);
  } else list.replaceChildren(element('p', 'history-empty', '你的讨论会保存在这里。'));
  syncRoomItems();
  applyFilter();
  if (!focus?.id) return;
  const entry = [...list.querySelectorAll('.room-entry')].find((item) => item.dataset.roomId === focus.id);
  if (!entry || entry.hidden) return;
  const control = entry.querySelector(`[data-action="${focus.action}"]`);
  (control && !control.disabled ? control : entry.querySelector('.room-item')).focus();
}

export async function refreshRooms() {
  if (!token) return;
  const request = ++listRequest;
  try {
    const data = await (await api('/api/rooms')).json();
    if (request !== listRequest) return;
    rooms = Array.isArray(data.rooms) ? data.rooms : [];
    listedRunningRoomId = typeof data.runningRoomId === 'string' ? data.runningRoomId : null;
    renderRooms();
  } catch (error) {
    if (request !== listRequest) return;
    $('roomList').replaceChildren(element('p', 'history-empty', '暂时无法读取记录。'));
    applyFilter();
    if (state.roomId) showError(normalError(error));
  }
}

/**
 * Opens a saved room. restoreOptions also restores its shared context and configuration; silent
 * suppresses the error banner (used for background refreshes). Only the latest request is shown: an
 * answer is ignored once another room was asked for, a new discussion begun or a discussion started.
 */
export async function loadRoom(id, { silent = false, restoreOptions = true } = {}) {
  const request = ++loadRequest;
  try {
    const room = await (await api(`/api/rooms/${encodeURIComponent(id)}`)).json();
    if (request !== loadRequest || state.busy) return;
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
    if (request === loadRequest && !silent) showError(normalError(error));
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
  loadRequest++; // a room still loading is no longer shown
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

/** Shows `message` as the error of a room dialog (`id`: its error element), or hides it when empty. */
function dialogError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

function openRename(room) {
  dialogRoom = room;
  $('renameInput').value = room.title || '';
  dialogError('renameError', '');
  $('saveRename').disabled = false;
  $('renameDialog').showModal();
  $('renameInput').select();
}

async function rename(event) {
  event.preventDefault();
  const room = dialogRoom;
  const title = $('renameInput').value.trim();
  if (!room) return;
  if (!title) return dialogError('renameError', '讨论标题不能为空。');
  if (title === room.title) return $('renameDialog').close();
  $('saveRename').disabled = true;
  try {
    const saved = await (
      await api(`/api/rooms/${encodeURIComponent(room.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title })
      })
    ).json();
    // Closed first: closing gives focus back to the rename button, which renderRooms() then keeps.
    $('renameDialog').close();
    for (const item of rooms) if (item.id === saved.id) item.title = saved.title;
    if (state.roomId === saved.id) {
      setHeading(saved.title);
      if (state.room) state.room.title = saved.title;
    }
    renderRooms();
    toast('已重命名');
  } catch (error) {
    dialogError('renameError', normalError(error));
  } finally {
    $('saveRename').disabled = false;
  }
}

function openDelete(room) {
  dialogRoom = room;
  $('deleteName').textContent = room.title || UNTITLED;
  dialogError('deleteError', '');
  $('confirmDelete').disabled = false;
  $('deleteDialog').showModal();
}

/** Deletes the dialog's room. Deleting the open room returns to a new discussion. */
async function confirmDelete() {
  const room = dialogRoom;
  if (!room) return;
  $('confirmDelete').disabled = true;
  try {
    await api(`/api/rooms/${encodeURIComponent(room.id)}`, { method: 'DELETE' });
  } catch (error) {
    // Deleted meanwhile elsewhere (another tab): carry on as if this request had deleted it.
    await refreshRooms();
    if (rooms.some((item) => item.id === room.id)) {
      dialogError('deleteError', normalError(error));
      $('confirmDelete').disabled = false;
      return;
    }
  }
  // Focus then goes to the room listed after it, else the one before it.
  const shown = [...$('roomList').querySelectorAll('.room-entry:not([hidden])')].map(
    (entry) => entry.dataset.roomId
  );
  const index = shown.indexOf(room.id);
  const next = index < 0 ? null : (shown[index + 1] ?? shown[index - 1] ?? null);
  $('deleteDialog').close();
  rooms = rooms.filter((item) => item.id !== room.id);
  toast('已删除讨论');
  if (state.roomId === room.id) {
    newRoom();
    return;
  }
  renderRooms();
  focusRoom(next);
}

let wasRunning = false;
let runningElsewhere = false;

/**
 * Follows the start and end of a discussion. The composer disables "新的讨论" exactly while one runs (see
 * updateControls), so a change of that button is when the room actions may need to change. For a
 * discussion started in another tab, the room list says which room it runs in, so it is read again.
 */
function runningChanged() {
  const running = state.busy || state.serverBusy;
  if (running !== wasRunning) {
    if (!state.busy && (running || runningElsewhere)) refreshRooms();
    runningElsewhere = running && !state.busy;
    wasRunning = running;
  }
  syncRoomItems();
}

export function setupRooms() {
  $('newRoom').addEventListener('click', newRoom);
  $('exportButton').addEventListener('click', exportRoom);
  $('mobileExport').addEventListener('click', exportRoom);
  $('menuButton').addEventListener('click', () => setSidebar(!$('sidebar').classList.contains('open')));
  $('mobileOverlay').addEventListener('click', () => setSidebar(false));
  $('sidebar').addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !$('sidebar').classList.contains('open')) return;
    // Escape closes a dialog, or clears the search, before it closes the drawer.
    if (event.target.closest('dialog') || (event.target === $('roomSearch') && $('roomSearch').value)) return;
    setSidebar(false);
  });
  $('roomSearch').addEventListener('input', applyFilter);
  $('renameForm').addEventListener('submit', rename);
  $('renameInput').addEventListener('input', () => dialogError('renameError', ''));
  $('cancelRename').addEventListener('click', () => $('renameDialog').close());
  $('cancelDelete').addEventListener('click', () => $('deleteDialog').close());
  $('confirmDelete').addEventListener('click', confirmDelete);
  closeOnBackdropClick($('renameDialog'));
  closeOnBackdropClick($('deleteDialog'));
  new MutationObserver(runningChanged).observe($('newRoom'), { attributeFilter: ['disabled'] });
}
