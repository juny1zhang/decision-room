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
    if (response.status === 401) message = '访问凭据已失效。请从启动终端重新打开完整的页面地址。';
    throw new Error(typeof message === 'string' ? message : `请求未完成（${response.status}）。`);
  }
  return response;
}
