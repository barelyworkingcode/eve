// Agent board (docs/design-workbench.md, S5a-A3): every live terminal as a row
// with its state and last line. Mounted by Today's `agents` part and by the
// project page's Agents section; `filter(terminal, project)` picks the rows.
// Nothing here opens a terminal by itself: a tap does (S1-A2).
class AgentBoard {
  static MAX_ROWS = 20;
  static FETCH_EVERY_MS = 15000;
  static TAIL_BYTES = 8192;
  // Shared by every board so Today and a project page never double-fetch.
  // id -> { line, at, inflight }
  static lines = new Map();
  static live = new Set();

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
    return this.container.has('terminalManager') ? this.container.get('terminalManager') : null;
  }

  // The project whose path holds the terminal's directory on the same host (longest path wins).
  _projectOf(t) {
    const dir = (t.directory || '').toLowerCase();
    let best = null;
    for (const p of this.state.projects.values()) {
      const path = (p.path || '').toLowerCase();
      if (!path || (p.hostId || '') !== (t.host?.id || '') || !dir.startsWith(path)) continue;
      if (!best || path.length > (best.path || '').length) best = p;
    }
    return best;
  }

  _rows() {
    const mgr = this._termMgr();
    const rows = [];
    for (const t of mgr ? mgr.allTerminals.values() : []) {
      if (this.state.isTaskRun(t.id)) continue;
      const project = this._projectOf(t);
      if (this.filter(t, project)) rows.push({ t, project });
    }
    // Open before exited, then by name: the order must not jump as lines change.
    rows.sort((a, b) => (a.t.state === 'stopped') - (b.t.state === 'stopped')
      || String(a.t.name).localeCompare(String(b.t.name)) || String(a.t.id).localeCompare(String(b.t.id)));
    return rows;
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
      rows = this._rows();
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
    const shown = rows.slice(0, AgentBoard.MAX_ROWS);
    const list = document.createElement('div');
    list.className = 'agent-board__list';
    for (const r of shown) {
      list.appendChild(this._row(r));
      this._ensureLine(r.t.id, fetch);
    }
    el.appendChild(list);
    if (rows.length > shown.length) {
      const more = document.createElement('p');
      more.className = 'today__empty agent-board__note';
      more.textContent = `+${rows.length - shown.length} more`;
      el.appendChild(more);
    }
  }

  _label(t, project) {
    let name = t.name || t.templateId || 'Terminal';
    if (project && name.startsWith(`${project.name} - `)) name = name.slice(project.name.length + 3);
    return typeof persistSessionLabel === 'function'
      ? persistSessionLabel(name, this.state.terminalTemplates || []) : name;
  }

  _row({ t, project }) {
    const open = t.state !== 'stopped';
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'agent-row';
    row.dataset.testid = `${this.prefix}-agent-${t.id}`;
    row.dataset.state = open ? 'open' : 'exited';

    const head = document.createElement('span');
    head.className = 'agent-row__head';
    const dot = document.createElement('span');
    dot.className = `agent-row__dot${open ? ' agent-row__dot--open' : ''}`;
    head.appendChild(dot);
    const title = document.createElement('span');
    title.className = 'agent-row__title';
    title.textContent = this._label(t, project);
    head.appendChild(title);
    if (this.showProject) {
      const p = document.createElement('span');
      p.className = 'agent-row__project';
      p.textContent = project?.name || '';
      head.appendChild(p);
    }
    const st = document.createElement('span');
    st.className = 'agent-row__state';
    st.textContent = open ? 'open' : `exited${t.exitCode != null ? ` ${t.exitCode}` : ''}`;
    head.appendChild(st);
    row.appendChild(head);

    const line = this._lineFor(t.id);
    if (line) {
      const last = document.createElement('span');
      last.className = 'agent-row__last';
      last.textContent = line;
      row.appendChild(last);
    }
    row.addEventListener('click', () => this._attach(t.id));
    return row;
  }

  _attach(id) {
    const tabs = this.container.has('tabManager') ? this.container.get('tabManager') : null;
    if (tabs?.tabs.some(x => x.id === id)) tabs.switchToTab(id);
    else this._termMgr()?.openTaskTerminal(id);
  }

  _lineFor(id) {
    const held = this._termMgr()?.lastLineOf?.(id);
    return held != null ? held : (AgentBoard.lines.get(id)?.line || '');
  }

  // A terminal this browser holds is read from xterm and never fetched. Otherwise
  // its log tail is fetched when first seen and, if `fetch`, again once 15 s old.
  _ensureLine(id, fetch) {
    if (this._termMgr()?.lastLineOf?.(id) != null) return;
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
