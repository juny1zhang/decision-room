// Client for the local Decision Room server. Every request carries the access token.
import { storage, TOKEN_KEY } from './storage.js';

// The launcher opens the page as http://127.0.0.1:<port>/#<token>. Remember the token for this tab
// and remove it from the address bar; later visits in the same tab read it back from sessionStorage.
export const token = location.hash.slice(1) || storage.get(TOKEN_KEY, true) || '';
if (location.hash) {
  storage.set(TOKEN_KEY, token, true);
  history.replaceState(null, '', location.pathname + location.search);
}

/** Turns a failed request into a message for the error banner. */
export function normalError(error) {
  if (error?.name === 'AbortError') return '连接已中断。可以重新检查连接，并在记录中查看已完成的回答。';
  if (error instanceof TypeError) return '无法连接本地服务。请保持启动终端开启，再重新检查连接。';
  return error?.message || '操作未完成，请稍后重试。';
}

/**
 * fetch() wrapper: adds the token (and a JSON content type when there is a body) and throws an Error
 * carrying the server's message when the response is not 2xx.
 */
export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('X-Decision-Token', token);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers, cache: 'no-store', credentials: 'omit' });
  if (!response.ok) {
    let message;
    try {
      const body = await response.json();
      message = body.error || body.message;
    } catch {}
    // Each launch issues a new token, so a tab left open from an earlier launch lands here.
    if (response.status === 401)
      message = '访问凭证已失效，本地服务可能已重新启动。请使用启动终端打印的完整地址重新打开页面。';
    throw new Error(typeof message === 'string' ? message : `请求未完成（${response.status}）。`);
  }
  return response;
}

// Preferences kept by the server (/api/preferences): the configuration and the selected room. The
// browser's own copy belongs to the page's address, which changes with the port; these do not.
const PREFERENCE_DELAY = 600;
let preferencesLoaded = false;
let preferenceTimer;
let preferenceQueue = Promise.resolve();
const pendingPreferences = {};
/** Each field as JSON, as the server last confirmed it. */
const serverPreferences = {};

/**
 * Reads the server's preferences once the token is known. Resolves to { configuration, selectedRoomId },
 * null for what is not saved or when the request fails. Saving starts only after this.
 */
export async function loadPreferences() {
  let preferences = { configuration: null, selectedRoomId: null };
  if (token) {
    try {
      const data = await (await api('/api/preferences')).json();
      preferences = {
        configuration: data.configuration ?? null,
        selectedRoomId: data.selectedRoomId ?? null
      };
    } catch {}
  }
  for (const [key, value] of Object.entries(preferences)) serverPreferences[key] = JSON.stringify(value);
  preferencesLoaded = true;
  schedulePreferences();
  return preferences;
}

/** Saves { configuration?, selectedRoomId? } to the server shortly after the last change. */
export function savePreferences(patch) {
  if (!token) return;
  Object.assign(pendingPreferences, patch);
  schedulePreferences();
}

function schedulePreferences() {
  if (!preferencesLoaded || !Object.keys(pendingPreferences).length) return;
  clearTimeout(preferenceTimer);
  preferenceTimer = setTimeout(sendPreferences, PREFERENCE_DELAY);
}

/** Sends the fields that differ from the server's copy, one request after another. */
function sendPreferences(options = {}) {
  clearTimeout(preferenceTimer);
  const patch = {};
  for (const [key, value] of Object.entries(pendingPreferences)) {
    if (JSON.stringify(value) !== serverPreferences[key]) patch[key] = value;
    delete pendingPreferences[key];
  }
  if (!Object.keys(patch).length) return;
  preferenceQueue = preferenceQueue.then(async () => {
    try {
      await api('/api/preferences', { method: 'PUT', body: JSON.stringify(patch), ...options });
      for (const [key, value] of Object.entries(patch)) serverPreferences[key] = JSON.stringify(value);
    } catch {
      // Best effort: the browser still has its own copy.
    }
  });
}

// A change made just before the tab closes is still sent.
addEventListener('pagehide', () => {
  if (preferencesLoaded) sendPreferences({ keepalive: true });
});
