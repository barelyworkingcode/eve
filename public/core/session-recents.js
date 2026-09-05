/**
 * SessionRecents — a small, browser-local memory of which sessions you
 * opened, when, and what they were about.
 *
 * relayLLM's session list carries no timestamps and only the auto-generated
 * "Project - model" name, so five sessions in one project are visually
 * identical. This store fills the gap from what the browser already sees:
 * `touch()` on every open, `setTitle()` from the first user message once a
 * history arrives. It is separate from `eve-open-sessions` (open tabs, pruned
 * on close) and `eve-session-meta` (deleted on tab dispose) — both are
 * tab-lifecycle state, whereas recency has to outlive the tab.
 */
const SessionRecents = {
  KEY: 'eve-session-recents',
  MAX: 80,
  TITLE_MAX: 72,

  _read() {
    try { return JSON.parse(localStorage.getItem(SessionRecents.KEY)) || {}; }
    catch { return {}; }
  },

  _write(map) {
    try { localStorage.setItem(SessionRecents.KEY, JSON.stringify(map)); }
    catch { /* quota or private mode: recency is a nicety, never a failure */ }
  },

  get(sessionId) {
    if (!sessionId) return null;
    return SessionRecents._read()[sessionId] || null;
  },

  touch(sessionId, patch = {}) {
    if (!sessionId) return;
    const map = SessionRecents._read();
    map[sessionId] = { ...(map[sessionId] || {}), ...patch, lastOpenedAt: Date.now() };
    SessionRecents._write(SessionRecents._prune(map));
  },

  /** Returns true when the stored title changed (callers repaint on that). */
  setTitle(sessionId, text) {
    const title = SessionRecents.titleFromText(text);
    if (!sessionId || !title) return false;
    const map = SessionRecents._read();
    const entry = map[sessionId] || {};
    if (entry.title === title) return false;
    map[sessionId] = { ...entry, title };
    SessionRecents._write(SessionRecents._prune(map));
    return true;
  },

  remove(sessionId) {
    const map = SessionRecents._read();
    if (!(sessionId in map)) return;
    delete map[sessionId];
    SessionRecents._write(map);
  },

  /** Entries sorted newest-first: [{ id, title, lastOpenedAt }]. */
  list() {
    const map = SessionRecents._read();
    return Object.entries(map)
      .map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
  },

  _prune(map) {
    const ids = Object.keys(map);
    if (ids.length <= SessionRecents.MAX) return map;
    const keep = ids
      .sort((a, b) => (map[b].lastOpenedAt || 0) - (map[a].lastOpenedAt || 0))
      .slice(0, SessionRecents.MAX);
    const out = {};
    for (const id of keep) out[id] = map[id];
    return out;
  },

  /** First meaningful line of a user message, trimmed to a title. */
  titleFromText(text) {
    const raw = SessionRecents._plainText(text);
    if (!raw) return '';
    const line = raw
      .split('\n')
      .map(l => l.replace(/^[#>\-*\s]+/, '').trim())
      .find(l => l.length > 0) || '';
    if (!line || line.startsWith('/')) return '';
    if (line.length <= SessionRecents.TITLE_MAX) return line;
    const cut = line.slice(0, SessionRecents.TITLE_MAX);
    const atWord = cut.lastIndexOf(' ');
    return (atWord > 40 ? cut.slice(0, atWord) : cut).trimEnd() + '…';
  },

  /** First user turn of a relayLLM history array, as plain text. */
  titleFromHistory(history) {
    if (!Array.isArray(history)) return '';
    const first = history.find(m => m && m.role === 'user');
    return first ? SessionRecents.titleFromText(first.content) : '';
  },

  _plainText(content) {
    if (content == null) return '';
    if (typeof content === 'string') {
      const s = content.trim();
      // User turns are sometimes stored JSON-encoded (a string or block list).
      if (s.startsWith('[') || s.startsWith('"')) {
        try { return SessionRecents._plainText(JSON.parse(s)); } catch { /* literal text */ }
      }
      return s;
    }
    if (Array.isArray(content)) {
      return content
        .map(b => (typeof b === 'string' ? b : (b && b.type === 'text' ? b.text : '')))
        .filter(Boolean)
        .join('\n');
    }
    if (typeof content === 'object' && typeof content.text === 'string') return content.text;
    return '';
  },
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SessionRecents;
}
