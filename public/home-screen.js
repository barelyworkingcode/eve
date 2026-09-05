/**
 * Home screen — the view behind #welcomeScreen when no tab is open.
 *
 * Orientation surface: greets, shows what's running, lets you pick up a
 * recent session or start a new one without opening the sidebar. Renders
 * from StateStore + TabManager's recent-session memory; nothing here talks
 * to the server directly.
 */
class HomeScreen {
  static MAX_RECENT = 6;

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.el = null;
    this._raf = 0;
  }

  init() {
    this.el = document.getElementById('homeContent');
    if (!this.el) return;

    const rerender = () => this.scheduleRender();
    for (const evt of [
      EVT.SESSION_UPDATED, EVT.SESSION_REMOVED, EVT.SESSION_CREATED, EVT.SESSION_RENAMED,
      EVT.PROJECTS_LOADED, EVT.PROJECT_ACTIVATED, EVT.PROJECT_RENAMED, EVT.PROJECT_DELETED,
      EVT.TERMINAL_TEMPLATES_LOADED, EVT.UI_SHOW_WELCOME,
    ]) {
      this.bus.on(evt, rerender);
    }
    this.render();
  }

  scheduleRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  get _app() {
    return this.container.has('app') ? this.container.get('app') : null;
  }

  get _tabs() {
    return this.container.has('tabManager') ? this.container.get('tabManager') : null;
  }

  render() {
    if (!this.el) return;
    const projects = this.state.getVisibleProjects();
    const activeProjectId = this._app?.projectTree?.activeProjectId
      || this._app?._resolveActiveProjectId?.() || null;
    const activeProject = activeProjectId ? this.state.getProject(activeProjectId) : null;

    this.el.innerHTML = '';
    this.el.appendChild(this._renderHeader(projects));

    if (projects.length === 0) {
      this.el.appendChild(this._renderFirstRun());
      return;
    }

    this.el.appendChild(this._renderStart(activeProject));
    this.el.appendChild(this._renderContinue());
    this.el.appendChild(this._renderProjects(projects, activeProjectId));
  }

  // — Header ----------------------------------------------------------------

  _renderHeader(projects) {
    const header = document.createElement('div');
    header.className = 'home__header';

    const h1 = document.createElement('h1');
    h1.className = 'home__greeting';
    h1.textContent = HomeScreen.greeting(new Date());
    header.appendChild(h1);

    const sub = document.createElement('p');
    sub.className = 'home__subtitle';
    sub.textContent = this._summaryLine(projects);
    header.appendChild(sub);
    return header;
  }

  _summaryLine(projects) {
    const sessions = this._allSessions();
    const running = sessions.filter(s => s.active).length;
    const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const parts = [];
    if (running > 0) parts.push(`${running} session${running === 1 ? '' : 's'} running`);
    else if (sessions.length > 0) parts.push('Nothing running');
    if (projects.length > 0) parts.push(`${projects.length} project${projects.length === 1 ? '' : 's'}`);
    parts.push(date);
    return parts.join(' · ');
  }

  static greeting(date) {
    const h = date.getHours();
    if (h < 5) return 'Working late.';
    if (h < 12) return 'Good morning.';
    if (h < 17) return 'Good afternoon.';
    if (h < 22) return 'Good evening.';
    return 'Working late.';
  }

  // — First run ---------------------------------------------------------------

  _renderFirstRun() {
    const card = document.createElement('div');
    card.className = 'home__first-run';
    card.innerHTML = `
      <div class="home__first-run-art" aria-hidden="true">${HomeScreen.ICONS.spark}</div>
      <h2>Start with a project</h2>
      <p>A project is a folder Eve can see. Sessions, files, terminals and tasks all live inside one.</p>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home__primary-btn';
    btn.dataset.testid = 'home-new-project';
    btn.textContent = 'Create a project';
    btn.addEventListener('click', () => this.bus.emit(EVT.DIALOG_PROJECT, {}));
    card.appendChild(btn);
    return card;
  }

  // — Start -------------------------------------------------------------------

  _renderStart(project) {
    const section = document.createElement('section');
    section.className = 'home__section';
    section.appendChild(this._eyebrow('Start', project ? `in ${project.name}` : ''));

    const grid = document.createElement('div');
    grid.className = 'home__tiles';

    const projectId = project?.id || null;
    const open = (intent) => this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId, intent });

    grid.appendChild(this._tile({
      tone: 'blue', icon: HomeScreen.ICONS.chat, name: 'Chat',
      desc: 'Talk to a model in the browser', testid: 'home-tile-chat',
      onClick: () => open('web-chat'),
    }));

    const templates = this.state.terminalTemplates || [];
    const tones = ['orange', 'gray', 'purple', 'green'];
    templates.slice(0, 2).forEach((tmpl, i) => {
      grid.appendChild(this._tile({
        tone: tones[i % tones.length],
        icon: /shell|zsh|bash|terminal/i.test(tmpl.id + tmpl.name) ? HomeScreen.ICONS.terminal : HomeScreen.ICONS.agent,
        name: tmpl.name,
        desc: HomeScreen.shortDescription(tmpl.description) || 'Terminal session',
        testid: `home-tile-${tmpl.id}`,
        onClick: () => open(`terminal:${tmpl.id}`),
      }));
    });

    grid.appendChild(this._tile({
      tone: 'teal', icon: HomeScreen.ICONS.mic, name: 'Voice',
      desc: 'Hands-free conversation', testid: 'home-tile-voice',
      onClick: () => open('voice-chat'),
    }));

    section.appendChild(grid);
    return section;
  }

  static shortDescription(desc) {
    if (!desc) return '';
    const cut = String(desc).split(/[(:;]/)[0].trim();
    return cut.length > 44 ? cut.slice(0, 41).trimEnd() + '…' : cut;
  }

  _tile({ tone, icon, name, desc, onClick, testid }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `home__tile home__tile--${tone}`;
    btn.dataset.testid = testid;
    btn.innerHTML = `
      <span class="home__tile-icon">${icon}</span>
      <span class="home__tile-name">${escapeHtml(name)}</span>
      <span class="home__tile-desc">${escapeHtml(desc)}</span>
    `;
    btn.addEventListener('click', onClick);
    return btn;
  }

  // — Continue ----------------------------------------------------------------

  _allSessions() {
    const out = [];
    for (const s of this.state.sessions.values()) {
      if (this.state.isTaskRun(s.id)) continue;
      out.push(s);
    }
    return out;
  }

  _recentSessions() {
    const recents = (typeof SessionRecents !== 'undefined') ? SessionRecents.list() : [];
    const byId = new Map(this._allSessions().map(s => [s.id, s]));

    const ordered = [];
    const seen = new Set();
    const push = (s, ts) => {
      if (!s || seen.has(s.id)) return;
      seen.add(s.id);
      ordered.push({ session: s, openedAt: ts || null });
    };
    const serverTime = (s) => {
      const t = Date.parse(s.lastMessageAt || s.createdAt || '');
      return Number.isNaN(t) ? 0 : t;
    };
    for (const r of recents) push(byId.get(r.id), r.lastOpenedAt);
    for (const s of byId.values()) if (s.active) push(s, serverTime(s) || null);
    // Sessions this browser never opened, newest server activity first.
    const rest = [...byId.values()].filter(s => !seen.has(s.id) && serverTime(s) > 0)
      .sort((a, b) => serverTime(b) - serverTime(a));
    for (const s of rest) push(s, serverTime(s));
    return ordered.slice(0, HomeScreen.MAX_RECENT);
  }

  _renderContinue() {
    const section = document.createElement('section');
    section.className = 'home__section';
    section.appendChild(this._eyebrow('Continue', '', { kbd: '⌘K', hint: 'jump anywhere' }));

    const recent = this._recentSessions();
    if (recent.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'home__empty';
      empty.textContent = 'Nothing yet. Start a session above and it will show up here.';
      section.appendChild(empty);
      return section;
    }

    const list = document.createElement('div');
    list.className = 'home__list';
    for (const { session, openedAt } of recent) {
      list.appendChild(this._sessionRow(session, openedAt));
    }
    section.appendChild(list);
    return section;
  }

  _sessionRow(session, openedAt) {
    const project = this.state.getProject(session.projectId);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'home__row';
    row.dataset.testid = `home-session-${session.id}`;

    const mono = document.createElement('span');
    mono.className = 'home__monogram';
    mono.style.setProperty('--project-avatar-bg', this.state.projectColor(session.projectId));
    mono.textContent = projectMonogram(project?.name || '?');
    row.appendChild(mono);

    const body = document.createElement('span');
    body.className = 'home__row-body';
    const title = document.createElement('span');
    title.className = 'home__row-title';
    title.textContent = HomeScreen.displayName(session, project);
    const sub = document.createElement('span');
    sub.className = 'home__row-sub';
    const model = session.model ? session.model.split('/').pop() : '';
    sub.textContent = [project?.name, model].filter(Boolean).join(' · ');
    body.appendChild(title);
    body.appendChild(sub);
    row.appendChild(body);

    const meta = document.createElement('span');
    meta.className = 'home__row-meta';
    if (session.active) {
      const live = document.createElement('span');
      live.className = 'home__live';
      live.title = 'Running';
      meta.appendChild(live);
    }
    if (openedAt) {
      const time = document.createElement('span');
      time.className = 'home__row-time';
      time.textContent = relativeTime(openedAt);
      meta.appendChild(time);
    }
    row.appendChild(meta);

    row.addEventListener('click', () => {
      const app = this._app;
      if (app?.joinSession) app.joinSession(session.id);
    });
    return row;
  }

  static displayName(session, project) {
    return sessionDisplayName(session, project) || session.id;
  }

  // — Projects ----------------------------------------------------------------

  _renderProjects(projects, activeProjectId) {
    const section = document.createElement('section');
    section.className = 'home__section';
    section.appendChild(this._eyebrow('Projects'));

    const wrap = document.createElement('div');
    wrap.className = 'home__chips';
    const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const p of sorted) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `home__chip${p.id === activeProjectId ? ' home__chip--active' : ''}`;
      chip.dataset.testid = `home-project-${p.id}`;
      const running = this.state.getSessionsForProject(p.id).filter(s => s.active && !this.state.isTaskRun(s.id)).length;
      chip.innerHTML = `
        <span class="home__monogram home__monogram--sm" style="--project-avatar-bg:${this.state.projectColor(p.id)}">${escapeHtml(projectMonogram(p.name))}</span>
        <span class="home__chip-name">${escapeHtml(p.name)}</span>
        ${running ? `<span class="home__live" title="${running} running"></span>` : ''}
      `;
      chip.addEventListener('click', () => this.bus.emit(EVT.PROJECT_ACTIVATED, { projectId: p.id }));
      wrap.appendChild(chip);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'home__chip home__chip--add';
    add.dataset.testid = 'home-new-project';
    add.innerHTML = `${HomeScreen.ICONS.plus}<span class="home__chip-name">New project</span>`;
    add.addEventListener('click', () => this.bus.emit(EVT.DIALOG_PROJECT, {}));
    wrap.appendChild(add);

    section.appendChild(wrap);
    return section;
  }

  // — Bits ----------------------------------------------------------------------

  _eyebrow(label, detail = '', hint = null) {
    const row = document.createElement('div');
    row.className = 'home__eyebrow';
    const l = document.createElement('span');
    l.className = 'home__eyebrow-label';
    l.textContent = label;
    row.appendChild(l);
    if (detail) {
      const d = document.createElement('span');
      d.className = 'home__eyebrow-detail';
      d.textContent = detail;
      row.appendChild(d);
    }
    if (hint) {
      const h = document.createElement('span');
      h.className = 'home__eyebrow-hint';
      h.innerHTML = `<kbd>${escapeHtml(hint.kbd)}</kbd> ${escapeHtml(hint.hint)}`;
      row.appendChild(h);
    }
    return row;
  }
}

HomeScreen.ICONS = {
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.2-4.3A8 8 0 1 1 21 12z"/></svg>',
  agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3M12 15h5"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = HomeScreen;
}
