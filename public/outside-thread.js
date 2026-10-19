// Read-only thread of an outside session (docs/design-chief-of-staff.md,
// "Outside work"): one main-area tab per session. Entry text is agent output
// and therefore hostile: You and tool text reach the DOM through textContent
// only. Claude text goes through the shared Markdown renderer with raw HTML kept
// literal (rawHtml:false). The page holds no input and sends nothing.
// Collaborators are reached through the container at call time.
class OutsideThreadPage {
  static PAGE = 50;
  static POLL_PAGE = 200;
  static MAX_AUTO_STEPS = 4;
  static DEFAULT_INTERVAL_MS = 15000;
  static MIN_INTERVAL_MS = 5000;
  static MAX_INTERVAL_MS = 60000;
  static LABELS = { user: 'You', assistant: 'Claude', tool: 'Tool' };
  static SUMMARY_CHARS = 80;
  static RESULT_FOLD_CHARS = 400;
  static RESULT_FOLD_LINES = 8;
  static SUMMARY_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt'];
  static ERROR_LINE = 'Could not read this thread. Eve tries again at the next check.';

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.threads = new Map();   // sessionId -> thread state
    this.meta = new Map();      // sessionId -> { name, machine, directory }
    this.current = null;        // sessionId shown in the pane
    this.intervalMs = OutsideThreadPage.DEFAULT_INTERVAL_MS;
    this._timer = null;
    this._dom = null;
    this.bus.on(EVT.COS_OUTSIDE_SESSIONS, (d) => this._onFrame(d));
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this._onVisibility());
    }
  }

  get el() { return document.getElementById('outsideThreadPane'); }

  // Open or focus the session's tab.
  open(row) {
    this.meta.set(row.id, { name: row.name, machine: row.machine, directory: row.directory });
    this.container.get('tabManager').openPane('outside-thread', { sessionId: row.id, name: row.name });
  }

  show(sessionId) {
    this.current = sessionId;
    if (!this.threads.has(sessionId)) this.threads.set(sessionId, this._newThread());
    this._build();
    this._poke();
  }

  // Called by the pane when its tab closes.
  dispose(sessionId) {
    this.threads.delete(sessionId);
    this.meta.delete(sessionId);
    if (this.current === sessionId) {
      this.current = null;
      this._stopTimer();
    }
  }

  _newThread() {
    return { entries: [], cursor: null, hasMore: false, loaded: false, error: false, busy: false, filling: false, fetches: 0 };
  }

  _thread() { return this.current ? this.threads.get(this.current) : null; }

  _name(id) { return this.meta.get(id)?.name || 'This session'; }

  // The pane's element is shared by every thread tab: it counts as shown only
  // while it is visible and the page itself is visible.
  _shown() {
    const el = this.el;
    return !!(this.current && el && !el.classList.contains('hidden')
      && (typeof document === 'undefined' || document.visibilityState === 'visible'));
  }

  // ---- inbound ----

  _onFrame(d) {
    if (Array.isArray(d?.sessions)) {
      const n = Number(d.probeIntervalMs);
      if (Number.isFinite(n)) {
        this.intervalMs = Math.min(OutsideThreadPage.MAX_INTERVAL_MS, Math.max(OutsideThreadPage.MIN_INTERVAL_MS, n));
      }
      const listed = new Map(d.sessions.filter(r => typeof r?.id === 'string').map(r => [r.id, r]));
      for (const id of [...this.threads.keys()]) {
        const row = listed.get(id);
        if (!row) { this._left(id); continue; }
        this.meta.set(id, { name: row.name, machine: row.machine, directory: row.directory });
      }
      if (this.current && this.threads.has(this.current)) this._renderHeader();
    }
  }

  _onVisibility() {
    if (this._shown()) this._poke();
  }

  // The session left the Agents list: close its tab and say so.
  _left(sessionId) {
    if (!this.threads.has(sessionId)) return;
    const name = this._name(sessionId);
    this.container.get('tabManager').closeTab(`outside-thread:${sessionId}`);
    this.dispose(sessionId);
    this.bus.emit(EVT.TOAST_SHOW, {
      id: `outside-thread-left-${sessionId}`,
      message: `${name} left the Agents list, so its thread closed.`,
      type: 'info',
      duration: 8000,
    });
  }

  // ---- fetching ----

  _api() { return this.container.get('api'); }

  // Fetch now when the thread is shown, then every interval.
  _poke() {
    this._stopTimer();
    if (!this._shown()) return;
    const t = this._thread();
    if (!t || t.busy || t.filling) return;
    if (t.loaded) this._fetch(this.current, 'poll');
    else this._loadFirst(this.current);
  }

  _stopTimer() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }

  _schedule() {
    this._stopTimer();
    if (!this._shown()) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._shown()) return;
      const t = this._thread();
      if (!t || t.busy || t.filling) return;
      if (t.loaded) this._fetch(this.current, 'poll');
      else this._loadFirst(this.current);
    }, this.intervalMs);
    this._timer.unref?.();
  }

  // kind: 'first' (newest 50), 'poll' (newest 200, merged), 'older' (before the cursor).
  // Resolves to the page, or null when the request failed or the session left.
  async _fetch(sessionId, kind) {
    const t = this.threads.get(sessionId);
    if (!t) return null;
    t.busy = true;
    this._renderState();
    let page = null;
    let gone = false;
    try {
      const opts = kind === 'older'
        ? { before: t.cursor, limit: OutsideThreadPage.PAGE }
        : { limit: kind === 'poll' ? OutsideThreadPage.POLL_PAGE : OutsideThreadPage.PAGE };
      page = await this._api().getOutsideTranscript(sessionId, opts);
      if (!Array.isArray(page?.entries)) throw new Error('bad page');
    } catch (err) {
      page = null;
      gone = err?.status === 404;
    }
    if (this.threads.get(sessionId) !== t) return null;   // closed (or closed and reopened) while in flight
    t.busy = false;
    t.fetches += 1;
    if (gone) { this._left(sessionId); return null; }
    if (page) {
      t.error = false;
      this._apply(sessionId, t, kind, page);
    } else {
      t.error = true;
    }
    if (sessionId === this.current) {
      this._renderState();
      this._renderError();
      this._schedule();
    }
    return page;
  }

  // First open: the newest page, then older ones until the thread holds a page's
  // worth. Relay reads at most 256 KiB per page and current Claude transcripts
  // carry large records, so the first page can hold only the last turn.
  // `filling` keeps the thread reading as busy until the fill ends.
  async _loadFirst(sessionId) {
    const t = this.threads.get(sessionId);
    if (!t) return;
    t.filling = true;
    try {
      let page = await this._fetch(sessionId, 'first');
      for (let step = 0; page && step < OutsideThreadPage.MAX_AUTO_STEPS
        && t.hasMore && t.entries.length < OutsideThreadPage.PAGE; step++) {
        page = await this._fetch(sessionId, 'older');
      }
    } finally {
      t.filling = false;
      if (this.threads.get(sessionId) === t && sessionId === this.current) this._renderState();
    }
  }

  _apply(sessionId, t, kind, page) {
    const live = sessionId === this.current && this._dom;
    if (kind === 'older') {
      t.entries = page.entries.concat(t.entries);
      t.cursor = page.cursor;
      t.hasMore = !!page.hasMore;
      if (live) this._prependEntries(page.entries);
    } else if (kind === 'poll' && t.loaded && t.entries.length) {
      const lastId = t.entries[t.entries.length - 1].id;
      const at = page.entries.findIndex(e => e.id === lastId);
      if (at >= 0) {
        const fresh = page.entries.slice(at + 1);
        t.entries = t.entries.concat(fresh);
        if (live && fresh.length) this._appendEntries(fresh);
      } else {
        t.entries = page.entries;
        t.cursor = page.cursor;
        t.hasMore = !!page.hasMore;
        if (live) this._renderList(true);
      }
    } else {
      t.entries = page.entries;
      t.cursor = page.cursor;
      t.hasMore = !!page.hasMore;
      if (live) this._renderList(true);
    }
    t.loaded = true;
    if (live) this._renderMore();
  }

  async _loadOlder() {
    const id = this.current;
    const t = this._thread();
    if (!t || t.busy || t.filling || !t.hasMore) return;
    // A page can hold no entries yet have more behind it: step on at once, bounded.
    for (let step = 0; step < OutsideThreadPage.MAX_AUTO_STEPS; step++) {
      const page = await this._fetch(id, 'older');
      if (!page || page.entries.length > 0 || !page.hasMore) return;
    }
  }

  // ---- DOM ----

  _el(tag, className, testid) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (testid) n.dataset.testid = testid;
    return n;
  }

  _build() {
    const root = this.el;
    if (!root) return;
    root.textContent = '';
    const page = this._el('div', 'outside-thread', 'outside-thread');
    const head = this._el('div', 'outside-thread__header');
    const titles = this._el('div', 'outside-thread__titles');
    const title = this._el('h1', 'outside-thread__title', 'outside-thread-title');
    const where = this._el('p', 'outside-thread__where', 'outside-thread-where');
    titles.append(title, where);
    const badge = this._el('span', 'outside-thread__badge', 'outside-thread-badge');
    badge.textContent = 'Read-only';
    head.append(titles, badge);

    const error = this._el('p', 'outside-thread__error', 'outside-thread-error');
    error.setAttribute('role', 'status');
    error.hidden = true;
    error.textContent = OutsideThreadPage.ERROR_LINE;

    const more = this._el('button', 'outside-thread__more', 'outside-thread-older');
    more.type = 'button';
    more.textContent = 'Load older';
    more.addEventListener('click', () => this._loadOlder());

    const list = this._el('div', 'outside-thread__list', 'outside-thread-log');
    list.setAttribute('role', 'log');
    list.setAttribute('aria-label', 'Conversation');
    list.tabIndex = 0;

    const empty = this._el('p', 'outside-thread__empty', 'outside-thread-empty');
    empty.textContent = 'No entries yet.';

    page.append(head, error, more, list, empty);
    root.appendChild(page);
    this._dom = { page, title, where, error, more, list, empty };
    this._renderHeader();
    this._renderState();
    this._renderError();
    this._renderList(true);
    this._renderMore();
  }

  _renderHeader() {
    const d = this._dom;
    if (!d || !this.current) return;
    const m = this.meta.get(this.current) || {};
    d.title.textContent = m.name || '';
    d.where.textContent = ['Outside', m.machine, m.directory].filter(Boolean).join(' · ');
  }

  // aria-busy and the settled-request counter: the ready signal.
  _renderState() {
    const d = this._dom;
    const t = this._thread();
    if (!d || !t) return;
    const busy = t.busy || t.filling;
    d.page.setAttribute('aria-busy', String(busy));
    d.page.dataset.fetches = String(t.fetches);
    d.list.setAttribute('aria-busy', String(busy));
    d.list.dataset.fetches = String(t.fetches);
    d.more.disabled = busy;
  }

  _renderError() {
    const t = this._thread();
    if (this._dom && t) this._dom.error.hidden = !t.error;
  }

  _renderMore() {
    const t = this._thread();
    if (!this._dom || !t) return;
    this._dom.more.hidden = !t.hasMore;
    this._dom.empty.hidden = !t.loaded || t.entries.length > 0;
  }

  _entryEl(e) {
    const row = this._el('div', 'outside-thread__entry');
    row.dataset.role = e.role;
    const meta = this._el('div', 'outside-thread__meta');
    const who = this._el('span', 'outside-thread__who');
    who.textContent = OutsideThreadPage.LABELS[e.role] || 'Tool';
    meta.appendChild(who);
    const when = OutsideThreadPage.timeOf(e.at);
    if (when) {
      const time = this._el('time', 'outside-thread__time');
      time.dateTime = e.at;
      time.textContent = when;
      meta.appendChild(time);
    }
    const raw = typeof e.text === 'string' ? e.text : '';
    row.appendChild(meta);
    if (e.role === 'tool') {
      row.appendChild(this._toolEl(raw));
    } else if (e.role === 'assistant') {
      const text = this._el('div', 'outside-thread__text message-content outside-thread__md');
      text.innerHTML = MessageRenderer.markdownToHtml(raw, { rawHtml: false });
      row.appendChild(text);
    } else {
      const text = this._el('div', 'outside-thread__text');
      text.textContent = raw;
      row.appendChild(text);
    }
    return row;
  }

  // Relay gives no field that tells a tool call from a result: classify by shape.
  // Every string reaches the DOM through textContent.
  _toolEl(raw) {
    const shape = OutsideThreadPage.toolShape(raw);
    const wrap = this._el('div', 'outside-thread__text outside-thread__toolwrap');
    if (shape.kind === 'call') {
      const d = this._el('details', 'outside-thread__tool');
      d.dataset.kind = 'call';
      const sum = this._el('summary');
      const name = this._el('span', 'outside-thread__tool-name');
      name.textContent = shape.name;
      sum.appendChild(name);
      const brief = this._el('span', 'outside-thread__tool-summary');
      brief.textContent = shape.summary;
      sum.appendChild(brief);
      const body = this._el('pre', 'outside-thread__tool-body');
      body.textContent = MessageRenderer.prettyJson(shape.input);
      d.append(sum, body);
      wrap.appendChild(d);
      return wrap;
    }
    const body = this._el('pre', 'outside-thread__tool-body');
    body.textContent = shape.text;
    const lines = shape.text.replace(/\n$/, '').split('\n');
    if (shape.text.length <= OutsideThreadPage.RESULT_FOLD_CHARS && lines.length <= OutsideThreadPage.RESULT_FOLD_LINES) {
      wrap.appendChild(body);
      return wrap;
    }
    const d = this._el('details', 'outside-thread__tool');
    d.dataset.kind = 'result';
    const sum = this._el('summary');
    const first = lines.find(l => l.trim()) || '';
    const head = this._el('span', 'outside-thread__tool-summary');
    head.textContent = `${OutsideThreadPage.cut(first)} \u00b7 ${lines.length} lines`;
    sum.appendChild(head);
    d.append(sum, body);
    wrap.appendChild(d);
    return wrap;
  }

  static cut(text) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    const n = OutsideThreadPage.SUMMARY_CHARS;
    return flat.length > n ? flat.slice(0, n) + '\u2026' : flat;
  }

  static toolShape(text) {
    const raw = typeof text === 'string' ? text : '';
    const m = /^([A-Za-z_][\w.:-]{0,127}) (\{[\s\S]*)$/.exec(raw);
    if (!m) return { kind: 'result', text: raw };
    const input = m[2];
    let summary = '';
    try {
      const obj = JSON.parse(input);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const key = OutsideThreadPage.SUMMARY_KEYS.find(k => typeof obj[k] === 'string')
          || Object.keys(obj).find(k => typeof obj[k] === 'string');
        if (key) summary = OutsideThreadPage.cut(obj[key]);
      }
    } catch {
      summary = OutsideThreadPage.cut(input);
    }
    return { kind: 'call', name: m[1], input, summary };
  }

  static timeOf(at) {
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? '' : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Rebuild the list; a newly opened or replaced thread starts at its newest entry.
  _renderList(toEnd) {
    const d = this._dom;
    const t = this._thread();
    if (!d || !t) return;
    d.list.textContent = '';
    for (const e of t.entries) d.list.appendChild(this._entryEl(e));
    if (toEnd) d.list.scrollTop = d.list.scrollHeight;
  }

  _appendEntries(entries) {
    const list = this._dom.list;
    const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
    for (const e of entries) list.appendChild(this._entryEl(e));
    if (atEnd) list.scrollTop = list.scrollHeight;
  }

  // Older entries go above; the entry the person was reading stays where it was.
  _prependEntries(entries) {
    const list = this._dom.list;
    const before = list.scrollHeight;
    const frag = document.createDocumentFragment();
    for (const e of entries) frag.appendChild(this._entryEl(e));
    list.insertBefore(frag, list.firstChild);
    list.scrollTop += list.scrollHeight - before;
  }
}

if (typeof features !== 'undefined') {
  features.register({
    id: 'outsideThread',
    init: (container) => new OutsideThreadPage(container),
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OutsideThreadPage;
}
