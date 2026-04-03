/**
 * ShellLauncherDialog - unified terminal/session launcher with New and Resume tabs.
 * Replaces separate session modal + terminal template picker.
 */
class ShellLauncherDialog extends DialogBase {
  constructor(container) {
    super(container, 'shell-launcher-dialog');
    this.state = container.get('state');
    this.projectId = null;
    this._templates = [];
  }

  init() {
    this.bus.on(EVT.DIALOG_SHELL_LAUNCHER, (data) => {
      this.projectId = data.projectId;
      this.render();
      this.show();
    });

    this.bus.on(EVT.TERMINAL_TEMPLATES, (data) => {
      this._templates = data.templates || [];
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
      grid.appendChild(this._createCard({
        className: 'shell-launcher__card--template',
        iconHtml: isVoice
          ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>'
          : UI_ICONS.chat(20),
        name: tmpl.name,
        description: modelInfo?.label || tmpl.model || '',
        onClick: () => this._launchFromTemplate(tmpl),
      }));
    }

    // Terminal templates (Claude Code, OpenCode, Shell, custom)
    const templates = this._templates.length > 0 ? this._templates : [
      { id: 'claude-code', name: 'Claude Code', description: 'Claude Code CLI agent', icon: 'claude-code' },
      { id: 'opencode', name: 'OpenCode', description: 'OpenCode CLI agent', icon: 'terminal' },
      { id: 'shell', name: 'Shell', description: 'Default system shell', icon: 'shell' },
    ];

    for (const tmpl of templates) {
      grid.appendChild(this._createCard({
        iconHtml: this._iconSVG(tmpl.icon || tmpl.id),
        name: tmpl.name,
        description: tmpl.description || '',
        onClick: () => this._launchTerminal(tmpl.id),
      }));
    }

    grid.appendChild(this._createCard({
      className: 'shell-launcher__card--accent',
      iconHtml: '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3l-.5 5h-2L6.5 7z"/></svg>',
      name: 'Web Chat',
      description: 'LLM chat in browser',
      onClick: () => this._showWebUIForm(),
    }));

    grid.appendChild(this._createCard({
      className: 'shell-launcher__card--accent',
      iconHtml: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>',
      name: 'Voice Chat',
      description: 'Hands-free voice conversation',
      onClick: () => this._showVoiceChatForm(),
    }));

    this._tabContent.appendChild(grid);
  }

  _createCard({ className, iconHtml, name, description, onClick }) {
    const card = document.createElement('button');
    card.className = `shell-launcher__card${className ? ' ' + className : ''}`;
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

    const settingsContainer = this._addProviderSettings(form, modelSelect);

    // Append CLAUDE.md checkbox (non-Claude models only)
    const claudeMdWrapper = document.createElement('div');
    claudeMdWrapper.className = 'shell-launcher__claudemd-row';
    const claudeMdCheck = document.createElement('input');
    claudeMdCheck.type = 'checkbox';
    claudeMdCheck.id = 'launcher-append-claudemd';
    const claudeMdLabel = document.createElement('label');
    claudeMdLabel.htmlFor = 'launcher-append-claudemd';
    claudeMdLabel.textContent = 'Append CLAUDE.md';
    claudeMdWrapper.appendChild(claudeMdCheck);
    claudeMdWrapper.appendChild(claudeMdLabel);
    form.appendChild(claudeMdWrapper);

    const updateClaudeMdVisibility = () => {
      const selectedModel = this.state.models.find(m => m.value === modelSelect.value);
      const isClaude = selectedModel?.provider === 'claude';
      claudeMdWrapper.style.display = isClaude ? 'none' : '';
    };
    modelSelect.addEventListener('change', updateClaudeMdVisibility);
    updateClaudeMdVisibility();

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
      onSubmit(model, settings, voiceSelect?.value, claudeMdCheck.checked);
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
    this._launchSession({
      model: template.model,
      settings: template.settings,
      systemPrompt: template.systemPrompt,
      appendClaudeMd: template.appendClaudeMd,
      voice: template.mode === 'voice' ? (template.voice || 'af_heart') : undefined,
      sessionType: template.mode === 'voice' ? 'voice' : undefined,
      nameSuffix: template.name,
    });
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
    const tmpl = this._templates.find(t => t.id === templateId);
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
