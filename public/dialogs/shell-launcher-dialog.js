const HISTORY_REASONS = {
  live: 'Still running',
  held: 'Open in another terminal',
  no_conversation: 'No conversation yet',
  transcript_absent: 'Its transcript is gone',
  no_project: 'Not in this project\'s folders',
  host_unsupported: 'On a host: resume it there',
  kind: 'Can\'t be resumed here',
};

class ShellLauncherDialog extends DialogBase {
  constructor(container) {
    super(container, 'shell-launcher-dialog');
    this.state = container.get('state');
    this.projectId = null;
    this._ptyLoadingPlaceholder = null;
  }

  init() {
    this.bus.on(EVT.DIALOG_SHELL_LAUNCHER, (data) => {
      this.projectId = data.projectId;
      this.render();
      this.show();
      this._applyIntent(data.intent);
    });

    this.bus.on(EVT.SESSION_HISTORY_LOADED, (d) => {
      if (d.projectId !== this.projectId || !this._historyEl?.isConnected) return;
      this._history = d.error ? { status: 'error' } : { status: 'ok', rows: d.rows || [] };
      this._paintHistory();
    });
    this.bus.on(EVT.SESSION_HISTORY_ERROR, (d) => {
      this.bus.emit(EVT.TOAST_SHOW, {
        id: `history-resume-${d.id}`, type: 'error', duration: 8000,
        message: `Can't resume: ${String(d.error || d.code || 'unknown').replace(/\s+/g, ' ').trim()}`,
      });
      if (d.id === this._resumingId) this._resumingId = null;
      this._paintHistory();
    });
    // The dialog stays open until relay's terminal exists, so a refusal can
    // show its toast over a button that comes back. Relay's 201 names the row
    // it supersedes, which ties the frame to this tap and not to a terminal
    // some other path added meanwhile.
    this.bus.on(EVT.TERMINAL_CREATED, (d) => {
      if (!this._resumingId || d.supersedes !== this._resumingId) return;
      this._resumedTerminalId = d.terminalId;
      this._finishResume();
    });
    // The manager sets a terminal up later when xterm is still loading.
    this.bus.on(EVT.TERMINAL_LIST, () => this._finishResume());
    this.bus.on(EVT.WS_DISCONNECTED, () => {
      if (!this._resumingId) return;
      this._resumingId = null;
      this._resumedTerminalId = null;
      this._paintHistory();
    });

    // A targeted DOM patch, not a full _showTab('new') re-render: this used
    // to be safe only because the WS terminal_templates round trip it was
    // originally written against never actually resolved (relay-sessions
    // never mounted a handler for it), so this listener effectively never
    // fired against a dialog a user was already interacting with. Now that
    // the real fetch (terminal-manager.js's requestTemplates, over HTTP)
    // actually completes, a blind _showTab('new') would wipe and rebuild
    // the whole tab — including the always-present Web Chat/Voice Chat
    // cards that have nothing to do with pty templates — out from under a
    // click already in flight. Replacing only the loading placeholder, in
    // place, is what keeps a fast template fetch from ever detaching an
    // element the user is mid-click on.
    this.bus.on(EVT.TERMINAL_TEMPLATES_LOADED, () => {
      if (!this.isVisible) return;
      const placeholder = this._ptyLoadingPlaceholder;
      if (!placeholder || !placeholder.isConnected) return; // nothing waiting, or the tab has since been rebuilt
      if (this.state.terminalTemplatesProjectId !== this.projectId) return; // a list for another project
      this._ptyLoadingPlaceholder = null;
      const grid = placeholder.parentNode;
      if (!grid) return;
      for (const tmpl of this.state.terminalTemplates) {
        grid.insertBefore(this._createCard({
          iconHtml: this._iconSVG(tmpl.icon || tmpl.id),
          name: tmpl.name,
          description: tmpl.description || '',
          onClick: () => this._launchTerminal(tmpl.id),
          testid: `shell-card-${tmpl.id}`,
        }), placeholder);
      }
      placeholder.remove();
    });
  }

  render() {
    const project = this.state.getProject(this.projectId);
    const projectName = project?.name || 'Unknown';

    this._panel.innerHTML = '';
    this._panel.style.maxWidth = '480px';

    this._panel.appendChild(this._createTitleBar('Shell Launcher', projectName));

    const { header, setActiveTab } = this._createTabs(
      [{ name: 'new', label: 'New' }, { name: 'resume', label: 'Resume' }],
      (tab) => this._showTab(tab)
    );
    this._panel.appendChild(header);

    this._tabContent = document.createElement('div');
    this._tabContent.className = 'dialog__tab-content';
    this._panel.appendChild(this._tabContent);

    this._setActiveTab = setActiveTab;
    this._showTab('new');
  }

  // Home-screen tiles open the launcher already pointed at one card, so a
  // "Chat" tile is one click to the model form rather than two.
  _applyIntent(intent) {
    if (!intent) return;
    if (intent === 'web-chat') return this._showWebUIForm();
    if (intent === 'voice-chat') return this._showVoiceChatForm();
    if (intent.startsWith('terminal:')) return this._launchTerminal(intent.slice('terminal:'.length));
  }

  _showTab(tabName) {
    this._tabContent.innerHTML = '';
    if (tabName === 'new') {
      this._renderNewTab();
    } else {
      this._renderResumeTab();
    }
  }

  _renderNewTab() {
    const grid = document.createElement('div');
    grid.className = 'shell-launcher__grid';
    // Reset on every fresh render — a stale reference from a previous open
    // of this dialog must never be patched by a load that resolves late.
    this._ptyLoadingPlaceholder = null;

    const project = this.state.getProject(this.projectId);
    if (project?.host && typeof hostChip === 'function') {
      const note = document.createElement('div');
      note.className = 'shell-launcher__host-note';
      const chip = hostChip(project.host, { status: this.state.hostStatus?.(project.host.id) });
      if (chip) note.appendChild(chip);
      const text = document.createElement('span');
      text.textContent = `Sessions and terminals open on ${project.host.name}.`;
      note.appendChild(text);
      this._tabContent.appendChild(note);
      this._tabContent.appendChild(this._createRemoteSessions());
    }
    const chatTemplates = project?.chatTemplates || [];
    for (const tmpl of chatTemplates) {
      const isVoice = tmpl.mode === 'voice';
      const modelInfo = this.state.models.find(m => m.value === tmpl.model);
      const card = this._createCard({
        className: 'shell-launcher__card--template',
        iconHtml: isVoice
          ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
          : UI_ICONS.chat(20),
        name: tmpl.name,
        description: modelInfo?.label || tmpl.model || '',
        onClick: () => this._launchFromTemplate(tmpl),
        testid: `shell-card-template-${tmpl.id}`,
      });

      grid.appendChild(card);
    }

    // Terminal templates are per project: fetch on open unless the cache is
    // already this project's. A loaded-but-empty list is a project that may
    // launch none, not a fetch still waiting.
    const loaded = this.state.terminalTemplatesProjectId === this.projectId;
    const templates = loaded ? this.state.terminalTemplates : [];
    if (!loaded) {
      const termMgr = this.container.has('terminalManager') ? this.container.get('terminalManager') : null;
      if (termMgr) termMgr.requestTemplates(this.projectId);

      const loading = document.createElement('div');
      loading.className = 'shell-launcher__empty';
      loading.textContent = 'Loading terminal templates…';
      this._ptyLoadingPlaceholder = loading;
      grid.appendChild(loading);
    } else {
      for (const tmpl of templates) {
        grid.appendChild(this._createCard({
          iconHtml: this._iconSVG(tmpl.icon || tmpl.id),
          name: tmpl.name,
          description: tmpl.description || '',
          onClick: () => this._launchTerminal(tmpl.id),
          testid: `shell-card-${tmpl.id}`,
        }));
      }
    }

    grid.appendChild(this._createCard({
      className: 'shell-launcher__card--accent',
      iconHtml: '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3l-.5 5h-2L6.5 7z"/></svg>',
      name: 'Web Chat',
      description: 'LLM chat in browser',
      onClick: () => this._showWebUIForm(),
      testid: 'shell-card-web-chat',
    }));

    grid.appendChild(this._createCard({
      className: 'shell-launcher__card--accent',
      iconHtml: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
      name: 'Voice Chat',
      description: 'Hands-free voice conversation',
      onClick: () => this._showVoiceChatForm(),
      testid: 'shell-card-voice-chat',
    }));

    this._tabContent.appendChild(grid);
  }

  _createCard({ className, iconHtml, name, description, onClick, testid }) {
    const card = document.createElement('button');
    card.className = `shell-launcher__card${className ? ' ' + className : ''}`;
    if (testid) card.dataset.testid = testid;
    card.setAttribute('aria-label', name);
    card.addEventListener('click', onClick);

    const icon = document.createElement('span');
    icon.className = 'shell-launcher__card-icon';
    icon.innerHTML = iconHtml;

    const info = document.createElement('div');
    info.className = 'shell-launcher__card-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'shell-launcher__card-name';
    nameEl.textContent = name;
    const descEl = document.createElement('div');
    descEl.className = 'shell-launcher__card-desc';
    descEl.textContent = description;
    info.appendChild(nameEl);
    info.appendChild(descEl);

    card.appendChild(icon);
    card.appendChild(info);
    return card;
  }

  _showWebUIForm() {
    this._showModelForm({
      buttonText: 'Start Chat',
      onSubmit: (model, settings) => this._launchWebUI(model, settings),
    });
  }

  _showVoiceChatForm() {
    this._showModelForm({
      buttonText: 'Start Voice Chat',
      showVoice: true,
      onSubmit: (model, settings, voice) => this._launchVoiceChat(model, voice, settings),
    });
  }

  _showModelForm({ buttonText, showVoice, onSubmit }) {
    this._tabContent.innerHTML = '';

    const form = document.createElement('div');
    form.className = 'shell-launcher__web-form';

    const modelLabel = document.createElement('label');
    modelLabel.className = 'dialog__label';
    modelLabel.textContent = 'Model';
    const modelSelect = document.createElement('select');
    modelSelect.dataset.testid = 'launcher-model-select';
    modelSelect.setAttribute('aria-label', 'Model');
    // pi runs as a process in the project directory and can't be launched on a
    // host, so it isn't offered there.
    const onHost = !!this.state.getProject(this.projectId)?.host;
    const models = this.state.modelsForProject(this.projectId)
      .filter(m => !(onHost && String(m.value || '').startsWith('pi/')));
    renderModelSelect(modelSelect, models, { className: 'dialog__select' });
    form.appendChild(modelLabel);
    form.appendChild(modelSelect);

    let voiceSelect = null;
    if (showVoice) {
      voiceSelect = this._createVoiceSelect();
      voiceSelect.setAttribute('aria-label', 'Voice');
      const voiceLabel = document.createElement('label');
      voiceLabel.className = 'dialog__label';
      voiceLabel.textContent = 'Voice';
      form.appendChild(voiceLabel);
      form.appendChild(voiceSelect);
    }

    const settingsContainer = this._addProviderSettings(form, modelSelect);

    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    const backBtn = document.createElement('button');
    backBtn.className = 'dialog__btn dialog__btn--secondary';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => this._showTab('new'));

    const startBtn = document.createElement('button');
    startBtn.className = 'dialog__btn dialog__btn--primary';
    startBtn.textContent = buttonText;
    startBtn.addEventListener('click', () => {
      const model = modelSelect.value;
      const settings = this._collectSettings(settingsContainer);
      onSubmit(model, settings, voiceSelect?.value);
    });

    actions.appendChild(backBtn);
    actions.appendChild(startBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
  }

  _launchSession({ model, settings, systemPrompt, voice, sessionType, nameSuffix }) {
    if (!(model || '').trim()) {
      this.bus.emit(EVT.TOAST_SHOW, {
        id: 'launch-no-model',
        type: 'error',
        duration: 5000,
        message: `Pick a model for "${nameSuffix}" before starting a chat.`,
      });
      return;
    }
    const project = this.state.getProject(this.projectId);
    const name = project ? `${project.name} - ${nameSuffix}` : nameSuffix;
    let msg = {
      type: 'create_session',
      projectId: this.projectId,
      model,
      settings: settings || null,
      name,
    };
    if (systemPrompt) msg.systemPrompt = systemPrompt;
    if (sessionType === 'voice' || voice) {
      msg.sessionType = 'voice';
      msg.voice = voice || 'af_heart';
      // A voice launch opens its chat in Hands-free; session_created claims this.
      this.container.get('voiceModes').requestHandsFreeForNextLaunch();
    }
    msg = applyChatDefaults(msg, this.state.models);
    this.container.get('app').showSessionStarting();
    this.container.get('ws').send(msg);
    this.hide();
  }

  launchTemplate(projectId, template) {
    this.projectId = projectId;
    this._launchFromTemplate(template);
  }

  _launchFromTemplate(template) {
    this._launchSession({
      model: template.model,
      systemPrompt: template.systemPrompt,
      voice: template.mode === 'voice' ? (template.voice || 'af_heart') : undefined,
      sessionType: template.mode === 'voice' ? 'voice' : undefined,
      nameSuffix: template.name,
    });
  }

  _launchVoiceChat(model, voice, settings) {
    const modelInfo = this.state.models.find(m => m.value === model);
    this._launchSession({
      model, settings, voice,
      sessionType: 'voice',
      nameSuffix: `Voice - ${modelInfo?.label || model}`,
    });
  }

  _renderResumeTab() {
    const container = document.createElement('div');
    container.className = 'shell-launcher__resume';

    this._history = { status: 'loading' };
    this._historyEl = document.createElement('div');
    container.appendChild(this._historyEl);
    this.container.get('ws').send({ type: 'session_history_list', projectId: this.projectId });

    const termHeader = document.createElement('div');
    termHeader.className = 'shell-launcher__section-title';
    termHeader.setAttribute('role', 'heading');
    termHeader.setAttribute('aria-level', '4');
    termHeader.textContent = 'Running Terminals';
    container.appendChild(termHeader);

    const termMgr = this.container.has('terminalManager') ? this.container.get('terminalManager') : null;
    const terminalMap = termMgr?.terminals;
    let terminalCount = 0;
    if (terminalMap) {
      for (const [tid, t] of terminalMap) {
        if (t.exited) continue;
        terminalCount++;
        const item = document.createElement('button');
        item.className = 'shell-launcher__resume-item';

        const name = document.createElement('span');
        name.className = 'shell-launcher__resume-name';
        name.textContent = t.name || t.templateId || 'Terminal';

        const badge = document.createElement('span');
        badge.className = `shell-launcher__resume-badge shell-launcher__resume-badge--running`;
        badge.textContent = 'running';

        item.appendChild(name);
        item.appendChild(badge);
        item.addEventListener('click', () => {
          this.hide();
          this.container.get('tabManager').switchToTab(tid);
        });
        container.appendChild(item);
      }
    }

    this._terminalCount = terminalCount;
    this._emptyEl = document.createElement('div');
    this._emptyEl.className = 'shell-launcher__empty';
    this._emptyEl.textContent = 'No active sessions or terminals.';
    this._emptyEl.hidden = true;
    container.appendChild(this._emptyEl);
    this._paintHistory();

    this._tabContent.appendChild(container);
  }

  _finishResume() {
    const id = this._resumedTerminalId;
    const tabManager = this.container.get('tabManager');
    const tab = id && tabManager.tabs.find((t) => t.id === id);
    if (!tab) return;
    this._resumingId = null;
    this._resumedTerminalId = null;
    // Deliberate: the tab strip shows only the active project's tabs, and
    // relay's 201 need not name the project or a directory eve can match
    // to one. The launcher knows which project the person resumed in.
    if (!tab.projectId) tab.projectId = this.projectId;
    this.hide();
    tabManager.switchToTab(id);
  }

  _sectionTitle(text) {
    const header = document.createElement('div');
    header.className = 'shell-launcher__section-title';
    header.setAttribute('role', 'heading');
    header.setAttribute('aria-level', '4');
    header.textContent = text;
    return header;
  }

  // Paints the History block for the state the last frame left. Every string
  // from relay goes in through textContent: a title is untrusted text.
  _paintHistory() {
    const el = this._historyEl;
    if (!el || !el.isConnected) return;
    el.replaceChildren();
    const sessions = this.state.getSessionsForProject(this.projectId);
    let shown = 0;
    if (this._history.status === 'loading') {
      el.appendChild(this._noteLine('Loading history…'));
    } else if (this._history.status === 'error') {
      el.appendChild(this._noteLine('History unavailable'));
      shown = this._renderChatSessions(el, sessions);
    } else {
      // A live terminal shows under "Running Terminals", from the terminal list.
      const rows = this._history.rows.filter((r) => !(r.kind === 'terminal' && (r.state === 'live' || r.resumeReason === 'live')));
      if (rows.length > 0) {
        el.appendChild(this._sectionTitle('History'));
        for (const row of rows) el.appendChild(this._historyRow(row));
      }
      shown = rows.length;
    }
    if (this._emptyEl) this._emptyEl.hidden = this._history.status === 'loading' || shown > 0 || this._terminalCount > 0;
  }

  _noteLine(text) {
    const note = document.createElement('div');
    note.className = 'shell-launcher__history-note';
    note.textContent = text;
    return note;
  }

  _historyRow(row) {
    const session = row.resume === 'session' ? this.state.sessions.get(row.id) : null;
    const project = this.state.getProject(this.projectId);
    const folder = String(row.directory || '').split('/').filter(Boolean).pop() || project?.name || '';
    const title = (row.title || '').trim()
      || (session ? sessionDisplayName(session, project) : '')
      || `Claude — ${folder}`;
    const badge = row.record === 'discovered' ? 'Found'
      : row.kind === 'terminal' ? 'Terminal'
      : ['claude', 'pi', 'codex'].includes(row.kind) ? 'Agent' : 'Chat';

    const item = document.createElement('div');
    item.className = 'shell-launcher__resume-item shell-launcher__history-row';
    item.dataset.historyId = row.id;

    const text = document.createElement('div');
    text.className = 'shell-launcher__history-text';
    const name = document.createElement('span');
    name.className = 'shell-launcher__resume-name';
    name.textContent = title;
    const meta = document.createElement('span');
    meta.className = 'shell-launcher__history-meta';
    const when = relativeTime(row.lastActiveAt || row.createdAt);
    meta.textContent = /^\d+[mhdw]$/.test(when) ? `${when} ago` : when;
    text.append(name, meta);
    if (row.resume === 'none') {
      const reason = document.createElement('span');
      reason.className = 'shell-launcher__history-reason';
      reason.textContent = HISTORY_REASONS[row.resumeReason] || HISTORY_REASONS.kind;
      text.appendChild(reason);
    }

    const pill = document.createElement('span');
    pill.className = 'shell-launcher__resume-badge';
    pill.textContent = badge;
    item.append(text, pill);

    if (row.resume === 'history' || row.resume === 'session') {
      const btn = document.createElement('button');
      btn.className = 'shell-launcher__history-resume';
      btn.setAttribute('aria-label', `Resume ${title}`);
      const pending = this._resumingId === row.id;
      btn.textContent = pending ? 'Resuming…' : 'Resume';
      btn.disabled = pending;
      btn.addEventListener('click', () => {
        if (row.resume === 'session') {
          this.hide();
          this.container.get('app').joinSession(row.id);
          return;
        }
        this._resumingId = row.id;
        btn.textContent = 'Resuming…';
        btn.disabled = true;
        // Only the row id and the size: relay owns everything else.
        this.container.get('ws').send({ type: 'session_history_resume', id: row.id, cols: 80, rows: 24 });
      });
      item.appendChild(btn);
    }
    if (row.resume === 'session') {
      item.appendChild(this._deleteButton(row.id, title));
    }
    return item;
  }

  _deleteButton(id, name) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'shell-launcher__resume-delete';
    deleteBtn.title = 'Delete session';
    deleteBtn.setAttribute('aria-label', `Delete session ${name}`);
    deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.container.get('app').deleteSession(id);
      // Delete is async (round-trips through relay); re-rendering
      // immediately would still show the deleted session.
      setTimeout(() => this._showTab('resume'), 300);
    });
    return deleteBtn;
  }

  // The list the tab showed before relay's history: used when history does not answer.
  _renderChatSessions(parent, sessions) {
    if (sessions.length === 0) return 0;
    parent.appendChild(this._sectionTitle('Chat Sessions'));
    for (const session of sessions) {
      const item = document.createElement('div');
      item.className = 'shell-launcher__resume-item';

      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'shell-launcher__resume-btn';
      resumeBtn.setAttribute('aria-label', session.name || 'Unnamed');

      const name = document.createElement('span');
      name.className = 'shell-launcher__resume-name';
      name.textContent = session.name || 'Unnamed';

      const badge = document.createElement('span');
      badge.className = 'shell-launcher__resume-badge';
      badge.textContent = session.model || '';

      resumeBtn.append(name, badge);
      resumeBtn.addEventListener('click', () => {
        this.hide();
        this.container.get('app').joinSession(session.id);
      });
      item.append(resumeBtn, this._deleteButton(session.id, session.name || 'Unnamed'));
      parent.appendChild(item);
    }
    return sessions.length;
  }

  _createRemoteSessions() {
    const section = new RemoteSessionsSection({
      api: this.container.get('api'),
      bus: this.bus,
      state: this.state,
      modalManager: this.container.get('modalManager'),
      projectId: this.projectId,
      onReattach: (s) => this._launchTerminal(s.template_id, s.name),
    });
    section.refresh();
    return section.el;
  }

  // persistSession names an existing tmux session on the project's host to
  // reattach to instead of starting a fresh one.
  _launchTerminal(templateId, persistSession) {
    const project = this.state.getProject(this.projectId);
    const tmpl = this.state.terminalTemplates.find(t => t.id === templateId);
    const tmplName = tmpl?.name || templateId;
    const name = project ? `${project.name} - ${tmplName}` : tmplName;
    const ws = this.container.get('ws');
    ws.send({
      type: 'terminal_create',
      templateId,
      name,
      directory: project?.path || '',
      // projectId lets relay resolve a project-scoped token for the PTY. eve
      // never sends the token itself — relay brokers it.
      projectId: this.projectId || '',
      ...(persistSession ? { persistSession } : {}),
      cols: 80,
      rows: 24,
    });
    this.hide();
  }

  _launchWebUI(model, settings) {
    const modelInfo = this.state.models.find(m => m.value === model);
    this._launchSession({
      model, settings,
      nameSuffix: modelInfo?.label || model,
    });
  }

  _iconSVG(id) {
    switch (id) {
      case 'claude-code': return UI_ICONS.chat(20);
      case 'shell': return UI_ICONS.shell(20);
      default: return UI_ICONS.terminal(20);
    }
  }
}
