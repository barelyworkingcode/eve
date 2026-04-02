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
      onSubmit(model, settings, voiceSelect?.value);
    });

    actions.appendChild(backBtn);
    actions.appendChild(startBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
  }

  _createVoiceSelect() {
    const select = document.createElement('select');
    select.className = 'dialog__select';

    const ttsManager = this.container.has('ttsManager') ? this.container.get('ttsManager') : null;
    const voices = ttsManager?.voices || [];
    if (voices.length > 0) {
      const groups = {};
      for (const v of voices) {
        const lang = v.language || 'Other';
        if (!groups[lang]) groups[lang] = [];
        groups[lang].push(v);
      }
      for (const [lang, list] of Object.entries(groups)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = lang;
        for (const v of list) {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = v.name;
          if (v.id === (ttsManager?.voice || 'af_heart')) opt.selected = true;
          optgroup.appendChild(opt);
        }
        select.appendChild(optgroup);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = 'af_heart';
      opt.textContent = 'Heart (F)';
      select.appendChild(opt);
    }
    return select;
  }

  _launchVoiceChat(model, voice, settings) {
    const project = this.state.getProject(this.projectId);
    const modelInfo = this.state.models.find(m => m.value === model);
    const modelLabel = modelInfo?.label || model;
    const name = project ? `${project.name} - Voice` : `Voice - ${modelLabel}`;
    const ws = this.container.get('ws');
    ws.send({
      type: 'create_session',
      projectId: this.projectId,
      model,
      settings,
      name,
      sessionType: 'voice',
      voice,
    });
    this.hide();
  }

  _addProviderSettings(form, modelSelect) {
    const settingsContainer = document.createElement('div');
    settingsContainer.className = 'shell-launcher__settings';
    form.appendChild(settingsContainer);

    const renderSettings = () => {
      settingsContainer.innerHTML = '';
      const selectedModel = this.state.models.find(m => m.value === modelSelect.value);
      if (!selectedModel) return;
      const fields = this.state.providerSettings[selectedModel.provider] || [];
      for (const field of fields) {
        const row = document.createElement('div');
        row.className = 'shell-launcher__setting-row';
        const lbl = document.createElement('label');
        lbl.className = 'dialog__label';
        lbl.textContent = field.label || field.name;
        row.appendChild(lbl);

        if (field.type === 'boolean') {
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.name = field.key;
          if (field.default) input.checked = true;
          row.appendChild(input);
        } else if (field.type === 'number') {
          const input = document.createElement('input');
          input.type = 'number';
          input.name = field.key;
          if (field.default !== undefined) input.value = field.default;
          if (field.min !== undefined) input.min = field.min;
          if (field.max !== undefined) input.max = field.max;
          input.step = field.step || 'any';
          if (field.placeholder) input.placeholder = field.placeholder;
          input.className = 'dialog__input';
          row.appendChild(input);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.name = field.key;
          input.dataset.settingType = field.type;
          if (field.default !== undefined) input.value = field.default;
          if (field.placeholder) input.placeholder = field.placeholder;
          input.className = 'dialog__input';
          row.appendChild(input);
        }
        settingsContainer.appendChild(row);
      }
    };

    modelSelect.addEventListener('change', renderSettings);
    renderSettings();
    return settingsContainer;
  }

  _collectSettings(container) {
    const settings = {};
    for (const input of container.querySelectorAll('input, select')) {
      if (!input.name) continue;
      if (input.type === 'checkbox') {
        settings[input.name] = input.checked;
      } else if (input.type === 'number' && input.value) {
        settings[input.name] = parseFloat(input.value);
      } else if (input.dataset.settingType === 'string[]') {
        const val = input.value.trim();
        if (val) settings[input.name] = val.split(/\s+/);
      } else if (input.value) {
        settings[input.name] = input.value;
      }
    }
    return Object.keys(settings).length > 0 ? settings : null;
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
          app.tabManager.switchToTab(tid);
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

  _launchWebUI(model, settings) {
    const project = this.state.getProject(this.projectId);
    const modelInfo = this.state.models.find(m => m.value === model);
    const modelLabel = modelInfo?.label || model;
    const name = project ? `${project.name} - ${modelLabel}` : modelLabel;
    const ws = this.container.get('ws');
    ws.send({
      type: 'create_session',
      projectId: this.projectId,
      model,
      settings,
      name,
    });
    this.hide();
  }

  _iconSVG(id) {
    switch (id) {
      case 'claude-code': return UI_ICONS.chat(20);
      case 'shell': return UI_ICONS.shell(20);
      default: return UI_ICONS.terminal(20);
    }
  }
}
