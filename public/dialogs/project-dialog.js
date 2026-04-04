/**
 * ProjectDialog - tabbed Edit/New Project dialog with General and Templates tabs.
 * Replaces the old #projectModal HTML + ModalManager project methods.
 */
class ProjectDialog extends DialogBase {
  constructor(container) {
    super(container, 'project-dialog');
    this.log = container.get('logger').child('ProjectDialog');
    this.state = container.get('state');
    this.api = container.get('api');
    this._projectId = null;
    this._project = null;
    this._templates = []; // working copy of chatTemplates
    this._editingTemplateIdx = -1; // -1 = not editing, >=0 = index
    this._editingShellTemplate = null; // null = not editing, object = editing/creating
  }

  init() {
    this.bus.on(EVT.DIALOG_PROJECT, (data) => {
      this._projectId = data?.projectId || null;
      this._project = this._projectId ? this.state.getProject(this._projectId) : null;
      this._templates = this._project?.chatTemplates ? JSON.parse(JSON.stringify(this._project.chatTemplates)) : [];
      this._editingTemplateIdx = -1;
      this._editingShellTemplate = null;
      this.render();
      this.show();
    });
  }

  render() {
    const isEdit = !!this._projectId;
    const title = isEdit ? 'Edit Project' : 'New Project';
    const badge = this._project?.name || '';

    this._panel.innerHTML = '';
    this._panel.style.maxWidth = '520px';

    this._panel.appendChild(this._createTitleBar(title, badge));

    const { header } = this._createTabs(
      [{ name: 'general', label: 'General' }, { name: 'templates', label: 'Templates' }],
      (tab) => this._showTab(tab)
    );
    this._panel.appendChild(header);

    this._tabContent = document.createElement('div');
    this._tabContent.className = 'dialog__tab-content';
    this._panel.appendChild(this._tabContent);

    this._showTab('general');
  }

  _showTab(tabName) {
    this._tabContent.innerHTML = '';
    if (tabName === 'general') {
      this._renderGeneralTab();
    } else {
      this._renderTemplatesTab();
    }
  }

  // ─── General Tab ───────────────────────────────────────────

  _renderGeneralTab() {
    const form = document.createElement('div');
    form.className = 'project-dialog__form';

    const nameInput = this._createField(form, 'Project Name', 'text', {
      placeholder: 'My Project', required: true, value: this._project?.name || '',
    });

    const pathInput = this._createField(form, 'Directory Path', 'text', {
      placeholder: '/path/to/project', required: true, value: this._project?.path || '',
    });

    const toolsInput = this._createField(form, 'Allowed Tools (optional)', 'text', {
      placeholder: 'e.g. Read Glob Grep "Bash(git:*)"',
      value: (this._project?.allowedTools || []).join(' '),
    });
    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = 'Space-separated. Pre-approves these tools without prompting.';
    form.appendChild(hint);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'dialog__btn dialog__btn--secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.hide());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'dialog__btn dialog__btn--primary';
    saveBtn.textContent = this._projectId ? 'Save' : 'Create Project';
    saveBtn.addEventListener('click', () => {
      this._saveProject(nameInput.value.trim(), pathInput.value.trim(), parseArgsString(toolsInput.value));
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
    nameInput.focus();
  }

  async _saveProject(name, path, allowedTools) {
    if (!name || !path) return;

    try {
      const body = { name, path, allowedTools, chatTemplates: this._templates };
      let project;
      if (this._projectId) {
        project = await this.api.updateProject(this._projectId, body);
      } else {
        project = await this.api.createProject(body);
      }
      this.state.projects.set(project.id, project);
      this.bus.emit(EVT.PROJECTS_LOADED);
      this.hide();
    } catch (err) {
      this.log.error('Failed to save project:', err);
      const existing = this._panel.querySelector('.project-dialog__error');
      if (existing) existing.remove();
      const errEl = document.createElement('div');
      errEl.className = 'project-dialog__error';
      errEl.textContent = 'Failed to save project. Please try again.';
      this._tabContent.prepend(errEl);
    }
  }

  // ─── Templates Tab ─────────────────────────────────────────

  _renderTemplatesTab() {
    const container = document.createElement('div');
    container.className = 'project-dialog__templates';

    if (this._editingTemplateIdx >= 0) {
      this._renderTemplateForm(container, this._editingTemplateIdx);
    } else if (this._editingShellTemplate !== null) {
      this._renderShellTemplateForm(container, this._editingShellTemplate);
    } else {
      this._renderTemplateList(container);
    }

    this._tabContent.appendChild(container);
  }

  _renderTemplateList(container) {
    // --- Chat Templates ---
    if (this._templates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-dialog__empty';
      empty.textContent = 'No chat templates yet.';
      container.appendChild(empty);
    } else {
      for (let i = 0; i < this._templates.length; i++) {
        container.appendChild(this._renderTemplateItem(i));
      }
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'dialog__btn dialog__btn--primary project-dialog__add-btn';
    addBtn.textContent = '+ Add Template';
    addBtn.addEventListener('click', () => {
      this._templates.push({
        id: crypto.randomUUID(),
        name: '',
        model: this.state.models.length > 0 ? this.state.models[0].value : '',
        mode: 'text',
        voice: '',
        systemPrompt: '',
        appendClaudeMd: false,
        settings: null,
      });
      this._editingTemplateIdx = this._templates.length - 1;
      this._showTab('templates');
    });
    container.appendChild(addBtn);

    // --- Shell Templates (global, saved immediately via API) ---
    const shellHeader = document.createElement('div');
    shellHeader.className = 'project-dialog__section-title';
    shellHeader.textContent = 'Shell Templates';
    container.appendChild(shellHeader);

    const customTemplates = this.state.terminalTemplates.filter(t => !t.builtIn);
    if (customTemplates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-dialog__empty';
      empty.textContent = 'No custom shell templates yet.';
      container.appendChild(empty);
    } else {
      for (const tmpl of customTemplates) {
        container.appendChild(this._renderShellTemplateItem(tmpl));
      }
    }

    const addShellBtn = document.createElement('button');
    addShellBtn.className = 'dialog__btn dialog__btn--primary project-dialog__add-btn';
    addShellBtn.textContent = '+ Add Shell Template';
    addShellBtn.addEventListener('click', () => {
      this._editingShellTemplate = { id: null, name: '', command: '', args: [], description: '' };
      this._showTab('templates');
    });
    container.appendChild(addShellBtn);

    // Save + Cancel actions (so user doesn't have to switch to General tab)
    if (this._projectId) {
      const actions = document.createElement('div');
      actions.className = 'dialog__actions';

      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'dialog__btn dialog__btn--secondary';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => this.hide());

      const saveBtn = document.createElement('button');
      saveBtn.className = 'dialog__btn dialog__btn--primary';
      saveBtn.textContent = 'Save';
      saveBtn.addEventListener('click', () => {
        const project = this.state.getProject(this._projectId);
        this._saveProject(project.name, project.path, project.allowedTools || []);
      });

      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      container.appendChild(actions);
    }
  }

  _renderTemplateItem(idx) {
    const tmpl = this._templates[idx];
    const item = document.createElement('div');
    item.className = 'project-dialog__template-item';

    const info = document.createElement('div');
    info.className = 'project-dialog__template-info';

    const name = document.createElement('span');
    name.className = 'project-dialog__template-name';
    name.textContent = tmpl.name || 'Untitled';

    const badges = document.createElement('span');
    badges.className = 'project-dialog__template-badges';

    const modelBadge = document.createElement('span');
    modelBadge.className = 'project-dialog__badge';
    const modelInfo = this.state.models.find(m => m.value === tmpl.model);
    modelBadge.textContent = modelInfo?.label || tmpl.model || '—';
    badges.appendChild(modelBadge);

    if (tmpl.mode === 'voice') {
      const voiceBadge = document.createElement('span');
      voiceBadge.className = 'project-dialog__badge project-dialog__badge--voice';
      voiceBadge.textContent = 'voice';
      badges.appendChild(voiceBadge);
    }

    info.appendChild(name);
    info.appendChild(badges);

    const actions = document.createElement('div');
    actions.className = 'project-dialog__template-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'project-dialog__icon-btn';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    editBtn.addEventListener('click', () => {
      this._editingTemplateIdx = idx;
      this._showTab('templates');
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'project-dialog__icon-btn project-dialog__icon-btn--danger';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    deleteBtn.addEventListener('click', () => {
      this._templates.splice(idx, 1);
      this._showTab('templates');
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);
    return item;
  }

  // ─── Template Edit Form ────────────────────────────────────

  _renderTemplateForm(container, idx) {
    const tmpl = this._templates[idx];
    const form = document.createElement('div');
    form.className = 'project-dialog__template-form';

    // Name
    const nameInput = this._createField(form, 'Template Name', 'text', {
      placeholder: 'e.g. Quick Chat', value: tmpl.name,
    });

    // Model
    const modelLabel = document.createElement('label');
    modelLabel.className = 'dialog__label';
    modelLabel.textContent = 'Model';
    form.appendChild(modelLabel);
    const modelSelect = document.createElement('select');
    renderModelSelect(modelSelect, this.state.models, {
      className: 'dialog__select',
      selectedValue: tmpl.model,
    });
    form.appendChild(modelSelect);

    // Mode
    const modeLabel = document.createElement('label');
    modeLabel.className = 'dialog__label';
    modeLabel.textContent = 'Startup Mode';
    form.appendChild(modeLabel);

    const modeRow = document.createElement('div');
    modeRow.className = 'project-dialog__mode-row';
    const textRadio = this._createRadio(modeRow, 'tmpl-mode', 'text', 'Text', tmpl.mode !== 'voice');
    const voiceRadio = this._createRadio(modeRow, 'tmpl-mode', 'voice', 'Voice', tmpl.mode === 'voice');
    form.appendChild(modeRow);

    // Voice select (shown for voice mode)
    const voiceWrapper = document.createElement('div');
    voiceWrapper.className = 'project-dialog__voice-wrapper';
    const voiceLabel = document.createElement('label');
    voiceLabel.className = 'dialog__label';
    voiceLabel.textContent = 'Default Voice';
    voiceWrapper.appendChild(voiceLabel);
    const voiceSelect = this._createVoiceSelect(tmpl.voice);
    voiceWrapper.appendChild(voiceSelect);
    form.appendChild(voiceWrapper);

    const updateVoiceVisibility = () => {
      voiceWrapper.style.display = voiceRadio.checked ? '' : 'none';
    };
    textRadio.addEventListener('change', updateVoiceVisibility);
    voiceRadio.addEventListener('change', updateVoiceVisibility);
    updateVoiceVisibility();

    // System Prompt
    const promptLabel = document.createElement('label');
    promptLabel.className = 'dialog__label';
    promptLabel.textContent = 'System Prompt';
    form.appendChild(promptLabel);
    const promptArea = document.createElement('textarea');
    promptArea.className = 'dialog__input project-dialog__textarea';
    promptArea.placeholder = 'Optional system instructions...';
    promptArea.value = tmpl.systemPrompt || '';
    promptArea.rows = 4;
    form.appendChild(promptArea);

    // Append CLAUDE.md checkbox
    const claudeMdWrapper = document.createElement('div');
    claudeMdWrapper.className = 'project-dialog__checkbox-row';
    const claudeMdCheck = document.createElement('input');
    claudeMdCheck.type = 'checkbox';
    claudeMdCheck.id = 'tmpl-append-claudemd';
    claudeMdCheck.checked = tmpl.appendClaudeMd || false;
    const claudeMdLabel = document.createElement('label');
    claudeMdLabel.htmlFor = 'tmpl-append-claudemd';
    claudeMdLabel.textContent = 'Append CLAUDE.md';
    const claudeMdHint = document.createElement('span');
    claudeMdHint.className = 'field-hint';
    claudeMdHint.textContent = 'Inject project CLAUDE.md into system prompt (non-Claude models only)';
    claudeMdWrapper.appendChild(claudeMdCheck);
    claudeMdWrapper.appendChild(claudeMdLabel);
    claudeMdWrapper.appendChild(claudeMdHint);
    form.appendChild(claudeMdWrapper);

    // Show/hide Append CLAUDE.md based on model provider
    const updateClaudeMdVisibility = () => {
      const selectedModel = this.state.models.find(m => m.value === modelSelect.value);
      const isClaude = selectedModel?.provider === 'claude';
      claudeMdWrapper.style.display = isClaude ? 'none' : '';
    };
    modelSelect.addEventListener('change', updateClaudeMdVisibility);
    updateClaudeMdVisibility();

    // Provider settings
    const settingsContainer = this._addProviderSettings(form, modelSelect, tmpl.settings);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    const backBtn = document.createElement('button');
    backBtn.className = 'dialog__btn dialog__btn--secondary';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => {
      // Discard if name is empty (new unsaved template)
      if (!nameInput.value.trim() && !tmpl.name) {
        this._templates.splice(idx, 1);
      }
      this._editingTemplateIdx = -1;
      this._showTab('templates');
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'dialog__btn dialog__btn--primary';
    saveBtn.textContent = 'Save Template';
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }

      this._templates[idx] = {
        id: tmpl.id,
        name,
        model: modelSelect.value,
        mode: voiceRadio.checked ? 'voice' : 'text',
        voice: voiceRadio.checked ? voiceSelect.value : '',
        systemPrompt: promptArea.value.trim(),
        appendClaudeMd: claudeMdCheck.checked,
        settings: this._collectSettings(settingsContainer),
      };
      this._editingTemplateIdx = -1;
      this._showTab('templates');
    });

    actions.appendChild(backBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    container.appendChild(form);
    nameInput.focus();
  }

  // ─── Shell Template List Item ────────────────────────────

  _renderShellTemplateItem(tmpl) {
    const item = document.createElement('div');
    item.className = 'project-dialog__template-item';

    const info = document.createElement('div');
    info.className = 'project-dialog__template-info';

    const name = document.createElement('span');
    name.className = 'project-dialog__template-name';
    name.textContent = tmpl.name || 'Untitled';

    const badges = document.createElement('span');
    badges.className = 'project-dialog__template-badges';

    const cmdBadge = document.createElement('span');
    cmdBadge.className = 'project-dialog__badge';
    cmdBadge.textContent = this._templateToCommandLine(tmpl) || '—';
    badges.appendChild(cmdBadge);

    info.appendChild(name);
    info.appendChild(badges);

    const actions = document.createElement('div');
    actions.className = 'project-dialog__template-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'project-dialog__icon-btn';
    editBtn.title = 'Edit';
    editBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
    editBtn.addEventListener('click', () => {
      this._editingShellTemplate = { ...tmpl };
      this._showTab('templates');
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'project-dialog__icon-btn project-dialog__icon-btn--danger';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
    deleteBtn.addEventListener('click', async () => {
      try {
        await this.api.deleteTerminalTemplate(tmpl.id);
        this.state.removeTerminalTemplate(tmpl.id);
        this._showTab('templates');
      } catch (err) {
        this.log.error('Failed to delete shell template:', err);
      }
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);
    return item;
  }

  // ─── Shell Template Edit Form ──────────────────────────────

  _renderShellTemplateForm(container, tmpl) {
    const isEdit = !!tmpl.id;
    const form = document.createElement('div');
    form.className = 'project-dialog__template-form';

    const nameInput = this._createField(form, 'Template Name', 'text', {
      placeholder: 'e.g. Advanced Claude', value: tmpl.name,
    });

    const cmdInput = this._createField(form, 'Command', 'text', {
      placeholder: 'e.g. claude --dangerously-skip-permissions',
      value: this._templateToCommandLine(tmpl),
    });

    const descInput = this._createField(form, 'Description (optional)', 'text', {
      placeholder: 'Brief description', value: tmpl.description || '',
    });

    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    const backBtn = document.createElement('button');
    backBtn.className = 'dialog__btn dialog__btn--secondary';
    backBtn.textContent = 'Back';
    backBtn.addEventListener('click', () => {
      this._editingShellTemplate = null;
      this._showTab('templates');
    });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'dialog__btn dialog__btn--primary';
    saveBtn.textContent = isEdit ? 'Update Template' : 'Create Template';
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const cmdLine = cmdInput.value.trim();
      if (!name || !cmdLine) { (name ? cmdInput : nameInput).focus(); return; }

      const { command, args } = this._parseCommandLine(cmdLine);
      const data = { name, command, args, description: descInput.value.trim() };

      try {
        let result;
        if (isEdit) {
          result = await this.api.updateTerminalTemplate(tmpl.id, data);
        } else {
          result = await this.api.createTerminalTemplate(data);
        }
        if (result?.id) this.state.addTerminalTemplate(result);
        this._editingShellTemplate = null;
        this._showTab('templates');
      } catch (err) {
        this.log.error('Failed to save shell template:', err);
      }
    });

    actions.appendChild(backBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    container.appendChild(form);
    nameInput.focus();
  }

  // ─── Command Line Helpers ──────────────────────────────────

  _parseCommandLine(str) {
    const tokens = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    for (const ch of str) {
      if (inQuote) {
        if (ch === quoteChar) { inQuote = false; }
        else { current += ch; }
      } else if (ch === '"' || ch === "'") {
        inQuote = true;
        quoteChar = ch;
      } else if (ch === ' ' || ch === '\t') {
        if (current) { tokens.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return { command: tokens[0] || '', args: tokens.slice(1) };
  }

  _templateToCommandLine(tmpl) {
    if (!tmpl.command) return '';
    const parts = [tmpl.command, ...(tmpl.args || [])];
    return parts.map(p => p.includes(' ') ? `"${p}"` : p).join(' ');
  }

  // ─── Helpers (unique to this dialog) ─────────────────────

  _createField(parent, labelText, type, opts = {}) {
    const label = document.createElement('label');
    label.className = 'dialog__label';
    label.textContent = labelText;
    parent.appendChild(label);

    const input = document.createElement('input');
    input.type = type;
    input.className = 'dialog__input';
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value) input.value = opts.value;
    if (opts.required) input.required = true;
    parent.appendChild(input);
    return input;
  }

  _createRadio(parent, name, value, label, checked) {
    const wrapper = document.createElement('label');
    wrapper.className = 'project-dialog__radio-label';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    wrapper.appendChild(input);
    wrapper.appendChild(document.createTextNode(' ' + label));
    parent.appendChild(wrapper);
    return input;
  }
}
