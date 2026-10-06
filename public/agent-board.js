// Per-session attention state (relay `session_state` frames, `attention` on the
// session list). It lives apart from any board so frames received while no board
// is mounted still count. A session is shown only once the list or
// `session_created` names it: a frame alone carries no name and no project, and
// hidden `__search:` sessions send frames too (docs/design-workbench.md).
class AgentAttention {
  static STATES = new Set(['starting', 'running', 'idle', 'asking', 'errored', 'stalled', 'ended']);
  static REFRESH_DEBOUNCE_MS = 500;

  constructor({ bus, state, refreshList }) {
    this.bus = bus;
    this.state = state;
    this.refreshList = refreshList;
    this._entries = new Map();   // id -> { state, since }
    this._listed = new Set();    // ids that were listed at the last change
    this._asked = new Set();     // ids that already asked for a refresh, per page life
    this._pending = new Set();
    this._timer = null;
    bus.on(EVT.SESSION_STATE, (d) => this._onFrame(d));
    bus.on(EVT.SESSION_UPDATED, (d) => this._onUpdated(d?.sessionId));
    bus.on(EVT.SESSION_REMOVED, (d) => this._onRemoved(d?.sessionId));
  }

  get(sessionId) {
    return this._entries.get(sessionId) || null;
  }

  listedIds() {
    return [...this._entries.keys()].filter(id => this.state.sessions.has(id) && !this.state.isTaskRun(id));
  }

  // Keeps what ended in this page life (the Done rule); the list reload that
  // follows a reconnect re-seeds the live rest.
  reset() {
    for (const [id, e] of this._entries) if (e.state !== 'ended') this._entries.delete(id);
    this._listed = new Set(this.listedIds());
    this.bus.emit(EVT.AGENTS_CHANGED, { sessionId: null });
  }

  _changed(id) {
    if (this._entries.has(id) && this.state.sessions.has(id)) this._listed.add(id);
    else this._listed.delete(id);
    this.bus.emit(EVT.AGENTS_CHANGED, { sessionId: id });
  }

  _onFrame(d) {
    const id = d?.sessionId;
    if (!id || !AgentAttention.STATES.has(d.state)) return;
    // An id the list was already asked about and never named (a hidden session) ends
    // here; otherwise its entry would sit in the store for the page's life.
    if (d.state === 'ended' && !this.state.sessions.has(id) && this._asked.has(id) && !this._pending.has(id)) {
      if (this._entries.delete(id)) this._changed(id);
      return;
    }
    this._entries.set(id, { state: d.state, since: d.since || '' });
    this._changed(id);
    if (!this.state.sessions.has(id)) this._requestRefresh(id);
  }

  _onUpdated(id) {
    const att = id && this.state.getSession(id)?.attention;
    const cur = this._entries.get(id);
    let changed = false;
    if (att && AgentAttention.STATES.has(att.state) && (!cur || att.since > cur.since)) {
      this._entries.set(id, { state: att.state, since: att.since || '' });
      changed = true;
    }
    const becameListed = this._entries.has(id) && this.state.sessions.has(id) && !this._listed.has(id);
    if (changed || becameListed) this._changed(id);
  }

  _onRemoved(id) {
    if (this._entries.delete(id)) this._changed(id);
  }

  _dropUnlistedEnded(ids) {
    for (const id of ids) {
      if (this._entries.get(id)?.state === 'ended' && !this.state.sessions.has(id)) {
        this._entries.delete(id);
        this._changed(id);
      }
    }
  }

  // One list refresh per burst of unknown ids, and one ask per id.
  _requestRefresh(id) {
    if (this._asked.has(id)) return;
    this._asked.add(id);
    this._pending.add(id);
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      const ids = [...this._pending];
      this._pending.clear();
      if (!ids.some(x => !this.state.sessions.has(x))) return;
      Promise.resolve(this.refreshList()).catch(() => {}).then(() => this._dropUnlistedEnded(ids));
    }, AgentAttention.REFRESH_DEBOUNCE_MS);
    this._timer.unref?.();
  }
}

// Agent board (docs/design-workbench.md, S5a-A3): every live terminal and
// session as a row with its state dot, grouped by what needs me. Mounted by Today's `agents` part and by the
// project page's Agents section; `filter(item, project)` picks the rows (item: a
// terminal or a session). Nothing here opens a terminal by itself: a tap does (S1-A2).
class AgentBoard {
  static MAX_ROWS = 20;
  static GROUPS = [
    { key: 'needs', title: 'Needs you', states: ['asking', 'errored', 'stalled'] },
    { key: 'working', title: 'Working', states: ['running', 'idle', 'starting'] },
    { key: 'done', title: 'Done', states: ['ended'] },
  ];
  static FETCH_EVERY_MS = 15000;
  static TAIL_BYTES = 8192;
  // Shared by every board so Today and a project page never double-fetch.
  // id -> { line, at, inflight }
  static lines = new Map();
  static live = new Set();
  // relay's deriveSessionKind: these models are Claude sessions.
  static CLAUDE_MODELS = ['haiku', 'sonnet', 'opus'];
  static DROP_IN_SIZE = { cols: 80, rows: 24 };
  // Session ids with a drop-in in flight, shared by every board.
  static dropping = new Set();

  constructor({ container, testidPrefix, showProject, filter, onCount }) {
    this.container = container;
    this.prefix = testidPrefix;
    this.showProject = !!showProject;
    this.filter = filter;
    this.onCount = onCount;
    this.state = container.get('state');
    this.bus = container.get('bus');
    this.el = null;
    this._offs = [];
  }

  mount(el) {
    this.el = el;
    const on = (evt, fn) => this._offs.push(this.bus.on(evt, fn));
    on(EVT.TERMINAL_LIST, () => this.render({ fetch: true }));
    on(EVT.AGENTS_CHANGED, () => this.render());
    for (const evt of [EVT.CONNECTION_CHANGED, EVT.PROJECTS_LOADED, EVT.MODE_CHANGED, EVT.TERMINAL_TEMPLATES_LOADED]) {
      on(evt, () => this.render());
    }
    AgentBoard.live.add(this);
    this.render({ fetch: true });
  }

  destroy() {
    AgentBoard.live.delete(this);
    for (const off of this._offs) off();
    this._offs = [];
    this.el = null;
  }

  _termMgr() {
    return AgentBoard._termMgr(this.container);
  }

  static _termMgr(container) {
    return container.has('terminalManager') ? container.get('terminalManager') : null;
  }

  render({ fetch = false } = {}) {
    const el = this.el;
    if (!el) return;
    el.textContent = '';
    const mgr = this._termMgr();
    const relayDown = this.state.connection?.relay === false;
    let kind = 'ready';
    let rows = [];
    if (relayDown) kind = 'offline';
    else if (!mgr || !mgr.listLoaded) kind = 'loading';
    else {
      rows = AgentBoard.collect(this.container, this.filter);
      if (rows.length === 0) kind = 'empty';
    }
    el.dataset.state = kind;
    this.onCount?.(rows.length);

    if (kind !== 'ready') {
      const msg = document.createElement('p');
      msg.className = kind === 'loading' ? 'today__skeleton agent-board__note' : 'today__empty agent-board__note';
      msg.dataset.testid = `${this.prefix}-agents-${kind}`;
      msg.textContent = { offline: "Can't reach relay.", empty: 'No agents running', loading: '' }[kind];
      el.appendChild(msg);
      return;
    }
    // The cap fills Needs-you first: rows arrive in group order.
    const shown = rows.slice(0, AgentBoard.MAX_ROWS);
    for (const { key } of AgentBoard.GROUPS) {
      if (shown.some(r => r.group === key)) el.appendChild(this._group(key, rows, shown, mgr, fetch));
    }
    // The line cache is shared by every board; drop what relay no longer lists.
    for (const id of AgentBoard.lines.keys()) if (!mgr.allTerminals.has(id)) AgentBoard.lines.delete(id);
    if (rows.length > shown.length) {
      const more = document.createElement('p');
      more.className = 'today__empty agent-board__note';
      more.textContent = `+${rows.length - shown.length} more`;
      el.appendChild(more);
    }
  }

  static isClaude(session) {
    return AgentBoard.CLAUDE_MODELS.includes(session?.model);
  }

  // The one place the Drop in rule lives: a headless Claude session that needs me.
  static showsDropIn(r) {
    return r.kind === 'session' && AgentBoard.isClaude(r.item) && r.item.headless === true
      && (r.group === 'needs' || AgentBoard.dropping.has(r.id));
  }

  // Never rejects. No client timeout: relay bounds the wait, and giving up sooner
  // would orphan a terminal it already launched.
  static async dropIn(container, sessionId) {
    if (AgentBoard.dropping.has(sessionId)) return;
    AgentBoard.dropping.add(sessionId);
    const renderAll = () => { for (const b of AgentBoard.live) b.render(); };
    const toast = (message) => container.get('bus').emit(EVT.TOAST_SHOW, {
      id: `drop-in-${sessionId}`, message, type: 'error', duration: 8000,
    });
    renderAll();
    try {
      const body = await container.get('api').dropIn(sessionId, AgentBoard.DROP_IN_SIZE);
      if (body?.terminal?.terminalId) AgentBoard._termMgr(container)?.openDropIn(body.terminal);
      else toast("Can't drop in: relay did not return a terminal.");
    } catch (err) {
      toast(`Can't drop in: ${err?.body?.message || err?.body?.error || "relay isn't reachable"}`);
    } finally {
      AgentBoard.dropping.delete(sessionId);
      renderAll();
    }
  }

  static groupOf(state) {
    return AgentBoard.GROUPS.find(g => g.states.includes(state))?.key || 'working';
  }

  static terminalState(t) {
    return t.state !== 'stopped' ? 'running' : (t.exitCode == null || t.exitCode === 0) ? 'ended' : 'errored';
  }

  // The project whose path holds the terminal's directory on the same host (longest path wins).
  static _projectOf(state, t) {
    const dir = (t.directory || '').toLowerCase();
    let best = null;
    for (const p of state.projects.values()) {
      const path = (p.path || '').toLowerCase();
      if (!path || (p.hostId || '') !== (t.host?.id || '') || !dir.startsWith(path)) continue;
      if (!best || path.length > (best.path || '').length) best = p;
    }
    return best;
  }

  static _terminalLabel(state, t, project) {
    let name = t.name || t.templateId || 'Terminal';
    if (project && name.startsWith(`${project.name} - `)) name = name.slice(project.name.length + 3);
    return typeof persistSessionLabel === 'function'
      ? persistSessionLabel(name, state.terminalTemplates || []) : name;
  }

  // Terminals (not task runs) and the sessions the list names, in group order,
  // then label, then id: the order must not jump as a row's state changes inside
  // its group or as lines change.
  static collect(container, filter) {
    const state = container.get('state');
    const mgr = AgentBoard._termMgr(container);
    const rows = [];
    const add = (kind, item, id, st, label, project) => {
      if (filter(item, project)) rows.push({ kind, id, state: st, group: AgentBoard.groupOf(st), label, project, item });
    };
    for (const t of mgr ? mgr.allTerminals.values() : []) {
      if (state.isTaskRun(t.id)) continue;
      const project = AgentBoard._projectOf(state, t);
      add('terminal', t, t.id, AgentBoard.terminalState(t), AgentBoard._terminalLabel(state, t, project), project);
    }
    const attention = container.has('agentAttention') ? container.get('agentAttention') : null;
    for (const id of attention ? attention.listedIds() : []) {
      const session = state.getSession(id);
      const project = (session.projectId && state.projects.get(session.projectId)) || null;
      add('session', session, id, attention.get(id).state, sessionDisplayName(session, project), project);
    }
    const order = (r) => AgentBoard.GROUPS.findIndex(g => g.key === r.group);
    rows.sort((a, b) => order(a) - order(b)
      || String(a.label).localeCompare(String(b.label)) || String(a.id).localeCompare(String(b.id)));
    return rows;
  }

  // Phone bottom bar: the count of Needs-you rows on Today's board, on the Today
  // button. Its accessible name stays "Today"; the badge is its description.
  static mountBadge(button, container) {
    if (!button) return () => {};
    const state = container.get('state');
    const bus = container.get('bus');
    const badge = document.createElement('span');
    badge.className = 'bottom-bar__badge';
    badge.id = 'navTodayBadge';
    badge.dataset.testid = 'nav-today-badge';
    badge.hidden = true;
    const num = document.createElement('span');
    const sr = document.createElement('span');
    sr.className = 'bottom-bar__badge-sr';
    sr.textContent = ' need you';
    badge.append(num, sr);
    button.appendChild(badge);
    const update = () => {
      const mgr = AgentBoard._termMgr(container);
      const ready = state.connection?.relay !== false && !!mgr && mgr.listLoaded;
      const n = ready
        ? AgentBoard.collect(container, (_i, p) => !p || state.isProjectInMode(p)).filter(r => r.group === 'needs').length
        : 0;
      num.textContent = String(n);
      badge.hidden = n === 0;
      if (n > 0) button.setAttribute('aria-describedby', badge.id);
      else button.removeAttribute('aria-describedby');
    };
    const offs = [EVT.AGENTS_CHANGED, EVT.TERMINAL_LIST, EVT.MODE_CHANGED, EVT.PROJECTS_LOADED, EVT.CONNECTION_CHANGED]
      .map(evt => bus.on(evt, update));
    update();
    return () => { for (const off of offs) off(); badge.remove(); button.removeAttribute('aria-describedby'); };
  }

  _row(r, held) {
    const { kind, id, state, label, project, item: t } = r;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'agent-row';
    row.dataset.testid = `${this.prefix}-agent-${id}`;
    row.dataset.kind = kind;
    row.dataset.state = state;

    const head = document.createElement('span');
    head.className = 'agent-row__head';
    const dot = document.createElement('span');
    dot.className = 'agent-row__dot';
    dot.dataset.state = state;
    head.appendChild(dot);
    const title = document.createElement('span');
    title.className = 'agent-row__title';
    title.textContent = label;
    head.appendChild(title);
    if (this.showProject) {
      const p = document.createElement('span');
      p.className = 'agent-row__project';
      p.textContent = project?.name || '';
      head.appendChild(p);
    }
    const st = document.createElement('span');
    st.className = 'agent-row__state';
    st.textContent = kind === 'session' ? state
      : t.state !== 'stopped' ? 'open' : `exited${t.exitCode != null ? ` ${t.exitCode}` : ''}`;
    head.appendChild(st);
    row.appendChild(head);

    if (kind === 'terminal') {
      const line = held != null ? held : (AgentBoard.lines.get(id)?.line || '');
      if (line) {
        const last = document.createElement('span');
        last.className = 'agent-row__last';
        last.textContent = line;
        row.appendChild(last);
      }
    }
    row.addEventListener('click', () => (kind === 'session' ? this.container.get('app').joinSession(id) : this._attach(id)));
    if (!AgentBoard.showsDropIn(r)) return row;
    // The action is a sibling of the row button: a button cannot hold a button.
    const wrap = document.createElement('div');
    wrap.className = 'agent-row-wrap';
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'agent-row__action';
    act.dataset.testid = `${this.prefix}-drop-in-${id}`;
    act.setAttribute('aria-label', `Drop in to ${label}`);
    if (AgentBoard.dropping.has(id)) {
      act.disabled = true;
      act.setAttribute('aria-busy', 'true');
      act.textContent = 'Dropping in…';
    } else {
      act.textContent = 'Drop in';
      act.addEventListener('click', () => AgentBoard.dropIn(this.container, id));
    }
    wrap.append(row, act);
    return wrap;
  }

  _group(key, rows, shown, mgr, fetch) {
    const group = AgentBoard.GROUPS.find(g => g.key === key);
    const sec = document.createElement('section');
    sec.className = 'agent-board__group';
    sec.dataset.testid = `${this.prefix}-agents-group-${key}`;
    const head = document.createElement('h4');
    head.className = 'agent-board__group-head';
    const title = document.createElement('span');
    title.textContent = group.title;
    const count = document.createElement('span');
    count.dataset.testid = `${this.prefix}-agents-group-${key}-count`;
    count.textContent = String(rows.filter(r => r.group === key).length);
    head.append(title, count);
    sec.appendChild(head);
    const list = document.createElement('div');
    list.className = 'agent-board__list';
    for (const r of shown.filter(x => x.group === key)) {
      // Read once per row: a held terminal's line comes from its xterm buffer.
      const held = r.kind === 'terminal' ? mgr.lastLineOf?.(r.id) : null;
      list.appendChild(this._row(r, held));
      if (r.kind === 'terminal') this._ensureLine(r.id, fetch, held);
    }
    sec.appendChild(list);
    return sec;
  }

  _attach(id) {
    const tabs = this.container.has('tabManager') ? this.container.get('tabManager') : null;
    if (tabs?.tabs.some(x => x.id === id)) tabs.switchToTab(id);
    else this._termMgr()?.openTaskTerminal(id);
  }

  // A terminal this browser holds is read from xterm and never fetched. Otherwise
  // its log tail is fetched when first seen and, if `fetch`, again once 15 s old.
  _ensureLine(id, fetch, held) {
    if (held != null) return;
    const cur = AgentBoard.lines.get(id);
    if (cur?.inflight) return;
    if (cur && !(fetch && Date.now() - cur.at >= AgentBoard.FETCH_EVERY_MS)) return;
    const entry = { line: cur?.line || '', at: Date.now(), inflight: true };
    AgentBoard.lines.set(id, entry);
    const api = this.container.get('api');
    Promise.resolve(api?.getTerminalLog(id)).then((bytes) => {
      const tail = bytes.subarray(Math.max(0, bytes.length - AgentBoard.TAIL_BYTES));
      entry.line = TerminalText.lastLine(new TextDecoder().decode(tail));
    }).catch(() => { entry.line = ''; }).finally(() => {
      entry.inflight = false;
      for (const b of AgentBoard.live) b.render();
    });
  }
}
