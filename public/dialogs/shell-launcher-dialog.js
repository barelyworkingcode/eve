/**
 * ShellLauncherDialog - unified terminal/session launcher with New and Resume tabs.
 * Replaces separate session modal + terminal template picker.
 */
class ShellLauncherDialog extends DialogBase {
  constructor(container) {
    super(container, 'shell-launcher-dialog');
    this.state = container.get('state');
    this.projectId = null;
  }

  init() {
    this.bus.on(EVT.DIALOG_SHELL_LAUNCHER, (data) => {
      this.projectId = data.projectId;
      this.render();
      this.show();
    });

    this.bus.on(EVT.TERMINAL_TEMPLATES_LOADED, () => {
      if (this.isVisible) this._showTab('new');
    });
  }

  render() {
    const project = this.state.getProject(this.projectId);
    const projectName = project?.name || 'Unknown';

    this._panel.innerHTML = '';
    this._panel.style.maxWidth = '480px';

    this._panel.appendChild(this._createTitleBar('Shell Launcher', projectName));

    // Tabs
    const { header, setActiveTab } = this._createTabs(
      [{ name: 'new', label: 'New' }, { name: 'resume', label: 'Resume' }],
      (tab) => this._showTab(tab)
    );
    this._panel.appendChild(header);

    // Tab content container
    this._tabContent = document.createElement('div');
    this._tabContent.className = 'dialog__tab-content';
    this._panel.appendChild(this._tabContent);

    this._setActiveTab = setActiveTab;
    this._showTab('new');
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

    // Chat templates from project (rendered first, mixed into grid)
    const project = this.state.getProject(this.projectId);
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

      if (FAVORITE_TEMPLATE_ENABLED) {
        const settings = this.container.get('settings');
        const fav = settings.getFavoriteTemplate();
        const isFav = fav && fav.projectId === this.projectId && fav.templateId === tmpl.id;

        const star = document.createElement('span');
        star.className = 'shell-launcher__fav-btn' + (isFav ? ' shell-launcher__fav-btn--active' : '');
        star.title = isFav ? 'Remove as favorite' : 'Set as Action Button favorite';
        star.innerHTML = isFav
          ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
          : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
        star.addEventListener('click', (e) => {
          e.stopPropagation();
          this._toggleFavorite(this.projectId, tmpl.id);
        });
        card.appendChild(star);
      }

      grid.appendChild(card);
    }

    // Terminal templates come from relayLLM's config.json pty section, fetched
    // once on connect. If the response hasn't landed yet, show a placeholder;
    // EVT.TERMINAL_TEMPLATES_LOADED (init()) will re-render when it arrives.
    const templates = this.state.terminalTemplates;
    if (templates.length === 0) {
      const loading = document.createElement('div');
      loading.className = 'shell-launcher__empty';
      loading.textContent = 'Loading terminal templates…';
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
      onSubmit: (model, settings, voice, appendClaudeMd) => this._launchWebUI(model, settings, appendClaudeMd),
    });
  }

  _showVoiceChatForm() {
    this._showModelForm({
      buttonText: 'Start Voice Chat',
      showVoice: true,
      onSubmit: (model, settings, voice, appendClaudeMd) => this._launchVoiceChat(model, voice, settings, appendClaudeMd),
    });
  }

  /**
   * Shared form for Web Chat and Voice Chat — model select, optional voice select,
   * provider settings, and action buttons.
   */
  _showModelForm({ buttonText, showVoice, onSubmit }) {
    this._tabContent.innerHTML = '';

    const form = document.createElement('div');
    form.className = 'shell-launcher__web-form';

    // Model select
    const modelLabel = document.createElement('label');
    modelLabel.className = 'dialog__label';
    modelLabel.textContent = 'Model';
    const modelSelect = document.createElement('select');
    renderModelSelect(modelSelect, this.state.models, { className: 'dialog__select' });
    form.appendChild(modelLabel);
    form.appendChild(modelSelect);

    // Voice select (voice chat only)
    let voiceSelect = null;
    if (showVoice) {
      voiceSelect = this._createVoiceSelect();
      const voiceLabel = document.createElement('label');
      voiceLabel.className = 'dialog__label';
      voiceLabel.textContent = 'Voice';
      form.appendChild(voiceLabel);
      form.appendChild(voiceSelect);
    }

    // Append CLAUDE.md as an extra boolean field injected into provider settings
    const claudeMdExtra = {
      key: '_appendClaudeMd',
      label: 'Append CLAUDE.md',
      type: 'boolean',
      default: true,
      visibleWhen: (models, modelValue) => !isClaudeModel(models, modelValue),
    };
    const settingsContainer = this._addProviderSettings(
      form, modelSelect, { useRelayTools: true }, [claudeMdExtra]
    );

    // Action buttons
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
      const appendClaudeMd = settings?._appendClaudeMd || false;
      if (settings) delete settings._appendClaudeMd;
      onSubmit(model, settings, voiceSelect?.value, appendClaudeMd);
    });

    actions.appendChild(backBtn);
    actions.appendChild(startBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
  }

  _launchSession({ model, settings, systemPrompt, appendClaudeMd, voice, sessionType, nameSuffix }) {
    const project = this.state.getProject(this.projectId);
    const name = project ? `${project.name} - ${nameSuffix}` : nameSuffix;
    const msg = {
      type: 'create_session',
      projectId: this.projectId,
      model,
      settings: settings || null,
      name,
    };
    if (systemPrompt) msg.systemPrompt = systemPrompt;
    if (appendClaudeMd) msg.appendClaudeMd = true;
    if (sessionType === 'voice' || voice) {
      msg.sessionType = 'voice';
      msg.voice = voice || 'af_heart';
    }
    this.container.get('ws').send(msg);
    this.hide();
  }

  _launchFromTemplate(template) {
    const settings = { ...(template.settings || {}) };
    if (template.useRelayTools) settings.useRelayTools = true;
    this._launchSession({
      model: template.model,
      settings,
      systemPrompt: template.systemPrompt,
      appendClaudeMd: template.appendClaudeMd,
      voice: template.mode === 'voice' ? (template.voice || 'af_heart') : undefined,
      sessionType: template.mode === 'voice' ? 'voice' : undefined,
      nameSuffix: template.name,
    });
  }

  _toggleFavorite(projectId, templateId) {
    const settings = this.container.get('settings');
    const current = settings.getFavoriteTemplate();

    // Un-favorite if clicking the current favorite
    if (current && current.projectId === projectId && current.templateId === templateId) {
      settings.setFavoriteTemplate(null);
      this._showTab('new');
      return;
    }

    // Confirm replacement if a different favorite exists
    if (current) {
      const currentProject = this.state.getProject(current.projectId);
      const currentTemplate = currentProject?.chatTemplates?.find(t => t.id === current.templateId);
      const currentName = currentTemplate
        ? `"${currentTemplate.name}" (${currentProject.name})`
        : 'the current favorite';

      this.container.get('modalManager').showConfirmModal(
        `Replace ${currentName} as your Action Button favorite?`,
        () => {
          settings.setFavoriteTemplate({ projectId, templateId });
          this._showTab('new');
        }
      );
      return;
    }

    // No existing favorite — set directly
    settings.setFavoriteTemplate({ projectId, templateId });
    this._showTab('new');
  }

  _launchVoiceChat(model, voice, settings, appendClaudeMd) {
    const modelInfo = this.state.models.find(m => m.value === model);
    this._launchSession({
      model, settings, appendClaudeMd, voice,
      sessionType: 'voice',
      nameSuffix: `Voice - ${modelInfo?.label || model}`,
    });
  }

  _renderResumeTab() {
    const container = document.createElement('div');
    container.className = 'shell-launcher__resume';

    // LLM Sessions for this project
    const sessions = this.state.getSessionsForProject(this.projectId);
    if (sessions.length > 0) {
      const header = document.createElement('div');
      header.className = 'shell-launcher__section-title';
      header.textContent = 'Chat Sessions';
      container.appendChild(header);

      for (const session of sessions) {
        const item = document.createElement('div');
        item.className = 'shell-launcher__resume-item';

        const resumeBtn = document.createElement('button');
        resumeBtn.className = 'shell-launcher__resume-btn';

        const name = document.createElement('span');
        name.className = 'shell-launcher__resume-name';
        name.textContent = session.name || 'Unnamed';

        const badge = document.createElement('span');
        badge.className = 'shell-launcher__resume-badge';
        badge.textContent = session.model || '';

        resumeBtn.appendChild(name);
        resumeBtn.appendChild(badge);
        resumeBtn.addEventListener('click', () => {
          this.hide();
          this.container.get('app').joinSession(session.id);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'shell-launcher__resume-delete';
        deleteBtn.title = 'Delete session';
        deleteBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.container.get('app').deleteSession(session.id);
          // Re-render resume tab after a short delay for the delete to process
          setTimeout(() => this._showTab('resume'), 300);
        });

        item.appendChild(resumeBtn);
        item.appendChild(deleteBtn);
        container.appendChild(item);
      }
    }

    // Running terminals (we'd need terminal list - for now show a message)
    const termHeader = document.createElement('div');
    termHeader.className = 'shell-launcher__section-title';
    termHeader.textContent = 'Running Terminals';
    container.appendChild(termHeader);

    // Get terminals from terminal manager
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

    if (sessions.length === 0 && terminalCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'shell-launcher__empty';
      empty.textContent = 'No active sessions or terminals.';
      container.appendChild(empty);
    }

    this._tabContent.appendChild(container);
  }

  _launchTerminal(templateId) {
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
      cols: 80,
      rows: 24,
    });
    this.hide();
  }

  _launchWebUI(model, settings, appendClaudeMd) {
    const modelInfo = this.state.models.find(m => m.value === model);
    this._launchSession({
      model, settings, appendClaudeMd,
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
