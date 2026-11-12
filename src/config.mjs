// Paths, limits and the version shared by the server modules. Reading this module has no side effects.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository folder that holds server.mjs. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The version in package.json, its single source. */
export const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
/** Browser UI files served by the HTTP handler. */
export const PUBLIC_DIR = path.join(ROOT, 'public');
/**
 * Port tried when DECISION_ROOM_PORT is not set. A fixed port keeps the page's address, and with it the
 * drafts the browser saved for that address, the same from one launch to the next.
 */
export const DEFAULT_PORT = 41710;

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
/**
 * How long a health check result is reused, and how long a successful model catalogue or other remote check
 * stays valid while the login state is unchanged.
 */
export const HEALTH_TTL = 180000;

// Discussions
/** Characters of earlier discussion sent to the models with each new question. */
export const HISTORY_LIMIT = 48000;
export const MAX_PROMPT = 20000;
export const MAX_CONTEXT = 40000;
/** Messages after which a room no longer accepts follow-up questions. */
export const MAX_MESSAGES = 500;
/**
 * Most visible characters (grapheme clusters, the closing "…" included) of a new room's default title,
 * which src/titles.mjs makes from the first non-empty line of its first question.
 */
export const TITLE_LENGTH = 38;
export const HEARTBEAT_INTERVAL = 15000;

// HTTP
/** Bytes accepted in a JSON request body. */
export const MAX_BODY = 300000;
/**
 * Bytes of an oversized body read and discarded so the client receives the 413 answer intact. Beyond this the
 * answer is sent at once and the connection is closed.
 */
export const MAX_DISCARD = 16 * 1024 * 1024;
export const ROOM_ID_PATTERN = /^[a-f0-9-]{36}$/;
