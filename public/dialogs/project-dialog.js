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
    // Working sets carry literal MCP/model ids; the '*' wildcard is just
    // another id (matches relay's isWildcard convention).
    this._selectedMcpIds = new Set();
    this._selectedModels = new Set();
    this._editingTemplateIdx = -1; // -1 = not editing, >=0 = index
    this._editingShellTemplate = null; // null = not editing, object = editing/creating
  }

  init() {
    this.bus.on(EVT.DIALOG_PROJECT, (data) => {
      this._projectId = data?.projectId || null;
      this._project = this._projectId ? this.state.getProject(this._projectId) : null;
      this._templates = this._project?.chatTemplates ? JSON.parse(JSON.stringify(this._project.chatTemplates)) : [];

      this._selectedMcpIds = new Set(this._project?.allowedMcpIds || []);
      this._selectedModels = new Set(this._project?.allowedModels || []);

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

    this._renderMcpsPicker(form);
    this._renderModelsPicker(form);

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
      this._saveProject(nameInput.value.trim(), pathInput.value.trim());
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
    nameInput.focus();
  }

  _renderMcpsPicker(parent) {
    const label = document.createElement('label');
    label.className = 'dialog__label';
    label.textContent = 'Allowed MCPs';
    parent.appendChild(label);

    const list = document.createElement('div');
    list.className = 'project-dialog__checkbox-list';

    const items = [
      { id: MCP_WILDCARD, label: 'All MCPs (wildcard)' },
      ...this.state.mcps.map(m => ({ id: m.id, label: m.display_name || m.id })),
    ];
    for (const item of items) {
      list.appendChild(this._mcpRow(item));
    }
    if (this.state.mcps.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'field-hint';
      empty.textContent = 'No MCPs configured in relay.';
      list.appendChild(empty);
    }
    parent.appendChild(list);
  }

  _mcpRow({ id, label }) {
    const row = document.createElement('label');
    row.className = 'project-dialog__checkbox-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = id;
    cb.checked = this._selectedMcpIds.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) this._selectedMcpIds.add(id);
      else this._selectedMcpIds.delete(id);
    });
    row.appendChild(cb);
    const txt = document.createElement('span');
    txt.textContent = label;
    row.appendChild(txt);
    return row;
  }

  _renderModelsPicker(parent) {
    const label = document.createElement('label');
    label.className = 'dialog__label';
    label.textContent = 'Allowed Models';
    parent.appendChild(label);

    const list = document.createElement('div');
    list.className = 'project-dialog__checkbox-list';

    if (this.state.models.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'field-hint';
      empty.textContent = 'No models discovered.';
      list.appendChild(empty);
    } else {
      for (const model of this.state.models) {
        const row = document.createElement('label');
        row.className = 'project-dialog__checkbox-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = model.value;
        cb.checked = this._selectedModels.has(model.value);
        cb.addEventListener('change', () => {
          if (cb.checked) this._selectedModels.add(model.value);
          else this._selectedModels.delete(model.value);
        });
        row.appendChild(cb);
        const txt = document.createElement('span');
        txt.textContent = model.label || model.value;
        row.appendChild(txt);
        list.appendChild(row);
      }
    }

    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = 'Leave all unchecked to allow every model.';
    parent.appendChild(list);
    parent.appendChild(hint);
  }

  async _saveProject(name, path) {
    if (!name || !path) return;

    try {
      const body = {
        name,
        path,
        allowed_mcp_ids: Array.from(this._selectedMcpIds),
        allowed_models: Array.from(this._selectedModels),
        chat_templates: this._templates.map(t => ({
          id: t.id,
          name: t.name,
          model: t.model,
          mode: t.mode || MODE_TEXT,
          voice: t.voice || '',
          system_prompt: t.systemPrompt || '',
        })),
      };
      const project = this._projectId
        ? await this.api.updateProject(this._projectId, body)
        : await this.api.createProject(body);

      const renamed = !!this._projectId && this._project && this._project.name !== project.name;
      this.state.projects.set(project.id, project);
      this.bus.emit(EVT.PROJECTS_LOADED);
      if (renamed) this.bus.emit(EVT.PROJECT_RENAMED, { projectId: project.id });
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
        this._saveProject(project.name, project.path);
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

    if (tmpl.mode === MODE_VOICE) {
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
    const textRadio = this._createRadio(modeRow, 'tmpl-mode', MODE_TEXT, 'Text', tmpl.mode !== MODE_VOICE);
    const voiceRadio = this._createRadio(modeRow, 'tmpl-mode', MODE_VOICE, 'Voice', tmpl.mode === MODE_VOICE);
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
        mode: voiceRadio.checked ? MODE_VOICE : MODE_TEXT,
        voice: voiceRadio.checked ? voiceSelect.value : '',
        systemPrompt: promptArea.value.trim(),
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
