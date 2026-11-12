// Text from CLIs and errors is shown in the browser and saved in rooms. Strip what must not travel.

// eslint-disable-next-line no-control-regex -- intentionally matches the ESC byte of ANSI colour codes.
const ANSI_COLOR = /\u001b\[[0-9;]*m/g;

/** Removes ANSI colour codes from CLI output. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_COLOR, '');
}

/**
 * Makes CLI or error text safe to display: no colour codes, API keys, bearer or session tokens, JWTs or
 * e-mail addresses, and at most 1200 characters.
 */
export function safeDetail(value) {
  return stripAnsi(value || '')
    .replace(/\b(?:sk-|sess-|Bearer\s+)[A-Za-z0-9_./+-]{8,}/gi, '[credential hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[token hidden]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[account]')
    .slice(0, 1200);
}
