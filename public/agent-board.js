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
    this._entries = new Map();   // id -> { state, since, exit }
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
    this._entries.set(id, { state: d.state, since: d.since || '', exit: d.exit || null });
    this._changed(id);
    if (!this.state.sessions.has(id)) this._requestRefresh(id);
  }

  _onUpdated(id) {
    const att = id && this.state.getSession(id)?.attention;
    const cur = this._entries.get(id);
    let changed = false;
    if (att && AgentAttention.STATES.has(att.state) && (!cur || att.since > cur.since)) {
      this._entries.set(id, { state: att.state, since: att.since || '', exit: att.exit || null });
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
    { key: 'working', title: 'Working', states: ['running', 'starting'] },
    { key: 'idle', title: 'Idle', states: ['idle'] },
    { key: 'done', title: 'Done', states: ['ended'] },
    // Ended outside sessions only; collect() assigns the group, no state maps here.
    { key: 'ended', title: 'Ended', states: [] },
  ];
  static STATE_WORDS = {
    asking: 'Waiting on you', errored: 'Stopped with an error', stalled: 'Gone quiet',
    running: 'Working', starting: 'Starting', idle: 'Idle', ended: 'Done',
  };

  // Age of a state change: '' when the time is not valid, then 'now', '4m', '2h', '3d'.
  static ago(sinceIso, nowMs = Date.now()) {
    const t = Date.parse(sinceIso);
    if (!sinceIso || Number.isNaN(t)) return '';
    const s = Math.max(0, (nowMs - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
  // Why a provider exited: its last non-blank stderr line and the exit code,
  // on one line of at most 160 characters. Same rules and output as exitLine()
  // in chief-of-staff-prompt.js; the browser has no modules, so it is a copy.
  static exitLine(exit) {
    if (!exit || typeof exit !== 'object' || !Number.isInteger(exit.code)) return '';
    const suffix = `exit ${exit.code}`;
    let line = '';
    const err = Array.isArray(exit.stderr) ? exit.stderr : [];
    for (let i = err.length - 1; i >= 0 && !line; i--) {
      if (typeof err[i] === 'string') line = err[i].replace(/\s+/g, ' ').trim();
    }
    if (!line) return suffix;
    const tailPart = ` (${suffix})`;
    if (line.length + tailPart.length <= 160) return `${line}${tailPart}`;
    let t = line.slice(-(160 - 1 - tailPart.length));
    const first = t.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) t = t.slice(1);
    return `\u2026${t}${tailPart}`;
  }

  static FETCH_EVERY_MS = 15000;
  static TAIL_BYTES = 8192;
  // Shared by every board so Today and a project page never double-fetch.
  // id -> { line, at, inflight }
  static lines = new Map();
  static live = new Set();
  // relay's deriveSessionKind: these models are Claude sessions.
  static CLAUDE_MODELS = ['haiku', 'sonnet', 'opus'];
  static DROP_IN_PREFIXES = ['pi/', 'codex/'];
  static DROP_IN_SIZE = { cols: 80, rows: 24 };
  // sessionId -> 'drop' | 'wait': a drop-in in flight, shared by every board. The kind is
  // fixed at the tap, so the busy text does not change when the row changes group.
  static dropping = new Map();
  // sessionId -> terminalId of a drop-in this page opened. While that terminal lives, this
  // page does not offer Take over: relay reads the held session as running and would refuse.
  static held = new Map();
  // Ended outside rows: ids with a Resume request open, and id -> terminalId of a resume this
  // page opened. Shared by every board, like `dropping`.
  static resuming = new Set();
  static resumed = new Map();
  // Live outside rows: id -> 'adopt' | 'interrupt' for an Adopt request open (the kind is fixed at
  // the tap), and id -> managed sessionId of an adopt this page made. Shared by every board.
  static adopting = new Map();
  static adopted = new Map();

  // Rail and sheet options (eve#274): `maxRows` (Infinity: no cap), `layout` ('board' or
  // 'rail'), `collapseDone`, `note(sessionId)` for a row's third line, `onCounts` (group
  // counts, or null while offline or loading) and `onOpen(row)` after a tap, or when relay answers a Drop in or Take over.
  constructor({
    container, testidPrefix, showProject, filter, onCount,
    maxRows = AgentBoard.MAX_ROWS, layout = 'board', collapseDone = false,
    note = null, onCounts = null, onOpen = null, outsideRows = null, openOutside = null, openOutsideThread = null,
  }) {
    this.container = container;
    this.prefix = testidPrefix;
    this.showProject = !!showProject;
    this.filter = filter;
    this.onCount = onCount;
    this.maxRows = maxRows;
    this.layout = layout;
    this.collapseDone = !!collapseDone;
    this.note = note;
    this.onCounts = onCounts;
    this.onOpen = onOpen;
    this.outsideRows = outsideRows;
    this.openOutside = openOutside;
    this.openOutsideThread = openOutsideThread;
    this._doneOpen = false;
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
    // Rebuilding the list drops focus; put it back on the same testid afterwards.
    const focusedId = el.contains(document.activeElement) ? document.activeElement.dataset?.testid : null;
    try { this._render(el, fetch); } finally {
      if (focusedId) {
        const again = [...el.querySelectorAll('[data-testid]')].find(n => n.dataset.testid === focusedId);
        if (again && document.activeElement !== again) again.focus({ preventScroll: true });
      }
    }
  }

  _render(el, fetch) {
    el.textContent = '';
    const mgr = this._termMgr();
    const relayDown = this.state.connection?.relay === false;
    let kind = 'ready';
    let rows = [];
    if (relayDown) kind = 'offline';
    else if (!mgr || !mgr.listLoaded) kind = 'loading';
    else {
      const outside = this.outsideRows?.() || [];
      rows = AgentBoard.collect(this.container, this.filter, outside);
      // A row that left the Ended list (or went live) forgets its Resumed state.
      if (this.outsideRows) for (const oid of AgentBoard.resumed.keys()) if (!outside.some(o => o?.id === oid && o.state === 'ended')) AgentBoard.resumed.delete(oid);
      // An adopted row that left the outside list forgets its Adopted state.
      if (this.outsideRows) for (const oid of AgentBoard.adopted.keys()) if (!outside.some(o => o?.id === oid)) AgentBoard.adopted.delete(oid);
      if (rows.length === 0) kind = 'empty';
    }
    el.dataset.state = kind;
    this.onCount?.(rows.length);
    if (this.onCounts) {
      const counts = { needs: 0, working: 0, idle: 0, done: 0, ended: 0 };
      for (const r of rows) counts[r.group] += 1;
      this.onCounts(kind === 'ready' || kind === 'empty' ? counts : null);
    }

    if (kind !== 'ready') {
      const msg = document.createElement('p');
      msg.className = kind === 'loading' ? 'today__skeleton agent-board__note' : 'today__empty agent-board__note';
      msg.dataset.testid = `${this.prefix}-agents-${kind}`;
      msg.textContent = { offline: "Can't reach relay.", empty: 'No agents running', loading: '' }[kind];
      el.appendChild(msg);
      return;
    }
    // The cap fills Needs-you first: rows arrive in group order.
    const shown = rows.slice(0, this.maxRows);
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

  // Relay's own kind rule: a Claude alias anywhere, or a pi/ or codex/ model on this Mac.
  static takesDropIn(session) {
    if (AgentBoard.isClaude(session)) return true;
    const model = typeof session?.model === 'string' ? session.model : '';
    return !session?.host && AgentBoard.DROP_IN_PREFIXES.some(p => model.startsWith(p));
  }

  // The one place the Drop in rule lives: a headless Claude, Pi or Codex session that needs me or is
  // idle, or a working one (Take over after the turn) that this page does not already hold.
  static showsDropIn(r) {
    if (r.kind !== 'session' || !AgentBoard.takesDropIn(r.item) || r.item.headless !== true) return false;
    return AgentBoard.dropping.has(r.id) || r.group === 'needs' || r.group === 'idle'
      || (r.group === 'working' && !AgentBoard.held.has(r.id));
  }

  // Never rejects. No client timeout: relay bounds the wait, and giving up sooner
  // would orphan a terminal it already launched.
  // `wait` marks "Take over after this turn": the same POST, relay waits for the turn.
  // `onAnswer` runs when relay answers (terminal or refusal), before the terminal opens.
  static async dropIn(container, sessionId, { wait = false, onAnswer = null } = {}) {
    if (sessionId?.startsWith('outside:')) return;
    if (AgentBoard.dropping.has(sessionId)) return;
    AgentBoard.dropping.set(sessionId, wait ? 'wait' : 'drop');
    const renderAll = () => { for (const b of AgentBoard.live) b.render(); };
    const toast = (message) => container.get('bus').emit(EVT.TOAST_SHOW, {
      id: `drop-in-${sessionId}`, message: message.replace(/\s+/g, ' ').trim(), type: 'error', duration: 8000,
    });
    renderAll();
    try {
      const body = await container.get('api').dropIn(sessionId, AgentBoard.DROP_IN_SIZE);
      const terminal = body?.terminal;
      if (terminal?.terminalId) {
        AgentBoard.held.set(sessionId, terminal.terminalId);
        onAnswer?.();
        // Relay's drop-in answer carries no mark; its terminal inherits the session's, and the tab
        // must know it before the next terminal list.
        const marked = container.get('state').getSession(sessionId)?.unsandboxed === true;
        AgentBoard._termMgr(container)?.openDropIn(marked ? { ...terminal, unsandboxed: true } : terminal);
      } else {
        onAnswer?.();
        toast("Can't drop in: relay did not return a terminal.");
      }
    } catch (err) {
      onAnswer?.();
      toast(`Can't drop in: ${err?.body?.message || err?.body?.error || "relay isn't reachable"}`);
    } finally {
      AgentBoard.dropping.delete(sessionId);
      renderAll();
    }
  }

  // The one place the Unsandboxed rule lives: relay marks a session it runs with no project, and its
  // drop-in terminal, with `unsandboxed: true`. Absent or anything but true is unmarked.
  static isUnsandboxed(r) {
    return (r.kind === 'session' || r.kind === 'terminal') && r.item?.unsandboxed === true;
  }

  _unsandboxedChip(r) {
    const chip = document.createElement('span');
    chip.className = 'agent-row__chip agent-row__chip--unsandboxed';
    chip.dataset.testid = `${this.prefix}-agent-unsandboxed-${r.id}`;
    chip.setAttribute('aria-description', 'Runs with no sandbox and no project policy.');
    chip.textContent = 'Unsandboxed';
    return chip;
  }

  // The one place the Resume rule lives: an ended outside row in a console project.
  static showsResume(r) {
    return r.kind === 'outside' && r.group === 'ended' && r.item.state === 'ended'
      && !!r.project && !r.item.hostId && !r.project.hostId;
  }

  // The line for an ended outside row that has no Resume button.
  static resumeReason(r) {
    if (r.kind !== 'outside' || r.group !== 'ended' || r.item.state !== 'ended' || AgentBoard.showsResume(r)) return '';
    return r.project ? "On a host, so it can't be resumed here." : "Not in a project, so it can't be resumed.";
  }

  // Never rejects. No client timeout: relay bounds the wait, and giving up sooner
  // would orphan a terminal it already launched.
  static async resumeOutside(container, id) {
    if (!id?.startsWith('outside:') || AgentBoard.resuming.has(id)) return;
    AgentBoard.resuming.add(id);
    const renderAll = () => { for (const b of AgentBoard.live) b.render(); };
    const toast = (message) => container.get('bus').emit(EVT.TOAST_SHOW, {
      id: `resume-${id}`, message: `Can't resume: ${String(message).replace(/\s+/g, ' ').trim()}`, type: 'error', duration: 8000,
    });
    renderAll();
    try {
      const body = await container.get('api').resumeOutside(id, AgentBoard.DROP_IN_SIZE);
      const terminal = body?.terminal;
      if (terminal?.terminalId) {
        AgentBoard.resumed.set(id, terminal.terminalId);
        AgentBoard._termMgr(container)?.openDropIn(terminal);
      } else {
        toast('relay did not return a terminal.');
      }
    } catch (err) {
      toast(err?.body?.message || err?.body?.error || "relay isn't reachable");
    } finally {
      AgentBoard.resuming.delete(id);
      renderAll();
    }
  }

  // The one place the Adopt rule lives: a live outside row relay marked adoptable, not on a
  // host. An absent `adoptable` gives no button (fail closed).
  static showsAdopt(r) {
    return r.kind === 'outside' && r.group !== 'ended'
      && ['idle', 'running', 'asking'].includes(r.item.state)
      && r.item.adoptable === true && !r.item.hostId;
  }

  static ADOPT_REASONS = {
    host_unsupported: "On a host, so it can't be adopted here.",
    no_project: "Not in a project, so it can't be adopted.",
    not_registered: "Claude keeps no session record for it, so it can't be adopted.",
    invalid_id: "Its conversation id is not valid, so it can't be adopted.",
    start_mismatch: "Its process changed, so it can't be adopted.",
    not_interactive: "Not an interactive session, so it can't be adopted.",
    not_command_line: "Not started from the command line, so it can't be adopted.",
    ambiguous: "Two processes hold this conversation, so it can't be adopted.",
  };

  // The line for a live outside row that has no Adopt button; '' when none applies.
  static adoptReason(r) {
    if (r.kind !== 'outside' || r.group === 'ended' || r.item.adoptable !== false || typeof r.item.adoptReason !== 'string') return '';
    return AgentBoard.ADOPT_REASONS[r.item.adoptReason] || "Relay can't adopt this session.";
  }

  // Never rejects. No client timeout: relay bounds the ladder, and giving up sooner would
  // orphan a session it already launched. `onRefuse` runs before the toast on a refusal.
  static async adoptOutside(container, id, { interrupt, onRefuse = null } = {}) {
    if (!id?.startsWith('outside:') || AgentBoard.adopting.has(id)) return;
    AgentBoard.adopting.set(id, interrupt ? 'interrupt' : 'adopt');
    const renderAll = () => { for (const b of AgentBoard.live) b.render(); };
    const toast = (message) => container.get('bus').emit(EVT.TOAST_SHOW, {
      id: `adopt-${id}`, message: `Can't adopt: ${String(message).replace(/\s+/g, ' ').trim()}`, type: 'error', duration: 8000,
    });
    renderAll();
    try {
      const body = await container.get('api').adoptOutside(id, { interrupt: interrupt === true });
      if (body?.sessionId) {
        AgentBoard.adopted.set(id, body.sessionId);
        await container.get('app').loadSessions();
      } else {
        onRefuse?.();
        toast('relay did not return a session.');
      }
    } catch (err) {
      onRefuse?.();
      toast(err?.body?.message || err?.body?.error || "relay isn't reachable");
    } finally {
      AgentBoard.adopting.delete(id);
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
  static collect(container, filter, outsideRows = []) {
    const state = container.get('state');
    const mgr = AgentBoard._termMgr(container);
    const rows = [];
    const add = (kind, item, id, st, label, project, since = '', exit = null, group = AgentBoard.groupOf(st)) => {
      if (filter(item, project)) rows.push({ kind, id, state: st, group, label, project, since, exit, item });
    };
    for (const [sid, tid] of AgentBoard.held) {
      const t = mgr?.allTerminals.get(tid);
      if (!t || t.state === 'stopped') AgentBoard.held.delete(sid);
    }
    for (const [oid, tid] of AgentBoard.resumed) {
      const t = mgr?.allTerminals.get(tid);
      if (!t || t.state === 'stopped') AgentBoard.resumed.delete(oid);
    }
    for (const t of mgr ? mgr.allTerminals.values() : []) {
      if (state.isTaskRun(t.id) || t.outside === true) continue;
      const project = AgentBoard._projectOf(state, t);
      add('terminal', t, t.id, AgentBoard.terminalState(t), AgentBoard._terminalLabel(state, t, project), project);
    }
    const attention = container.has('agentAttention') ? container.get('agentAttention') : null;
    for (const id of attention ? attention.listedIds() : []) {
      const session = state.getSession(id);
      const project = (session.projectId && state.projects.get(session.projectId)) || null;
      const att = attention.get(id);
      add('session', session, id, att.state, sessionDisplayName(session, project), project, att.since || '', att.exit || null);
    }
    for (const item of outsideRows) {
      if (!item?.id?.startsWith('outside:')) continue;
      const project = state.projects.get(item.projectId) || null;
      if (item.state === 'ended') add('outside', item, item.id, 'ended', item.name, project, item.endedAt || '', null, 'ended');
      else add('outside', item, item.id, item.state, item.name, project, item.since);
    }
    const order = (r) => AgentBoard.GROUPS.findIndex(g => g.key === r.group);
    // Ended: newest endedAt first; an unparseable time sorts last.
    const endedMs = (r) => { const t = Date.parse(r.since); return Number.isNaN(t) ? -Infinity : t; };
    rows.sort((a, b) => order(a) - order(b)
      || (a.group === 'ended' && b.group === 'ended' && endedMs(b) !== endedMs(a) ? (endedMs(b) > endedMs(a) ? 1 : -1) : 0)
      || (a.group === 'ended' ? 0 : String(a.label).localeCompare(String(b.label))) || String(a.id).localeCompare(String(b.id)));
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

  // An ended outside row: read-only text in a div. No handler, no tab stop. Its one sibling
  // button is Resume (a new managed terminal; the outside process is never touched).
  _endedRow(r) {
    const { id, label, item: t } = r;
    const row = document.createElement('div');
    row.className = 'agent-row agent-row--rail';
    row.dataset.testid = `${this.prefix}-agent-${id}`;
    row.dataset.kind = 'outside';
    row.dataset.state = 'ended';
    const head = document.createElement('span');
    head.className = 'agent-row__head';
    const dot = document.createElement('span');
    dot.className = 'agent-row__dot';
    dot.dataset.state = 'ended';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', 'Ended');
    const title = document.createElement('span');
    title.className = 'agent-row__title';
    title.textContent = label;
    head.append(dot, title);
    const age = AgentBoard.ago(t.endedAt);
    if (age) {
      const a = document.createElement('span');
      a.className = 'agent-row__age';
      a.dataset.testid = `${this.prefix}-agent-age-${id}`;
      a.textContent = age;
      head.appendChild(a);
    }
    const meta = document.createElement('span');
    meta.className = 'agent-row__meta agent-row__outside';
    meta.textContent = ['Outside', t.machine, t.directory, t.branch, 'Ended'].filter(Boolean).join(' \u00b7 ');
    row.append(head, meta);
    const reason = AgentBoard.resumeReason(r);
    if (reason) {
      row.appendChild(this._reasonLine(`${this.prefix}-resume-reason-${id}`, 'resume-reason', reason));
    }
    if (typeof t.lastExcerpt === 'string' && t.lastExcerpt) {
      const line = document.createElement('span');
      line.className = 'agent-row__line';
      line.dataset.testid = `${this.prefix}-agent-line-${id}`;
      line.dataset.kind = 'last-turn';
      line.textContent = t.lastExcerpt;
      row.appendChild(line);
    }
    return this._withResume(row, r);
  }

  // The one builder for a row's sibling action button. `busy` and `done` disable it; only `busy` sets aria-busy.
  _actionButton({ testid, name, text, busyText, busy = false, done = false, onClick }) {
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'agent-row__action';
    act.dataset.testid = testid;
    act.setAttribute('aria-label', name);
    if (busy) {
      act.disabled = true;
      act.setAttribute('aria-busy', 'true');
      act.textContent = busyText;
    } else if (done) {
      act.disabled = true;
      act.textContent = text;
    } else {
      act.textContent = text;
      act.addEventListener('click', onClick);
    }
    return act;
  }

  // A one-line reason inside a row that offers no action.
  _reasonLine(testid, kind, text) {
    const why = document.createElement('span');
    why.className = 'agent-row__line';
    why.dataset.testid = testid;
    why.dataset.kind = kind;
    why.textContent = text;
    return why;
  }

  // The action is a sibling of the row: a button cannot hold a button.
  _wrapActions(row, ...buttons) {
    const wrap = document.createElement('div');
    wrap.className = 'agent-row-wrap';
    wrap.append(row, ...buttons);
    return wrap;
  }

  _withResume(row, r) {
    if (!AgentBoard.showsResume(r)) return row;
    const { id, label } = r;
    return this._wrapActions(row, this._actionButton({
      testid: `${this.prefix}-resume-${id}`,
      name: `Resume ${label} in a terminal`,
      text: AgentBoard.resumed.has(id) ? 'Resumed' : 'Resume',
      busyText: 'Resuming\u2026',
      busy: AgentBoard.resuming.has(id),
      done: AgentBoard.resumed.has(id),
      onClick: () => {
        this.onOpen?.(r);
        AgentBoard.resumeOutside(this.container, id);
      },
    }));
  }

  _row(r, held) {
    if (r.group === 'ended' && r.kind === 'outside') return this._endedRow(r);
    const { kind, id, state, label, project, item: t } = r;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'agent-row';
    row.dataset.testid = `${this.prefix}-agent-${id}`;
    row.setAttribute('aria-label', label);
    row.dataset.kind = kind;
    row.dataset.state = state;

    if (this.layout === 'rail') row.classList.add('agent-row--rail');
    const head = document.createElement('span');
    head.className = 'agent-row__head';
    const dot = document.createElement('span');
    dot.className = 'agent-row__dot';
    dot.dataset.state = state;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', AgentBoard.STATE_WORDS[state] || state);
    dot.id = `${this.prefix}-agent-dot-${id}`;
    row.setAttribute('aria-describedby', dot.id);
    head.appendChild(dot);
    const title = document.createElement('span');
    title.className = 'agent-row__title';
    title.textContent = label;
    head.appendChild(title);
    if (AgentBoard.isUnsandboxed(r)) head.appendChild(this._unsandboxedChip(r));
    if (this.layout === 'rail') {
      const age = r.kind !== 'terminal' ? AgentBoard.ago(r.since) : '';
      if (age) {
        const a = document.createElement('span');
        a.className = 'agent-row__age';
        a.dataset.testid = `${this.prefix}-agent-age-${id}`;
        a.textContent = age;
        head.appendChild(a);
      }
      row.appendChild(head);
      this._railLines(row, r, held);
      row.addEventListener('click', () => this._open(r));
      return this._withActions(row, r);
    }
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

    const why = kind === 'session' && state === 'errored' ? AgentBoard.exitLine(r.exit) : '';
    if (why) {
      const last = document.createElement('span');
      last.className = 'agent-row__last';
      last.textContent = why;
      row.appendChild(last);
    }
    if (kind === 'terminal') {
      const line = held != null ? held : (AgentBoard.lines.get(id)?.line || '');
      if (line) {
        const last = document.createElement('span');
        last.className = 'agent-row__last';
        last.textContent = line;
        row.appendChild(last);
      }
    }
    row.addEventListener('click', () => this._open(r));
    return this._withActions(row, r);
  }

  _open(r) {
    // onOpen first: a sheet closes (no focus return) before the pane switch hides its opener.
    if (r.kind === 'outside') {
      if (r.item.machineStatus !== 'unreachable') { this.onOpen?.(r); this.openOutsideThread?.(r.item); }
      return;
    }
    if (r.id?.startsWith('outside:')) return;
    this.onOpen?.(r);
    if (r.kind === 'session') this.container.get('app').joinSession(r.id);
    else this._attach(r.id);
  }

  // Rail lines 2 and 3: project and state words, then the live last line or the note.
  _railLines(row, r, held) {
    const { kind, id, state, project, item: t } = r;
    if (kind === 'outside') {
      const meta = document.createElement('span');
      meta.className = 'agent-row__meta agent-row__outside';
      meta.textContent = ['Outside', t.machine, t.directory, t.branch, AgentBoard.STATE_WORDS[state]].filter(Boolean).join(' · ');
      const action = document.createElement('span');
      action.className = 'agent-row__line';
      action.textContent = t.machineStatus === 'unreachable' ? 'Thread unavailable: Host is unreachable' : 'Read-only thread';
      row.append(meta, action);
      const why = AgentBoard.adoptReason(r);
      if (why) row.appendChild(this._reasonLine(`${this.prefix}-adopt-reason-${id}`, 'adopt-reason', why));
      return;
    }
    const words = kind === 'session' ? AgentBoard.STATE_WORDS[state] || state
      : t.state !== 'stopped' ? 'open' : `exited${t.exitCode != null ? ` ${t.exitCode}` : ''}`;
    const meta = document.createElement('span');
    meta.className = 'agent-row__meta';
    meta.dataset.testid = `${this.prefix}-agent-meta-${id}`;
    meta.textContent = project?.name ? `${project.name} \u00b7 ${words}` : words;
    row.appendChild(meta);

    let text = '';
    let lineKind = '';
    let source = '';
    let mono = true;
    if (kind === 'terminal') {
      text = held != null ? held : (AgentBoard.lines.get(id)?.line || '');
      lineKind = 'last';
      source = 'terminal';
    } else if (state === 'errored' && AgentBoard.exitLine(r.exit)) {
      text = AgentBoard.exitLine(r.exit);
      lineKind = 'exit';
      source = 'relay';
    } else {
      const n = this.note ? this.note(id) : null;
      const wanted = r.group === 'needs' ? 'alert' : (r.group === 'idle' || r.group === 'done') ? 'summary' : '';
      if (n && n.text && wanted && n.kind === wanted) {
        text = n.text;
        lineKind = n.kind;
        source = n.source;
        mono = n.source !== 'model';
      }
    }
    if (!text) return;
    const line = document.createElement('span');
    line.className = kind === 'terminal' ? 'agent-row__last' : 'agent-row__line';
    line.classList.add(mono ? 'agent-row__line--mono' : 'agent-row__line--prose');
    line.dataset.testid = `${this.prefix}-agent-line-${id}`;
    line.dataset.kind = lineKind;
    line.dataset.source = source;
    line.textContent = text;
    row.appendChild(line);
  }

  // The sibling buttons a row offers, if any: Drop in or, on an outside row, View read-only
  // (in tmux) and Adopt.
  _withActions(row, r) {
    return r.kind === 'outside' ? this._withOutsideActions(row, r) : this._withDropIn(row, r);
  }

  _withOutsideActions(row, r) {
    const buttons = [];
    // The tmux viewer (G6.95) keeps a door of its own beside the row's thread.
    if (r.item.viewable) {
      buttons.push(this._actionButton({
        testid: `${this.prefix}-view-${r.id}`,
        name: `View ${r.label} read-only`,
        text: 'View read-only',
        onClick: () => {
          this.onOpen?.(r);
          this.openOutside?.(r.item);
        },
      }));
    }
    if (AgentBoard.showsAdopt(r)) buttons.push(this._adoptButton(r));
    return buttons.length ? this._wrapActions(row, ...buttons) : row;
  }

  _adoptButton(r) {
    const { id, label } = r;
    const kind = AgentBoard.adopting.get(id);
    const interrupt = kind ? kind === 'interrupt' : r.item.state !== 'idle';
    return this._actionButton({
      testid: `${this.prefix}-${interrupt ? 'interrupt-adopt' : 'adopt'}-${id}`,
      name: interrupt ? `Interrupt and adopt ${label}` : `Adopt ${label}`,
      text: AgentBoard.adopted.has(id) ? 'Adopted' : interrupt ? 'Interrupt and adopt' : 'Adopt',
      busyText: interrupt ? 'Interrupting\u2026' : 'Adopting\u2026',
      busy: !!kind,
      done: AgentBoard.adopted.has(id),
      // A refusal closes a phone sheet so the toast shows; a success leaves it open on the result.
      onClick: () => AgentBoard.adoptOutside(this.container, id, { interrupt, onRefuse: () => this.onOpen?.(r) }),
    });
  }

  _withDropIn(row, r) {
    const { id, label } = r;
    if (!AgentBoard.showsDropIn(r)) return row;
    const kind = AgentBoard.dropping.get(id);
    const wait = kind ? kind === 'wait' : r.group === 'working';
    return this._wrapActions(row, this._actionButton({
      testid: `${this.prefix}-${wait ? 'take-over' : 'drop-in'}-${id}`,
      name: wait ? `Take over ${label} after this turn` : `Drop in to ${label}`,
      text: wait ? 'Take over after this turn' : 'Drop in',
      busyText: wait ? 'Waiting for the turn to end…' : 'Dropping in…',
      busy: !!kind,
      // onOpen fires when relay answers, so a sheet stays open on the waiting text.
      onClick: () => AgentBoard.dropIn(this.container, id, { wait, onAnswer: () => this.onOpen?.(r) }),
    }));
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
    const collapsed = this.collapseDone && key === 'done' && !this._doneOpen;
    if (this.layout === 'rail') {
      head.tabIndex = -1;
      head.dataset.testid = `${this.prefix}-agents-group-${key}-head`;
    }
    if (this.collapseDone && key === 'done') {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'agent-board__group-toggle';
      toggle.dataset.testid = `${this.prefix}-agents-group-done-toggle`;
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.append(title, count);
      toggle.addEventListener('click', () => {
        this._doneOpen = !this._doneOpen;
        this.render();
        this.el?.querySelector(`[data-testid="${this.prefix}-agents-group-done-toggle"]`)?.focus();
      });
      head.appendChild(toggle);
    } else {
      head.append(title, count);
    }
    sec.appendChild(head);
    if (collapsed) return sec;
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
