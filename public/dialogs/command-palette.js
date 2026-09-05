const PALETTE_GROUP_ORDER = ['Actions', 'Sessions', 'Projects', 'Open tabs', 'Recent files'];
const PALETTE_MAX_PER_GROUP = 8;
const PALETTE_EMPTY_ACTIONS_LIMIT = 4;
const PALETTE_EMPTY_SESSIONS_LIMIT = 6;

class CommandPalette extends DialogBase {
  constructor(container) {
    super(container, 'command-palette');
    this._panel.classList.add('palette');
    this.state = container.get('state');
    this._query = '';
    this._items = [];       // flat, ranked/grouped list currently rendered
    this._selectedIndex = 0;
    this._inputEl = null;
    this._listEl = null;
    this._rowEls = [];
  }

  init() {
    this.bus.on(EVT.DIALOG_COMMAND_PALETTE, () => this.open());
  }

  // --- opening / closing -------------------------------------------------

  handleHotkey(e) {
    const isToggleChord = (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k';
    if (!isToggleChord) return;
    e.preventDefault();
    if (this.isVisible) {
      this.hide();
    } else {
      this.open();
    }
  }

  open() {
    this._query = '';
    this._rebuildItems();
    this._render();
    this.show();
    requestAnimationFrame(() => this._inputEl?.focus());
  }

  // --- data collection -----------------------------------------------------

  _collectActions() {
    const app = this.container.get('app');
    const tabManager = this.container.get('tabManager');
    const settings = this.container.has('settings') ? this.container.get('settings') : null;
    const actions = [];

    const activeProjectId = app._resolveActiveProjectId ? app._resolveActiveProjectId() : null;

    if (activeProjectId) {
      actions.push({
        id: 'action:new-session',
        label: 'New session…',
        sub: 'Chat, Claude Code, shell or voice',
        icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
        run: () => this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: activeProjectId }),
      });
      actions.push({
        id: 'action:search-files',
        label: 'Search in files',
        sub: this.state.getProject(activeProjectId)?.name || '',
        icon: UI_ICONS.search(16),
        meta: { kbd: '⌘⇧F' },
        run: () => this.bus.emit(EVT.DIALOG_SEARCH, { projectId: activeProjectId }),
      });
    }

    actions.push({
      id: 'action:new-project',
      label: 'New project',
      sub: 'Create a project',
      icon: UI_ICONS.newFolder(16),
      run: () => this.bus.emit(EVT.DIALOG_PROJECT, {}),
    });

    actions.push({
      id: 'action:settings',
      label: 'Settings',
      sub: 'Appearance, voice, providers',
      icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M3.1 12.9l1.4-1.4M11.5 4.5l1.4-1.4"/></svg>',
      run: () => this.bus.emit(EVT.DIALOG_SETTINGS, {}),
    });

    if (settings) {
      const currentMode = settings.getThemeMode ? settings.getThemeMode() : 'auto';
      const modes = [
        { mode: 'auto', label: 'Appearance: Auto' },
        { mode: 'light', label: 'Appearance: Light' },
        { mode: 'dark', label: 'Appearance: Dark' },
      ];
      for (const { mode, label } of modes) {
        actions.push({
          id: `action:theme-${mode}`,
          label,
          sub: `currently ${currentMode}`,
          run: () => settings.setThemeMode(mode),
        });
      }
    }

    const activeTabId = tabManager?.activeTabId;
    if (activeTabId) {
      actions.push({
        id: 'action:close-tab',
        label: 'Close current tab',
        sub: 'Close the active tab',
        run: () => tabManager.closeTab(activeTabId),
      });
    }

    return actions;
  }

  _collectSessions() {
    const out = [];
    for (const session of this.state.sessions.values()) {
      if (this.state.isTaskRun(session.id)) continue;
      const project = session.projectId ? this.state.getProject(session.projectId) : null;
      const modelParts = (session.model || '').split('/');
      const chip = modelParts[modelParts.length - 1] || '';
      const label = (typeof sessionDisplayName === 'function')
        ? sessionDisplayName(session, project)
        : CommandPalette.stripProjectPrefix(session.name || session.id, project?.name);
      out.push({
        id: `session:${session.id}`,
        label,
        sub: project?.name || '',
        host: project?.host || null,
        session,
        iconMonogram: project ? { text: projectMonogram(project.name), color: this.state.projectColor(project.id) } : null,
        meta: { live: !!session.active, chip: chip || null },
        run: () => this.container.get('app').joinSession(session.id),
      });
    }
    return out;
  }

  _collectProjects() {
    const out = [];
    const app = this.container.get('app');
    for (const project of this.state.getVisibleProjects()) {
      const sessionCount = Array.from(this.state.sessions.values())
        .filter(s => s.projectId === project.id && !this.state.isTaskRun(s.id)).length;
      out.push({
        id: `project:${project.id}`,
        label: project.name,
        sub: `${sessionCount} session${sessionCount === 1 ? '' : 's'}`,
        host: project.host || null,
        iconMonogram: { text: projectMonogram(project.name), color: this.state.projectColor(project.id) },
        run: () => {
          app.projectTree?.setActive(project.id);
        },
      });
    }
    return out;
  }

  _collectOpenTabs() {
    const tabManager = this.container.get('tabManager');
    const out = [];
    for (const tab of tabManager?.tabs || []) {
      if (tab.id === tabManager.activeTabId) continue;
      out.push({
        id: `tab:${tab.id}`,
        label: tab.label || tab.id,
        sub: CommandPalette._tabTypeLabel(tab.type),
        icon: CommandPalette._tabIcon(tab.type),
        run: () => tabManager.switchToTab(tab.id),
      });
    }
    return out;
  }

  _collectRecentFiles() {
    const tabManager = this.container.get('tabManager');
    const out = [];
    for (const file of tabManager?.getRecentFiles?.() || []) {
      const filename = file.path.split('/').pop();
      const project = file.projectId ? this.state.getProject(file.projectId) : null;
      out.push({
        id: `recent-file:${file.projectId}:${file.path}`,
        label: filename,
        sub: project ? `${project.name} — ${file.path}` : file.path,
        icon: CommandPalette._tabIcon('file'),
        run: () => this.bus.emit(EVT.FILE_CONTENT, {
          projectId: file.projectId,
          path: file.path,
          filename,
          requestLoad: true,
        }),
      });
    }
    return out;
  }

  static _tabTypeLabel(type) {
    switch (type) {
      case 'session': return 'Session';
      case 'terminal': return 'Terminal';
      case 'module': return 'Module';
      case 'file': return 'File';
      default: return type || '';
    }
  }

  static _tabIcon(type) {
    switch (type) {
      case 'session': return UI_ICONS.chat(16);
      case 'terminal': return UI_ICONS.terminal(16);
      case 'module': return UI_ICONS.module(16);
      default: return '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 1.5h5l3 3v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-12a1 1 0 011-1z"/><path d="M9 1.5V5h3.5"/></svg>';
    }
  }

  // --- pure logic (static, unit-testable) ---------------------------------

  // Case-insensitive subsequence match of `query` against `text`. Returns
  // null when query is not a subsequence of text, otherwise {score, positions}
  // where positions are the matched character indices into text.
  static fuzzyScore(query, text) {
    const q = String(query || '').toLowerCase();
    const t = String(text || '').toLowerCase();
    if (!q) return { score: 0, positions: [] };

    let qi = 0;
    let score = 0;
    let lastMatch = -1;
    const positions = [];
    for (let ti = 0; ti < t.length && qi < q.length; ti++) {
      if (t[ti] !== q[qi]) continue;
      const isWordStart = ti === 0 || /[\s\-_/.]/.test(t[ti - 1]);
      const isContiguous = lastMatch === ti - 1;
      score += (isWordStart || isContiguous) ? 3 : 1;
      if (lastMatch >= 0) {
        const gap = ti - lastMatch - 1;
        if (gap > 0) score -= 0.1 * gap;
      }
      positions.push(ti);
      lastMatch = ti;
      qi += 1;
    }
    if (qi < q.length) return null;
    return { score, positions };
  }

  // Matches `query` against `label + ' ' + sub`, and returns highlight
  // positions restricted to the label portion (sub is never marked up).
  // Returns null when there is no match.
  static matchItem(query, label, sub) {
    const q = String(query || '').trim();
    if (!q) return { score: 0, labelPositions: [] };
    const combined = `${label || ''} ${sub || ''}`;
    const result = CommandPalette.fuzzyScore(q, combined);
    if (!result) return null;
    const labelLen = (label || '').length;
    const labelPositions = result.positions.filter(p => p < labelLen);
    let score = result.score;
    if ((label || '').toLowerCase().startsWith(q.toLowerCase())) score += 10;
    return { score, labelPositions };
  }

  // Builds highlighted (mark-wrapped), HTML-escaped markup for a label given
  // the matched character positions from matchItem().
  static highlightLabel(label, positions) {
    const text = String(label || '');
    if (!positions || positions.length === 0) return escapeHtml(text);
    const posSet = new Set(positions);
    let html = '';
    let i = 0;
    while (i < text.length) {
      if (posSet.has(i)) {
        let j = i;
        let run = '';
        while (j < text.length && posSet.has(j)) { run += text[j]; j++; }
        html += `<mark>${escapeHtml(run)}</mark>`;
        i = j;
      } else {
        let j = i;
        let run = '';
        while (j < text.length && !posSet.has(j)) { run += text[j]; j++; }
        html += escapeHtml(run);
        i = j;
      }
    }
    return html;
  }

  // Mirrors project-panel.js#_renderSessionRow: a session named
  // "<project> - foo" displays as just "foo" once its project context is
  // already shown elsewhere in the row.
  static stripProjectPrefix(name, projectName) {
    const n = name || '';
    if (projectName && n.startsWith(`${projectName} - `)) {
      return n.slice(projectName.length + 3);
    }
    return n;
  }

  // Empty-query session ordering: previously-opened tabs first (in
  // getRecentSessionIds() order), then active sessions, then everything
  // else, capped to `limit`.
  static orderSessionsForEmptyQuery(sessions, recentSessionIds, limit = PALETTE_EMPTY_SESSIONS_LIMIT) {
    const byId = new Map(sessions.map(s => [s.id, s]));
    const seen = new Set();
    const ordered = [];

    for (const id of recentSessionIds || []) {
      const s = byId.get(id);
      if (s && !seen.has(s.id)) { ordered.push(s); seen.add(s.id); }
    }
    for (const s of sessions) {
      if (!seen.has(s.id) && s.active) { ordered.push(s); seen.add(s.id); }
    }
    for (const s of sessions) {
      if (!seen.has(s.id)) { ordered.push(s); seen.add(s.id); }
    }
    return ordered.slice(0, limit);
  }

  // --- ranking / rebuilding -------------------------------------------------

  _rebuildItems() {
    const query = this._query.trim();
    const groups = new Map(PALETTE_GROUP_ORDER.map(name => [name, []]));

    const actions = this._collectActions();
    const sessionEntries = this._collectSessions();
    const projectEntries = this._collectProjects();
    const tabEntries = this._collectOpenTabs();
    const fileEntries = this._collectRecentFiles();

    if (!query) {
      groups.set('Actions', actions.slice(0, PALETTE_EMPTY_ACTIONS_LIMIT).map(a => ({ ...a, labelHtml: escapeHtml(a.label) })));

      const tabManager = this.container.get('tabManager');
      const recentIds = (typeof SessionRecents !== 'undefined')
        ? SessionRecents.list().map(r => r.id)
        : (tabManager?.getRecentSessionIds?.() || []);
      const rawSessions = Array.from(this.state.sessions.values()).filter(s => !this.state.isTaskRun(s.id));
      const orderedSessions = CommandPalette.orderSessionsForEmptyQuery(rawSessions, recentIds);
      const orderedIds = new Set(orderedSessions.map(s => s.id));
      groups.set('Sessions', sessionEntries
        .filter(e => orderedIds.has(e.session.id))
        .sort((a, b) => orderedSessions.findIndex(s => s.id === a.session.id) - orderedSessions.findIndex(s => s.id === b.session.id))
        .map(e => ({ ...e, labelHtml: escapeHtml(e.label) })));

      groups.set('Projects', projectEntries.map(e => ({ ...e, labelHtml: escapeHtml(e.label) })));
      groups.set('Open tabs', tabEntries.map(e => ({ ...e, labelHtml: escapeHtml(e.label) })));
      groups.set('Recent files', []);
    } else {
      const rank = (entries) => entries
        .map(e => ({ e, m: CommandPalette.matchItem(query, e.label, e.sub) }))
        .filter(x => x.m)
        .sort((a, b) => b.m.score - a.m.score)
        .slice(0, PALETTE_MAX_PER_GROUP)
        .map(x => ({ ...x.e, labelHtml: CommandPalette.highlightLabel(x.e.label, x.m.labelPositions) }));

      groups.set('Actions', rank(actions));
      groups.set('Sessions', rank(sessionEntries));
      groups.set('Projects', rank(projectEntries));
      groups.set('Open tabs', rank(tabEntries));
      groups.set('Recent files', rank(fileEntries));
    }

    this._groups = groups;
    this._items = [];
    for (const name of PALETTE_GROUP_ORDER) {
      const list = groups.get(name) || [];
      if (list.length === 0) continue;
      for (const item of list) this._items.push({ ...item, group: name });
    }
    this._selectedIndex = 0;
  }

  // --- rendering -------------------------------------------------------------

  _render() {
    const magnifier = '<svg class="palette__icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.5" y1="10.5" x2="14" y2="14"/></svg>';

    this._setContent(`
      <div class="palette__input-row">
        ${magnifier}
        <input class="palette__input" type="text" placeholder="Jump to a session, project, file or action…" data-testid="palette-input" autocomplete="off" spellcheck="false">
        <kbd class="palette__kbd">esc</kbd>
      </div>
      <div class="palette__list" role="listbox" data-testid="palette-list"></div>
      <div class="palette__footer"><kbd class="palette__kbd">↑↓</kbd> navigate <kbd class="palette__kbd">↵</kbd> open <kbd class="palette__kbd">esc</kbd> close</div>
    `);

    this._inputEl = this._panel.querySelector('.palette__input');
    this._listEl = this._panel.querySelector('.palette__list');

    this._inputEl.value = this._query;
    this._inputEl.addEventListener('input', () => {
      this._query = this._inputEl.value;
      this._rebuildItems();
      this._renderList();
    });
    this._inputEl.addEventListener('keydown', (e) => this._onInputKey(e));

    this._renderList();
  }

  _renderList() {
    this._listEl.innerHTML = '';
    this._rowEls = [];

    if (this._items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'palette__empty';
      empty.textContent = `No matches for “${this._query}”`;
      this._listEl.appendChild(empty);
      return;
    }

    let currentGroup = null;
    this._items.forEach((item, idx) => {
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        const section = document.createElement('div');
        section.className = 'palette__section';
        section.textContent = currentGroup;
        this._listEl.appendChild(section);
      }

      const row = document.createElement('div');
      row.className = 'palette__item';
      row.setAttribute('role', 'option');
      row.dataset.testid = 'palette-item';
      row.setAttribute('aria-selected', idx === this._selectedIndex ? 'true' : 'false');

      const iconWrap = document.createElement('span');
      iconWrap.className = 'palette__item-icon';
      if (item.iconMonogram) {
        iconWrap.innerHTML = `<span class="palette__monogram" style="--project-avatar-bg: ${item.iconMonogram.color}">${escapeHtml(item.iconMonogram.text)}</span>`;
      } else if (item.icon) {
        iconWrap.innerHTML = item.icon;
      }
      row.appendChild(iconWrap);

      const body = document.createElement('span');
      body.className = 'palette__item-body';
      const labelEl = document.createElement('span');
      labelEl.className = 'palette__item-label';
      labelEl.innerHTML = item.labelHtml || escapeHtml(item.label);
      body.appendChild(labelEl);
      if (item.sub || item.host) {
        const subEl = document.createElement('span');
        subEl.className = 'palette__item-sub';
        subEl.textContent = item.sub || '';
        const chip = item.host && typeof hostChip === 'function'
          ? hostChip(item.host, { size: 'sm', status: this.state.hostStatus?.(item.host.id) })
          : null;
        if (chip) subEl.appendChild(chip);
        body.appendChild(subEl);
      }
      row.appendChild(body);

      if (item.meta) {
        const metaEl = document.createElement('span');
        metaEl.className = 'palette__item-meta';
        if (item.meta.live) {
          const live = document.createElement('span');
          live.className = 'palette__live';
          live.title = 'Running';
          metaEl.appendChild(live);
        }
        if (item.meta.chip) {
          const chip = document.createElement('span');
          chip.className = 'palette__chip';
          chip.textContent = item.meta.chip;
          metaEl.appendChild(chip);
        }
        if (item.meta.kbd) {
          const kbd = document.createElement('kbd');
          kbd.className = 'palette__kbd';
          kbd.textContent = item.meta.kbd;
          metaEl.appendChild(kbd);
        }
        row.appendChild(metaEl);
      }

      row.addEventListener('mouseenter', () => this._setSelected(idx));
      row.addEventListener('click', () => this._runItem(item));

      this._listEl.appendChild(row);
      this._rowEls.push(row);
    });
  }

  _setSelected(idx) {
    if (idx < 0 || idx >= this._rowEls.length) return;
    this._selectedIndex = idx;
    this._rowEls.forEach((row, i) => row.setAttribute('aria-selected', i === idx ? 'true' : 'false'));
    this._rowEls[idx].scrollIntoView({ block: 'nearest' });
  }

  _runItem(item) {
    if (!item) return;
    try {
      item.run();
    } finally {
      this.hide();
    }
  }

  _onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this._rowEls.length === 0) return;
      this._setSelected((this._selectedIndex + 1) % this._rowEls.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this._rowEls.length === 0) return;
      this._setSelected((this._selectedIndex - 1 + this._rowEls.length) % this._rowEls.length);
    } else if (e.key === 'Home') {
      if (this._rowEls.length === 0) return;
      e.preventDefault();
      this._setSelected(0);
    } else if (e.key === 'End') {
      if (this._rowEls.length === 0) return;
      e.preventDefault();
      this._setSelected(this._rowEls.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = this._items[this._selectedIndex];
      if (item) this._runItem(item);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CommandPalette;
}
