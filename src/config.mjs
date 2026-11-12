// Paths, limits and the version shared by the server modules. Reading this module has no side effects.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.1.0';

/** The repository folder that holds server.mjs. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Browser UI files served by the HTTP handler. */
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const DATA_DIR = path.resolve(process.env.DECISION_ROOM_DATA_DIR || path.join(ROOT, 'data'));
export const ROOMS_DIR = path.join(DATA_DIR, 'rooms');

// Model CLI processes
/** Longest wait for one model answer. */
export const CLI_TIMEOUT = 12 * 60 * 1000;
/** Default wait for short CLI checks such as --version, --help and login status. */
export const CHECK_TIMEOUT = 20000;
/** Wait for a model catalogue query. */
export const CATALOG_TIMEOUT = 6500;
/** Combined stdout and stderr bytes accepted from one CLI process. */
export const OUTPUT_LIMIT = 2 * 1024 * 1024;
/** Characters of stderr kept for diagnostics. */
export const STDERR_LIMIT = 16000;
/** Characters accepted in one model answer. */
export const MAX_REPLY = 64000;
/** How long a health check result is reused. */
export const HEALTH_TTL = 180000;

// Discussions
/** Characters of earlier discussion sent to the models with each new question. */
export const HISTORY_LIMIT = 48000;
export const MAX_PROMPT = 20000;
export const MAX_CONTEXT = 40000;
/** Messages after which a room no longer accepts follow-up questions. */
export const MAX_MESSAGES = 500;
/** Characters of the first question used as the room title. */
export const TITLE_LENGTH = 38;
export const HEARTBEAT_INTERVAL = 15000;

// HTTP
/** Bytes accepted in a JSON request body. */
export const MAX_BODY = 300000;
export const ROOM_ID_PATTERN = /^[a-f0-9-]{36}$/;
