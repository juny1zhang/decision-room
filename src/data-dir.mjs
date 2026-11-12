// Where Decision Room keeps its rooms and preferences. Nothing here runs on import.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The operating system's folder for this application's data: ~/Library/Application Support/Decision Room
 * on macOS, %APPDATA%\Decision Room on Windows, and ${XDG_DATA_HOME:-~/.local/share}/decision-room
 * elsewhere. `platform`, `env` and `home` default to this machine's.
 */
export function appDataDir({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'Decision Room');
  if (platform === 'win32')
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'Decision Room');
  const xdg = env.XDG_DATA_HOME;
  // The XDG specification ignores relative paths.
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.local', 'share');
  return path.posix.join(base, 'decision-room');
}

async function holdsRooms(directory) {
  try {
    return (await fs.readdir(directory)).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * The data folder, in this order: DECISION_ROOM_DATA_DIR when set (relative to `cwd`); the folder
 * <root>/data that earlier versions used, while <root>/data/rooms still holds saved rooms (*.json);
 * otherwise appDataDir(). Resolves to { dir, source } with source 'env', 'legacy' or 'app', and for
 * 'legacy' also `appDir`, the folder the data would otherwise use.
 */
export async function resolveDataDir({
  root,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  cwd = process.cwd()
}) {
  if (env.DECISION_ROOM_DATA_DIR)
    return { dir: path.resolve(cwd, env.DECISION_ROOM_DATA_DIR), source: 'env' };
  const appDir = appDataDir({ platform, env, home });
  const legacy = path.join(root, 'data');
  if (await holdsRooms(path.join(legacy, 'rooms'))) return { dir: legacy, source: 'legacy', appDir };
  return { dir: appDir, source: 'app' };
}

/** For a legacy data folder, a note on moving it to the application data folder; otherwise ''. */
export function dataDirNote({ dir, source, appDir }) {
  if (source !== 'legacy') return '';
  return (
    `提示：讨论记录仍保存在旧位置 ${dir}。新版本默认使用 ${appDir}。` +
    `如需迁移，请先退出，再把 ${dir} 里的全部内容移到 ${appDir}；` +
    `也可以设置 DECISION_ROOM_DATA_DIR 指定保存位置。`
  );
}
