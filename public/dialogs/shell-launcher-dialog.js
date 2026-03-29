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

    // Header with project name
    const titleBar = document.createElement('div');
    titleBar.className = 'dialog__title-bar';

    const title = document.createElement('h3');
    title.className = 'dialog__title';
    title.textContent = 'Shell Launcher';

    const projectBadge = document.createElement('span');
    projectBadge.className = 'dialog__badge';
    projectBadge.textContent = projectName;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialog__close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.hide());

    titleBar.appendChild(title);
    titleBar.appendChild(projectBadge);
    titleBar.appendChild(closeBtn);
    this._panel.appendChild(titleBar);

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
      const card = document.createElement('button');
      card.className = 'shell-launcher__card';
      card.addEventListener('click', () => this._launchTerminal(tmpl.id));

      const icon = document.createElement('span');
      icon.className = 'shell-launcher__card-icon';
      icon.innerHTML = this._iconSVG(tmpl.icon || tmpl.id);

      const info = document.createElement('div');
      info.className = 'shell-launcher__card-info';
      const name = document.createElement('div');
      name.className = 'shell-launcher__card-name';
      name.textContent = tmpl.name;
      const desc = document.createElement('div');
      desc.className = 'shell-launcher__card-desc';
      desc.textContent = tmpl.description || '';
      info.appendChild(name);
      info.appendChild(desc);

      card.appendChild(icon);
      card.appendChild(info);
      grid.appendChild(card);
    }

    // Web UI card (LLM chat session)
    const webCard = document.createElement('button');
    webCard.className = 'shell-launcher__card shell-launcher__card--accent';
    webCard.addEventListener('click', () => this._showWebUIForm());

    const webIcon = document.createElement('span');
    webIcon.className = 'shell-launcher__card-icon';
    webIcon.innerHTML = '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3l-.5 5h-2L6.5 7z"/></svg>';

    const webInfo = document.createElement('div');
    webInfo.className = 'shell-launcher__card-info';
    const webName = document.createElement('div');
    webName.className = 'shell-launcher__card-name';
    webName.textContent = 'Web Chat';
    const webDesc = document.createElement('div');
    webDesc.className = 'shell-launcher__card-desc';
    webDesc.textContent = 'LLM chat in browser';
    webInfo.appendChild(webName);
    webInfo.appendChild(webDesc);

    webCard.appendChild(webIcon);
    webCard.appendChild(webInfo);
    grid.appendChild(webCard);

    this._tabContent.appendChild(grid);
  }

  _showWebUIForm() {
    this._tabContent.innerHTML = '';

    const form = document.createElement('div');
    form.className = 'shell-launcher__web-form';

    // Model select
    const modelLabel = document.createElement('label');
    modelLabel.className = 'dialog__label';
    modelLabel.textContent = 'Model';

    const modelSelect = document.createElement('select');
    modelSelect.className = 'dialog__select';

    const groups = {};
    for (const m of this.state.models) {
      const group = m.group || m.provider || 'Other';
      if (!groups[group]) groups[group] = [];
      groups[group].push(m);
    }
    for (const [groupName, models] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupName;
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label;
        optgroup.appendChild(opt);
      }
      modelSelect.appendChild(optgroup);
    }

    form.appendChild(modelLabel);
    form.appendChild(modelSelect);

    // Provider settings container
    const settingsContainer = document.createElement('div');
    settingsContainer.className = 'shell-launcher__settings';
    form.appendChild(settingsContainer);

    // Render provider settings for selected model
    const renderSettings = () => {
      settingsContainer.innerHTML = '';
      const selectedModel = this.state.models.find(m => m.value === modelSelect.value);
      if (!selectedModel) return;
      const provider = selectedModel.provider;
      const fields = this.state.providerSettings[provider] || [];
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
          input.name = field.name;
          if (field.default) input.checked = true;
          row.appendChild(input);
        } else if (field.type === 'number') {
          const input = document.createElement('input');
          input.type = 'number';
          input.name = field.name;
          if (field.default !== undefined) input.value = field.default;
          if (field.min !== undefined) input.min = field.min;
          if (field.max !== undefined) input.max = field.max;
          input.step = field.step || 'any';
          input.className = 'dialog__input';
          row.appendChild(input);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.name = field.name;
          if (field.default !== undefined) input.value = field.default;
          input.className = 'dialog__input';
          row.appendChild(input);
        }
        settingsContainer.appendChild(row);
      }
    };

    modelSelect.addEventListener('change', renderSettings);
    renderSettings();

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    const backBtn = document.createElement('button');
    backBtn.className = 'dialog__btn dialog__btn--secondary';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => this._showTab('new'));

    const startBtn = document.createElement('button');
    startBtn.className = 'dialog__btn dialog__btn--primary';
    startBtn.textContent = 'Start Chat';
    startBtn.addEventListener('click', () => {
      const model = modelSelect.value;
      const settings = this._collectSettings(settingsContainer);
      this._launchWebUI(model, settings);
    });

    actions.appendChild(backBtn);
    actions.appendChild(startBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
  }

  _collectSettings(container) {
    const settings = {};
    for (const input of container.querySelectorAll('input, select')) {
      if (!input.name) continue;
      if (input.type === 'checkbox') {
        settings[input.name] = input.checked;
      } else if (input.type === 'number' && input.value) {
        settings[input.name] = parseFloat(input.value);
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
        const item = document.createElement('button');
        item.className = 'shell-launcher__resume-item';

        const name = document.createElement('span');
        name.className = 'shell-launcher__resume-name';
        name.textContent = session.name || 'Unnamed';

        const badge = document.createElement('span');
        badge.className = 'shell-launcher__resume-badge';
        badge.textContent = session.model || '';

        item.appendChild(name);
        item.appendChild(badge);
        item.addEventListener('click', () => {
          this.hide();
          // Join session via existing mechanism
          const app = this.container.get('app');
          app.joinSession(session.id);
        });
        container.appendChild(item);
      }
    }

    // Running terminals (we'd need terminal list - for now show a message)
    const termHeader = document.createElement('div');
    termHeader.className = 'shell-launcher__section-title';
    termHeader.textContent = 'Running Terminals';
    container.appendChild(termHeader);

    // Get terminals from terminal manager
    const app = this.container.get('app');
    const terminalMap = app.terminalManager?.terminals;
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
    const ws = this.container.get('ws');
    ws.send({
      type: 'terminal_create',
      templateId,
      directory: project?.path || '',
      cols: 80,
      rows: 24,
    });
    this.hide();
  }

  _launchWebUI(model, settings) {
    const ws = this.container.get('ws');
    ws.send({
      type: 'create_session',
      projectId: this.projectId,
      model,
      settings,
    });
    this.hide();
  }

  _iconSVG(id) {
    switch (id) {
      case 'claude-code':
        return '<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2.5a1 1 0 110 2 1 1 0 010-2zM6.5 7h3l-.5 5h-2L6.5 7z"/></svg>';
      case 'shell':
        return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4l5 4-5 4"/><line x1="8" y1="13" x2="14" y2="13"/></svg>';
      default:
        return '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1"><rect x="1" y="2" width="14" height="12" rx="2"/><path d="M4 6l3 2-3 2"/></svg>';
    }
  }
}
