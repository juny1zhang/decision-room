// HTTP: host, origin and token checks, security headers, the JSON API and the static browser UI.
import { timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_BODY, PUBLIC_DIR } from './config.mjs';
import { runDiscussion } from './discussion.mjs';
import { AppError } from './errors.mjs';
import { exportRoom } from './export.mjs';
import { safeDetail } from './redact.mjs';

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'";

/** Files the UI may load from the public folder, by extension. GET / serves index.html. */
const STATIC_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};
const INDEX = { file: 'index.html', type: 'text/html; charset=utf-8' };

export function json(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/** Reads a JSON object request body of at most MAX_BODY bytes. */
export async function readBody(request) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json'))
    throw new AppError('请使用 JSON 请求。', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new AppError('提交内容过大。', 413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new AppError('请求格式无效。');
  }
}

/** Whether the request carries this session's access token. */
export function isAuthorized(request, token) {
  const provided = request.headers['x-decision-token'];
  return (
    typeof provided === 'string' &&
    /^[a-f0-9]{64}$/.test(provided) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(token))
  );
}

/**
 * Maps a URL path to { file, type } inside `publicDir`, or null when it must not be served: anything that
 * could leave the folder (`..`, encoded separators, backslashes, absolute or drive paths), hidden files and
 * folders, and extensions other than STATIC_TYPES. "/" maps to index.html. Does not touch the disk.
 */
export function resolveStaticPath(publicDir, pathname) {
  const root = path.resolve(publicDir);
  if (pathname === '/') return { file: path.join(root, INDEX.file), type: INDEX.type };
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  const segments = decoded.slice(1).split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.') || /[\\:\0]/.test(segment))) return null;
  const extension = path.extname(segments.at(-1));
  if (!Object.hasOwn(STATIC_TYPES, extension)) return null;
  const file = path.resolve(root, ...segments);
  if (!file.startsWith(root + path.sep)) return null;
  return { file, type: STATIC_TYPES[extension] };
}

/**
 * Reads the static file for `pathname`, or resolves to null when there is none to serve. Symbolic links
 * may not lead outside `publicDir`, and only regular files are served.
 */
export async function readStaticFile(publicDir, pathname) {
  const target = resolveStaticPath(publicDir, pathname);
  if (!target) return null;
  try {
    const [file, root] = await Promise.all([fs.realpath(target.file), fs.realpath(publicDir)]);
    if (!file.startsWith(root + path.sep) || !(await fs.stat(file)).isFile()) return null;
    return { body: await fs.readFile(file), type: target.type };
  } catch {
    return null;
  }
}

/**
 * The server's request listener. Only http://127.0.0.1:<port> and http://localhost:<port> are accepted as
 * host and origin. The UI (GET outside /api/) is public; every /api/ route needs `token`.
 * deps: health (health checker), invoke (see invoke.mjs), rooms (room store), activeRun (see discussion.mjs),
 * getPort() (the listening port), publicDir (UI files, default <repo>/public).
 */
export function createRequestHandler({
  token,
  getPort,
  health,
  invoke,
  rooms,
  activeRun,
  publicDir = PUBLIC_DIR
}) {
  async function run(request, response) {
    if (activeRun.isBusy()) throw new AppError('已有讨论正在进行，请等待或停止当前讨论。', 409);
    const body = await readBody(request);
    if (activeRun.isBusy()) throw new AppError('已有讨论正在进行，请稍后再试。', 409);
    const controller = activeRun.begin();
    const disconnect = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', disconnect);
    try {
      await runDiscussion(body, response, controller.signal, { health, invoke, rooms });
    } catch (e) {
      if (!response.headersSent) json(response, e.status || 500, { error: safeDetail(e.message) });
      else if (!response.destroyed)
        response.write(JSON.stringify({ type: 'error', message: safeDetail(e.message) }) + '\n');
    } finally {
      response.removeListener('close', disconnect);
      activeRun.end(controller);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }

  async function handle(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    const port = getPort();
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(request.headers.host)) return json(response, 403, { error: 'Invalid host' });
    if (request.headers.origin && !allowedHosts.map((h) => `http://${h}`).includes(request.headers.origin))
      return json(response, 403, { error: 'Invalid origin' });
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const file = await readStaticFile(publicDir, url.pathname);
      if (!file) return json(response, 404, { error: '未找到该操作。' });
      response.writeHead(200, { 'Content-Type': file.type });
      response.end(file.body);
      return;
    }
    if (!url.pathname.startsWith('/api/') || !isAuthorized(request, token))
      return json(response, 403, { error: '访问凭证无效。请使用终端打印的完整地址重新打开。' });
    if (url.pathname === '/api/health' && request.method === 'GET')
      return json(response, 200, await health.check(url.searchParams.get('refresh') === '1'));
    if (url.pathname === '/api/rooms' && request.method === 'GET')
      return json(response, 200, { rooms: await rooms.list() });
    const match = url.pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(\/export)?$/);
    if (match && request.method === 'GET') {
      const room = await rooms.load(match[1]);
      if (match[2]) {
        response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        response.end(exportRoom(room));
        return;
      }
      return json(response, 200, room);
    }
    if (url.pathname === '/api/cancel' && request.method === 'POST') {
      activeRun.abort();
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/api/run' && request.method === 'POST') return run(request, response);
    json(response, 404, { error: '未找到该操作。' });
  }

  return (request, response) =>
    handle(request, response).catch((e) => {
      if (!response.headersSent) json(response, e.status || 500, { error: safeDetail(e.message) });
      else response.end();
    });
}
