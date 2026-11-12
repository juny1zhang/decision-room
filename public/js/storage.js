// Web Storage access that never throws: when storage is unavailable (private browsing, blocked
// site data) reads return null and writes are skipped.

/** sessionStorage key: the access token of this tab. */
export const TOKEN_KEY = 'decision-room-token';
/** localStorage key: the unsent prompt, shared context and configuration (JSON). */
export const DRAFT_KEY = 'decision-room-draft';
/** localStorage key: id of the room that was open last. */
export const SELECTED_ROOM_KEY = 'decision-room-selected';

const area = (session) => (session ? sessionStorage : localStorage);

export const storage = {
  get(key, session = false) {
    try {
      return area(session).getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value, session = false) {
    try {
      area(session).setItem(key, value);
    } catch {}
  },
  remove(key, session = false) {
    try {
      area(session).removeItem(key);
    } catch {}
  }
};
