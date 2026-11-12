// HTTP: host, origin and token checks, security headers, the JSON API and the static browser UI.
import { timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MAX_BODY, MAX_DISCARD, PUBLIC_DIR } from './config.mjs';
import { runDiscussion } from './discussion.mjs';
import { AppError } from './errors.mjs';
import { exportRoom } from './export.mjs';
import { readPreferencePatch } from './preferences.mjs';
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
const NOT_FOUND = '未找到该操作。';
const UNAUTHORIZED = '访问凭证无效。请使用终端打印的完整地址重新打开。';

export function json(response, status, body) {
  if (response.destroyed) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/** Answers with an error's message and status (500 unless it is an AppError). */
function fail(response, error) {
  if (response.headersSent) {
    if (!response.writableEnded) response.end();
    return;
  }
  if (error.closeConnection) response.setHeader('Connection', 'close');
  json(response, error.status || 500, { error: safeDetail(error.message) });
}

/**
 * Reads a JSON object request body of at most MAX_BODY bytes. A larger body is still read to its end and
 * discarded, up to MAX_DISCARD bytes, so the client is listening when the 413 answer comes; beyond that
 * the error asks for the connection to be closed after the answer (error.closeConnection).
 */
export function readBody(request) {
  return new Promise((resolve, reject) => {
    if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
      reject(new AppError('请使用 JSON 请求。', 415));
      return;
    }
    const tooLarge = (closeConnection) => {
      const error = new AppError('提交内容过大。', 413);
      error.closeConnection = closeConnection;
      return error;
    };
    if (Number(request.headers['content-length']) > MAX_DISCARD) {
      reject(tooLarge(true));
      return;
    }
    let size = 0;
    const chunks = [];
    const onData = (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
      else if (size > MAX_DISCARD) {
        request.off('data', onData);
        reject(tooLarge(true));
      }
    };
    request.on('data', onData);
    request.on('error', reject);
    request.on('end', () => {
      if (size > MAX_BODY) return reject(tooLarge(false));
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
        resolve(data);
      } catch {
        reject(new AppError('请求格式无效。'));
      }
    });
  });
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

/** A request target fit for a log line: no control characters, no access token, at most 200 characters. */
function loggedTarget(target) {
  return (
    String(target)
      // eslint-disable-next-line no-control-regex -- removes control characters a client may send.
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/[a-f0-9]{64}/gi, '[token]')
      .slice(0, 200)
  );
}

/**
 * The server's request listener. Only http://127.0.0.1:<port> and http://localhost:<port> are accepted as
 * host and origin (403 otherwise). GET outside /api/ serves the UI without a token; any other path outside
 * /api/ is a JSON 404. Every /api/ route needs `token` (401 otherwise).
 * deps: health (health checker), invoke (see invoke.mjs), rooms (room store), preferences (see
 * preferences.mjs), activeRun (see discussion.mjs), getPort() (the listening port), publicDir (UI files,
 * default <repo>/public), debug(line) (optional: receives method, path, status and duration per request).
 */
export function createRequestHandler({
  token,
  getPort,
  health,
  invoke,
  rooms,
  preferences,
  activeRun,
  publicDir = PUBLIC_DIR,
  debug
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
      if (!response.headersSent) fail(response, e);
      else if (!response.destroyed)
        response.write(JSON.stringify({ type: 'error', message: safeDetail(e.message) }) + '\n');
    } finally {
      response.removeListener('close', disconnect);
      activeRun.end(controller);
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  }

  async function serveStatic(request, response, pathname) {
    if (request.method === 'GET' && pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    const file = request.method === 'GET' ? await readStaticFile(publicDir, pathname) : null;
    if (!file) return json(response, 404, { error: NOT_FOUND });
    response.writeHead(200, { 'Content-Type': file.type });
    response.end(file.body);
  }

  async function api(request, response, url) {
    const { pathname } = url;
    const method = request.method;
    if (pathname === '/api/health' && method === 'GET')
      return json(
        response,
        200,
        await health.check(url.searchParams.get('refresh') === '1' ? 'full' : 'cached')
      );
    if (pathname === '/api/preferences' && method === 'GET')
      return json(response, 200, await preferences.read());
    if (pathname === '/api/preferences' && method === 'PUT') {
      await preferences.update(readPreferencePatch(await readBody(request)));
      return json(response, 200, { ok: true });
    }
    if (pathname === '/api/rooms' && method === 'GET')
      return json(response, 200, { rooms: await rooms.list() });
    const match = pathname.match(/^\/api\/rooms\/([a-f0-9-]{36})(\/export)?$/);
    if (match && method === 'GET') {
      const room = await rooms.load(match[1]);
      if (match[2]) {
        response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
        response.end(exportRoom(room));
        return;
      }
      return json(response, 200, room);
    }
    if (pathname === '/api/cancel' && method === 'POST') {
      activeRun.abort();
      return json(response, 200, { ok: true });
    }
    if (pathname === '/api/run' && method === 'POST') return run(request, response);
    json(response, 404, { error: NOT_FOUND });
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
    let url;
    try {
      url = new URL(request.url, `http://127.0.0.1:${port}`);
    } catch {
      return json(response, 404, { error: NOT_FOUND });
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(request, response, url.pathname);
    if (!isAuthorized(request, token)) return json(response, 401, { error: UNAUTHORIZED });
    return api(request, response, url);
  }

  return (request, response) => {
    if (debug) {
      const startedAt = Date.now();
      response.once('close', () =>
        debug(
          `http ${request.method} ${loggedTarget(request.url)} ${response.statusCode} ${Date.now() - startedAt} ms` +
            (response.writableFinished ? '' : ' (connection closed early)')
        )
      );
    }
    handle(request, response).catch((e) => fail(response, e));
  };
}
