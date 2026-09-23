// Sidebar "Changes" tab: git status per repo/worktree under the project root
// (docs/design-git-changes.md). Owns the data (cache per project + scope) and
// renders into whatever element ProjectPanel hands it; ProjectPanel owns the
// tab strip and asks for the badge count.
class ChangesPanel {
  static SCOPE_KEY = 'eve-changes-scope';
  static COLLAPSED_KEY = 'eve-changes-collapsed';
  static SCOPES = ['uncommitted', 'base'];
  static REFRESH_DEBOUNCE_MS = 300;
  // setProject() fires on every PROJECTS_LOADED; don't re-request a list
  // younger than this unless the user asks or the watcher says it changed.
  static FRESH_MS = 5000;
  // ws.send drops frames while the socket is down and a rate-limited request
  // gets no git reply, so an in-flight marker older than this is abandoned.
  static REQUEST_TIMEOUT_MS = 15000;

  static STATUS_LABELS = {
    M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflicted', '?': 'Untracked',
  };

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.ws = container.get('ws');
    this.state = container.get('state');
    this.log = container.get('logger').child('ChangesPanel');

    this.projectId = null;
    this.scope = this._restoreScope();
    // key `${projectId}|${scope}` -> { repos: [], error, loading, stale, fetchedAt, hasData }
    this._cache = new Map();
    // Keys with a full (all-repo) request in flight. A reply without a `repo`
    // echo is a full list and settles the key; one with `repo` only merges.
    this._pendingFull = new Set();
    this._pendingRepos = new Set();
    this._refreshTimer = null;

    // Set by ProjectPanel: re-render tabs (badge) and, when active, content.
    this.onUpdate = null;

    this._subscribe();
  }

  // --- Public surface for ProjectPanel ------------------------------------

  setProject(projectId) {
    if (this.projectId !== projectId) {
      this._pendingRepos.clear();
      if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    }
    this.projectId = projectId;
    if (projectId) this._ensureFresh();
  }

  // Total changed files across the repos that have arrived for the current
  // scope (pending repos contribute nothing yet); null hides the badge.
  count() {
    const entry = this._entry();
    if (!entry || !entry.hasData) return null;
    return entry.repos.reduce((n, r) => n + (!r.pending && r.files ? r.files.length : 0), 0);
  }

  refresh() {
    this._requestAll(true);
  }

  // The host bar changed; greying depends on it, and a reconnect wants data.
  onHostStatus() {
    if (!this.projectId) return;
    if (!this._hostUnreachable()) this._ensureFresh();
  }

  render(root) {
    const panel = document.createElement('div');
    panel.className = 'changes-panel';
    panel.dataset.testid = 'changes-panel';
    root.appendChild(panel);

    panel.appendChild(this._renderScopeToggle());

    const entry = this._entry();
    const unreachable = this._hostUnreachable();

    if (unreachable) {
      panel.appendChild(this._note('changes-panel__note changes-panel__note--warn', 'changes-host-note',
        entry && entry.hasData ? 'Host unreachable. Showing the last known changes.' : 'Host unreachable.'));
    }

    if (!entry || !entry.hasData) {
      if (entry && entry.error && !unreachable) {
        panel.appendChild(this._renderTopError(entry.error));
      } else if (!unreachable) {
        panel.appendChild(this._note('changes-panel__note', 'changes-loading', 'Loading changes…'));
      }
      return;
    }

    if (entry.error && !unreachable) panel.appendChild(this._renderTopError(entry.error));

    if (entry.repos.length === 0) {
      panel.appendChild(this._note('changes-panel__note', 'changes-empty', 'No git repositories in this project'));
      return;
    }

    const list = document.createElement('div');
    list.className = `changes-panel__list${unreachable ? ' changes-panel__list--stale' : ''}`;
    if (unreachable) list.setAttribute('aria-disabled', 'true');
    for (const repo of this._sortedRepos(entry.repos)) {
      this._renderRepoGroup(list, repo, unreachable);
    }
    panel.appendChild(list);
  }

  // --- Requests -------------------------------------------------------------

  _key(projectId = this.projectId, scope = this.scope) {
    return `${projectId}|${scope}`;
  }

  _entry(key = this._key()) {
    return this._cache.get(key) || null;
  }

  _entryFor(key) {
    let entry = this._cache.get(key);
    if (!entry) {
      entry = { repos: [], error: null, loading: false, stale: true, fetchedAt: 0, hasData: false };
      this._cache.set(key, entry);
    }
    return entry;
  }

  _ensureFresh() {
    const entry = this._entry();
    if (entry && (this._inFlight(entry) || this._streaming(entry)
      || (!entry.stale && Date.now() - entry.fetchedAt < ChangesPanel.FRESH_MS))) return;
    this._requestAll(false);
  }

  _requestAll(force) {
    if (!this.projectId || this._hostUnreachable()) return;
    const key = this._key();
    const entry = this._entryFor(key);
    if (this._inFlight(entry) && !force) return;
    entry.loading = true;
    entry.requestedAt = Date.now();
    this._pendingFull.add(key);
    this.ws.send({ type: 'git_changes', projectId: this.projectId, scope: this.scope });
  }

  _inFlight(entry) {
    return entry.loading && Date.now() - (entry.requestedAt || 0) < ChangesPanel.REQUEST_TIMEOUT_MS;
  }

  // A full reply streams: the full-list frame settles the request (so the
  // request timeout never covers the stream), then per-repo frames fill the
  // pending repos in. While repos are still pending and frames keep coming,
  // don't start a second full request over the top of the first. The
  // timeout is measured from the last frame, so a long but progressing
  // stream counts as live and a dropped one is eventually abandoned.
  _streaming(entry) {
    return entry.repos.some(r => r.pending)
      && Date.now() - (entry.streamedAt || 0) < ChangesPanel.REQUEST_TIMEOUT_MS;
  }

  _requestRepo(repoPath) {
    if (!this.projectId || this._hostUnreachable()) return;
    this.ws.send({ type: 'git_changes', projectId: this.projectId, scope: this.scope, repo: repoPath });
  }

  _scheduleRefresh(repoPath) {
    this._pendingRepos.add(repoPath || '*');
    if (this._refreshTimer) clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      const repos = [...this._pendingRepos];
      this._pendingRepos.clear();
      const entry = this._entry();
      const known = new Set((entry?.repos || []).map(r => r.path));
      // An unknown repo may be a brand-new worktree; only a full discovery finds it.
      if (!entry || !entry.hasData || repos.some(p => p === '*' || !known.has(p))) {
        this._requestAll(true);
        return;
      }
      for (const p of repos) this._requestRepo(p);
    }, ChangesPanel.REFRESH_DEBOUNCE_MS);
  }

  // --- Inbound frames -------------------------------------------------------

  _subscribe() {
    this.bus.on(EVT.GIT_CHANGES, (msg) => this._onChanges(msg));
    this.bus.on(EVT.GIT_ERROR, (msg) => this._onError(msg));
    this.bus.on(EVT.GIT_CHANGED, (msg) => this._onChanged(msg));
  }

  _onChanges(msg) {
    if (!msg || !msg.projectId || !Array.isArray(msg.repos)) return;
    const scope = ChangesPanel.SCOPES.includes(msg.scope) ? msg.scope : 'uncommitted';
    const key = this._key(msg.projectId, scope);
    const entry = this._entryFor(key);

    if (msg.repo === undefined) {
      this._pendingFull.delete(key);
      entry.repos = msg.repos.slice();
      entry.loading = false;
      entry.stale = false;
      entry.fetchedAt = Date.now();
      entry.streamedAt = entry.fetchedAt;
    } else {
      entry.streamedAt = Date.now();
      // Single-repo refresh: replace just that group, append if new.
      for (const repo of msg.repos) {
        const i = entry.repos.findIndex(r => r.path === repo.path);
        if (i >= 0) entry.repos[i] = repo; else entry.repos.push(repo);
      }
    }
    entry.hasData = true;
    entry.error = null;
    this._notify(msg.projectId);
  }

  _onError(msg) {
    // Errors carrying a path belong to the diff pane.
    if (!msg || !msg.projectId || msg.path) return;
    const code = msg.code || 'FAILED';
    const message = msg.error || 'git failed';

    if (msg.repo) {
      // A single-repo refresh failed; the frame doesn't say which scope, so
      // apply to every cached scope of this project that has the repo.
      for (const scope of ChangesPanel.SCOPES) {
        const entry = this._entry(this._key(msg.projectId, scope));
        if (!entry) continue;
        const i = entry.repos.findIndex(r => r.path === msg.repo);
        if (i < 0) continue;
        if (code === 'NOT_A_REPO') entry.repos.splice(i, 1);  // worktree removed
        else entry.repos[i] = { ...entry.repos[i], error: { code, message } };
      }
      this._notify(msg.projectId);
      return;
    }

    for (const scope of ChangesPanel.SCOPES) {
      const key = this._key(msg.projectId, scope);
      if (!this._pendingFull.has(key)) continue;
      this._pendingFull.delete(key);
      const entry = this._entryFor(key);
      entry.loading = false;
      entry.fetchedAt = Date.now();
      entry.error = { code, message };
    }
    this._notify(msg.projectId);
  }

  _onChanged(msg) {
    if (!msg || !msg.projectId) return;
    // Other scopes (and other projects) refetch lazily when next shown.
    for (const [key, entry] of this._cache) {
      if (key.startsWith(`${msg.projectId}|`)) entry.stale = true;
    }
    if (msg.projectId !== this.projectId) return;
    this._scheduleRefresh(msg.repo && msg.repo !== '*' ? msg.repo : '*');
  }

  _notify(projectId) {
    if (projectId === this.projectId && this.onUpdate) this.onUpdate();
  }

  // --- Rendering ------------------------------------------------------------

  _renderScopeToggle() {
    const bar = document.createElement('div');
    bar.className = 'changes-panel__scope';

    const label = document.createElement('span');
    label.className = 'changes-panel__scope-label';
    label.id = 'changesScopeLabel';
    label.textContent = 'Scope';
    bar.appendChild(label);

    const group = document.createElement('div');
    group.className = 'changes-panel__segmented';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', 'changesScopeLabel');
    group.dataset.testid = 'changes-scope';

    const options = [
      { scope: 'uncommitted', text: 'Uncommitted', title: 'Working tree and index vs HEAD' },
      { scope: 'base', text: 'vs base', title: 'Everything on this branch since it left the default branch' },
    ];
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const active = opt.scope === this.scope;
      btn.className = `changes-panel__segment${active ? ' changes-panel__segment--active' : ''}`;
      btn.textContent = opt.text;
      btn.title = opt.title;
      btn.setAttribute('aria-pressed', String(active));
      btn.dataset.testid = `changes-scope-${opt.scope}`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._setScope(opt.scope);
      });
      group.appendChild(btn);
    }
    bar.appendChild(group);
    return bar;
  }

  _setScope(scope) {
    if (scope === this.scope || !ChangesPanel.SCOPES.includes(scope)) return;
    this.scope = scope;
    try { localStorage.setItem(ChangesPanel.SCOPE_KEY, scope); } catch (_) { /* not persisted */ }
    this._pendingRepos.clear();
    this._ensureFresh();
    if (this.onUpdate) this.onUpdate();
  }

  // Clean repos last. A pending repo isn't known to be clean, so it stays
  // up top until its status arrives.
  _sortedRepos(repos) {
    const isClean = (r) => !r.pending && !r.error && (!r.files || r.files.length === 0);
    return [...repos.filter(r => !isClean(r)), ...repos.filter(isClean)];
  }

  _renderRepoGroup(list, repo, disabled) {
    const pending = !!repo.pending;
    const files = pending ? [] : (repo.files || []);
    const clean = !pending && !repo.error && files.length === 0;
    const collapsed = this._isCollapsed(repo, clean);
    const bodyId = `changes-body-${this._domId(repo.path)}`;

    const group = document.createElement('div');
    group.className = 'changes-panel__group';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = `changes-panel__repo${collapsed ? ' changes-panel__repo--collapsed' : ''}`;
    header.dataset.testid = `changes-repo-${repo.path}`;
    header.setAttribute('aria-expanded', String(!collapsed));
    header.setAttribute('aria-controls', bodyId);
    header.title = repo.path === '/' ? 'Project root' : repo.path.replace(/^\//, '');
    if (repo.base) header.title += ` · base ${repo.base}`;

    const caret = document.createElement('span');
    caret.className = 'changes-panel__caret';
    caret.innerHTML = UI_ICONS.caret(12);
    header.appendChild(caret);

    const name = document.createElement('span');
    name.className = 'changes-panel__repo-name';
    name.textContent = repo.name || repo.path;
    header.appendChild(name);

    const ref = repo.detached || !repo.branch ? repo.head : repo.branch;
    if (ref) {
      const chip = document.createElement('span');
      chip.className = `changes-panel__branch${repo.detached ? ' changes-panel__branch--detached' : ''}`;
      chip.title = repo.detached ? `Detached HEAD at ${repo.head}` : `Branch ${repo.branch}${repo.upstream ? ` → ${repo.upstream}` : ''}`;
      chip.innerHTML = PANEL_ICONS.branchSmall;
      const text = document.createElement('span');
      text.className = 'changes-panel__branch-text';
      text.textContent = ref;
      chip.appendChild(text);
      header.appendChild(chip);
    }

    if (repo.ahead > 0 || repo.behind > 0) {
      const sync = document.createElement('span');
      sync.className = 'changes-panel__sync';
      const parts = [];
      if (repo.ahead > 0) parts.push(`↑${repo.ahead}`);
      if (repo.behind > 0) parts.push(`↓${repo.behind}`);
      sync.textContent = parts.join(' ');
      sync.title = `${repo.ahead} ahead, ${repo.behind} behind ${repo.upstream || 'upstream'}`;
      header.appendChild(sync);
    }

    if (pending) {
      // Status still streaming in: a spinner where the count will go.
      const spinner = document.createElement('span');
      spinner.className = 'changes-panel__pending';
      spinner.dataset.testid = `changes-repo-pending-${repo.path}`;
      spinner.setAttribute('role', 'status');
      spinner.setAttribute('aria-label', 'Loading changes');
      spinner.title = 'Loading changes…';
      header.appendChild(spinner);
      header.setAttribute('aria-busy', 'true');
    } else {
      const count = document.createElement('span');
      count.className = `changes-panel__count${clean ? ' changes-panel__count--clean' : ''}`;
      count.textContent = repo.error ? '!' : (clean ? 'clean' : String(files.length));
      if (repo.error) count.classList.add('changes-panel__count--error');
      header.appendChild(count);
    }

    header.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleCollapsed(repo, clean);
    });
    group.appendChild(header);

    const body = document.createElement('div');
    body.className = 'changes-panel__files';
    body.id = bodyId;
    body.hidden = collapsed;
    if (!collapsed && !pending) {
      if (repo.error) {
        const err = document.createElement('div');
        err.className = 'changes-panel__repo-error';
        err.dataset.testid = `changes-repo-error-${repo.path}`;
        err.textContent = this._errorText(repo.error);
        body.appendChild(err);
      }
      for (const file of files) body.appendChild(this._renderFileRow(repo, file, disabled));
      if (repo.truncated) {
        body.appendChild(this._note('changes-panel__note', `changes-truncated-${repo.path}`, 'Showing first 5,000 files'));
      }
    }
    group.appendChild(body);
    list.appendChild(group);
  }

  _renderFileRow(repo, file, disabled) {
    const row = document.createElement('button');
    row.type = 'button';
    const status = ChangesPanel.STATUS_LABELS[file.status] ? file.status : 'M';
    row.className = 'changes-panel__file';
    row.dataset.testid = `changes-file-${repo.path}:${file.path}`;
    if (disabled) row.disabled = true;

    const slash = file.path.lastIndexOf('/');
    const base = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';

    const statusLabel = ChangesPanel.STATUS_LABELS[status];
    row.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
    row.setAttribute('aria-label', `${statusLabel}: ${file.oldPath ? `${file.oldPath} renamed to ${file.path}` : file.path}`);

    const letter = document.createElement('span');
    letter.className = `changes-panel__status changes-panel__status--${status === '?' ? 'untracked' : status}`;
    letter.textContent = status;
    letter.setAttribute('aria-hidden', 'true');
    row.appendChild(letter);

    const icon = document.createElement('span');
    icon.className = 'changes-panel__icon';
    icon.appendChild(getFileIconSVG(base));
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = `changes-panel__name${status === 'D' ? ' changes-panel__name--deleted' : ''}`;
    name.textContent = base;
    row.appendChild(name);

    if (dir) {
      const dirEl = document.createElement('span');
      dirEl.className = 'changes-panel__dir';
      // LRM marks keep the trailing slash in place under the CSS rtl
      // (start-side ellipsis) trick.
      dirEl.textContent = `\u200E${dir}\u200E`;
      row.appendChild(dirEl);
    }

    // A <button> already turns Enter/Space into click.
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      this.bus.emit(EVT.GIT_OPEN_DIFF, {
        projectId: this.projectId,
        repo: repo.path,
        repoName: repo.name,
        branch: repo.branch || repo.head || null,
        path: file.path,
        oldPath: file.oldPath || null,
        status,
        scope: this.scope,
      });
      const app = this.container.has('app') ? this.container.get('app') : null;
      if (app?.closeSidebarOnMobile) app.closeSidebarOnMobile();
    });
    return row;
  }

  _renderTopError(error) {
    if (error.code === 'GIT_MISSING') {
      return this._note('changes-panel__note', 'changes-git-missing',
        this._isRemote() ? 'Git is not installed on this host.' : 'Git is not installed on this machine.');
    }
    return this._note('changes-panel__note changes-panel__note--error', 'changes-error', this._errorText(error));
  }

  _errorText(error) {
    const text = {
      GIT_MISSING: 'Git is not installed',
      TIMEOUT: 'git timed out',
      TOO_LARGE: 'Too many changes to list',
    }[error.code];
    return text || error.message || 'git failed';
  }

  _note(className, testid, text) {
    const el = document.createElement('div');
    el.className = className;
    el.dataset.testid = testid;
    el.textContent = text;
    return el;
  }

  // --- Collapse state -------------------------------------------------------

  // Stored as { "<projectId>:<repoPath>": true|false } so a clean repo the
  // user expanded stays expanded; absent keys fall back to "clean = collapsed".
  _collapsedMap() {
    try {
      const raw = localStorage.getItem(ChangesPanel.COLLAPSED_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  _isCollapsed(repo, clean) {
    const v = this._collapsedMap()[`${this.projectId}:${repo.path}`];
    return typeof v === 'boolean' ? v : clean;
  }

  _toggleCollapsed(repo, clean) {
    const map = this._collapsedMap();
    const key = `${this.projectId}:${repo.path}`;
    map[key] = !this._isCollapsed(repo, clean);
    try {
      localStorage.setItem(ChangesPanel.COLLAPSED_KEY, JSON.stringify(map));
    } catch (_) { /* storage full / disabled — collapse just won't persist */ }
    if (this.onUpdate) this.onUpdate({ focusTestId: `changes-repo-${repo.path}` });
  }

  // --- Helpers --------------------------------------------------------------

  _restoreScope() {
    try {
      const s = localStorage.getItem(ChangesPanel.SCOPE_KEY);
      return ChangesPanel.SCOPES.includes(s) ? s : 'uncommitted';
    } catch (_) {
      return 'uncommitted';
    }
  }

  _project() {
    return this.projectId ? this.state.getProject(this.projectId) : null;
  }

  _isRemote() {
    return !!this._project()?.host;
  }

  _hostUnreachable() {
    const project = this._project();
    if (!project?.host) return false;
    const status = this.state.hostStatus?.(project.host.id) || project.host.status;
    return status === 'unreachable';
  }

  _domId(path) {
    return `${this.projectId}-${path}`.replace(/[^A-Za-z0-9_-]/g, '_');
  }
}
