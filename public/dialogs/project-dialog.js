class ProjectDialog extends DialogBase {
  constructor(container) {
    super(container, 'project-dialog');
    this.log = container.get('logger').child('ProjectDialog');
    this.state = container.get('state');
    this.api = container.get('api');
    this._projectId = null;
    this._project = null;
    this._templates = [];
    // relay treats an absent chat_templates field on save as "leave
    // unchanged", so it's only included in the body once the user actually
    // edits a template here.
    this._templatesDirty = false;
    this._editingTemplateIdx = -1;
    this._mode = 'both';
    this._initialMode = 'both';
  }

  init() {
    this.bus.on(EVT.DIALOG_PROJECT, (data) => {
      this._projectId = data?.projectId || null;
      this._project = this._projectId ? this.state.getProject(this._projectId) : null;
      this._templates = this._project?.chatTemplates ? JSON.parse(JSON.stringify(this._project.chatTemplates)) : [];
      this._templatesDirty = false;

      // A new project starts at Both; an existing one starts at its own mode.
      this._initialMode = this._project ? Mode.normalizeProjectMode(this._project.mode) : 'both';
      this._mode = this._initialMode;

      this._editingTemplateIdx = -1;
      this._hostId = this._project?.hostId || this._project?.host?.id || '';
      this._draft = { name: this._project?.name || '', path: this._project?.path || '' };
      this.render();
      this.show();
      this._refreshHosts();
    });
  }

  _hosts() {
    const map = this.state.hosts;
    if (!map) return [];
    return Array.from(typeof map.values === 'function' ? map.values() : Object.values(map))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async _refreshHosts() {
    if (typeof this.api.getHosts !== 'function') return;
    try {
      const hosts = await this.api.getHosts();
      const before = this._hostsSignature();
      if (typeof this.state.setHosts === 'function') this.state.setHosts(hosts);
      if (this._activeTab === 'general' && this._hostsSignature() !== before) this._updateHostControls();
    } catch (err) {
      this.log.warn('Could not load hosts:', err);
    }
  }

  _hostsSignature() {
    return JSON.stringify(this._hosts().map(h => [h.id, h.name, this.state.hostStatus?.(h.id) || h.status || 'unknown']));
  }

  // Hosts arrive while the user may be typing: swap only the Where control and
  // the path field's wording, never the inputs or Save, and never move focus.
  _updateHostControls() {
    const old = this._whereControl;
    if (!old?.isConnected) return;
    const scratch = document.createElement('div');
    this._renderWhere(scratch);
    old.replaceWith(this._whereControl);
    const host = this._hostId ? this._hosts().find(h => h.id === this._hostId) : null;
    this._pathInput.previousElementSibling.textContent = host ? `Path on ${host.name}` : 'Directory Path';
    this._pathInput.placeholder = host ? '/home/you/project' : '/path/to/project';
  }

  render() {
    const isEdit = !!this._projectId;
    const title = isEdit ? 'Edit Project' : 'New Project';
    const badge = this._project?.name || '';

    this._panel.innerHTML = '';
    this._panel.style.maxWidth = '520px';

    this._panel.appendChild(this._createTitleBar(title, badge));

    const { header } = this._createTabs(
      [
        { name: 'general', label: 'General' },
        { name: 'templates', label: 'Templates' },
      ],
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
    this._activeTab = tabName;
    if (tabName === 'general') {
      this._renderGeneralTab();
    } else {
      this._renderTemplatesTab();
    }
  }

  _renderGeneralTab() {
    // The Where control re-renders this tab on every change, so the typed
    // name and path live in _draft rather than only in the inputs.
    this._captureDraft();
    this._tabContent.innerHTML = '';

    const form = document.createElement('div');
    form.className = 'project-dialog__form';

    const nameInput = this._createField(form, 'Project Name', 'text', {
      placeholder: 'My Project', required: true, value: this._draft.name,
    });
    nameInput.dataset.testid = 'project-name';
    nameInput.addEventListener('input', () => { this._draft.name = nameInput.value; });

    this._renderWhere(form);

    const host = this._hostId ? this._hosts().find(h => h.id === this._hostId) : null;
    const pathInput = this._createField(form, host ? `Path on ${host.name}` : 'Directory Path', 'text', {
      placeholder: host ? '/home/you/project' : '/path/to/project', required: true, value: this._draft.path,
    });
    pathInput.dataset.testid = 'project-path';
    pathInput.addEventListener('input', () => { this._draft.path = pathInput.value; });

    this._renderModeControl(form);
    this._renderModelsReadOnly(form);

    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'dialog__btn dialog__btn--secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => this.hide());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'dialog__btn dialog__btn--primary';
    saveBtn.dataset.testid = 'project-save';
    saveBtn.textContent = this._projectId ? 'Save' : 'Create Project';
    saveBtn.addEventListener('click', () => {
      this._saveProject(nameInput.value.trim(), pathInput.value.trim());
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
    this._nameInput = nameInput;
    this._pathInput = pathInput;
    nameInput.focus();
  }

  _captureDraft() {
    if (this._nameInput?.isConnected) this._draft.name = this._nameInput.value;
    if (this._pathInput?.isConnected) this._draft.path = this._pathInput.value;
  }

  // — Where: this Mac or an SSH host ------------------------------------------

  _renderWhere(parent) {
    const label = document.createElement('label');
    label.className = 'dialog__label';
    label.textContent = 'Where';
    parent.appendChild(label);

    const control = document.createElement('div');
    control.className = 'where-control';
    control.dataset.testid = 'project-where';

    const seg = (text, { active, hostStatus = null, onClick, testid }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `where-control__seg${active ? ' where-control__seg--active' : ''}`;
      if (hostStatus) btn.classList.add(`where-control__seg--${hostStatus}`);
      if (testid) btn.dataset.testid = testid;
      if (hostStatus) {
        const dot = document.createElement('span');
        dot.className = 'host-chip__dot';
        btn.appendChild(dot);
      }
      const t = document.createElement('span');
      t.textContent = text;
      btn.appendChild(t);
      btn.addEventListener('click', onClick);
      control.appendChild(btn);
      return btn;
    };

    seg('This Mac', {
      active: !this._hostId,
      testid: 'project-where-local',
      onClick: () => { this._hostId = ''; this._renderGeneralTab(); },
    });
    for (const h of this._hosts()) {
      const status = this.state.hostStatus?.(h.id) || h.status || 'unknown';
      seg(h.name, {
        active: this._hostId === h.id,
        hostStatus: status,
        testid: `project-where-host-${h.id}`,
        onClick: () => { this._hostId = h.id; this._renderGeneralTab(); },
      });
    }
    parent.appendChild(control);
    this._whereControl = control;
  }

  // Models are admin config owned by Relay; the dialog only shows them.
  _renderModelsReadOnly(parent) {
    const label = document.createElement('label');
    label.className = 'dialog__label';
    label.textContent = 'Allowed Models';
    parent.appendChild(label);

    const allowed = this._project?.allowedModels || [];
    const text = document.createElement('div');
    text.className = 'where-note';
    text.dataset.testid = 'project-allowed-models';
    if (allowed.length === 0 || allowed.includes('*')) {
      text.textContent = 'All models';
    } else {
      const labelFor = (id) => this.state.models.find(m => m.value === id)?.label || id;
      text.textContent = allowed.map(labelFor).join(', ');
    }
    parent.appendChild(text);

    const pointer = document.createElement('span');
    pointer.className = 'field-hint';
    pointer.dataset.testid = 'project-relay-pointer';
    pointer.textContent = 'Set in Relay Settings on your Mac.';
    parent.appendChild(pointer);
  }

  _renderModeControl(parent) {
    const label = document.createElement('label');
    label.className = 'dialog__label';
    label.textContent = 'Mode';
    parent.appendChild(label);

    const control = document.createElement('div');
    control.className = 'where-control';
    control.dataset.testid = 'project-mode';
    for (const [value, text] of [['home', 'Home'], ['work', 'Work'], ['both', 'Both']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `where-control__seg${this._mode === value ? ' where-control__seg--active' : ''}`;
      btn.dataset.testid = `project-mode-${value}`;
      btn.setAttribute('aria-pressed', String(this._mode === value));
      btn.textContent = text;
      btn.addEventListener('click', () => {
        this._mode = value;
        this._prunePresets();
        this._renderGeneralTab();
      });
      control.appendChild(btn);
    }
    parent.appendChild(control);
  }

  // Modes the dialog's current project mode includes.
  _presetModes() {
    return this._mode === 'home' || this._mode === 'work' ? [this._mode] : ModePresets.MODES.slice();
  }

  // Drop presets for a mode the project no longer includes. Marks templates
  // dirty only when something was removed.
  _prunePresets() {
    const keep = this._presetModes();
    let removed = false;
    this._templates = this._templates.map(t => {
      const has = ModePresets.normalize(t.presetFor);
      const next = has.filter(m => keep.includes(m));
      if (next.length === has.length) return t;
      removed = true;
      return { ...t, presetFor: next };
    });
    if (removed) this._templatesDirty = true;
  }

  async _saveProject(name, path) {
    if (!name || !path) return;

    if (this._templatesDirty) {
      const blank = this._templates.find(t => !(t.model || '').trim());
      if (blank) {
        const label = (blank.name || '').trim() ? blank.name : 'Untitled';
        this._showError(`Template "${label}" has no model. Pick one before saving.`);
        return;
      }
    }

    try {
      const body = {
        name,
        path,
        host_id: this._hostId || '',
      };
      // Create always sends mode; update only when the user changed it,
      // since relay reads an absent key as no change.
      if (!this._projectId || this._mode !== this._initialMode) body.mode = this._mode;
      if (this._templatesDirty) {
        body.chat_templates = this._templates.map(t => {
          const out = {
            id: t.id,
            name: t.name,
            model: t.model,
            mode: t.mode || MODE_TEXT,
            voice: t.voice || '',
            system_prompt: t.systemPrompt || '',
          };
          const presetFor = ModePresets.normalize(t.presetFor);
          if (presetFor.length) out.preset_for = presetFor;
          return out;
        });
      }
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
      this._showError(err?.message
        ? `Failed to save project: ${err.message}`
        : 'Failed to save project. Please try again.');
    }
  }

  _showError(message) {
    const existing = this._panel.querySelector('.project-dialog__error');
    if (existing) existing.remove();
    const errEl = document.createElement('div');
    errEl.className = 'project-dialog__error';
    errEl.textContent = message;
    this._tabContent.prepend(errEl);
    errEl.scrollIntoView({ block: 'nearest' });
  }

  _renderTemplatesTab() {
    const container = document.createElement('div');
    container.className = 'project-dialog__templates';

    if (this._editingTemplateIdx >= 0) {
      this._renderTemplateForm(container, this._editingTemplateIdx);
    } else {
      this._renderTemplateList(container);
    }

    this._tabContent.appendChild(container);
  }

  _renderTemplateList(container) {
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

    for (const m of ModePresets.normalize(tmpl.presetFor)) {
      const presetBadge = document.createElement('span');
      presetBadge.className = 'project-dialog__badge project-dialog__preset-badge';
      presetBadge.dataset.testid = 'project-template-preset-badge';
      presetBadge.textContent = `${ModePresets.label(m)} ${ModePresets.kind(tmpl) === 'voice' ? 'voice' : 'Ask'}`;
      badges.appendChild(presetBadge);
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
      this._templatesDirty = true;
      this._showTab('templates');
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);
    return item;
  }

  _renderTemplateForm(container, idx) {
    const tmpl = this._templates[idx];
    const form = document.createElement('div');
    form.className = 'project-dialog__template-form';

    const nameInput = this._createField(form, 'Template Name', 'text', {
      placeholder: 'e.g. Quick Chat', value: tmpl.name,
    });

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

    const modeLabel = document.createElement('label');
    modeLabel.className = 'dialog__label';
    modeLabel.textContent = 'Startup Mode';
    form.appendChild(modeLabel);

    const modeRow = document.createElement('div');
    modeRow.className = 'project-dialog__mode-row';
    const textRadio = this._createRadio(modeRow, 'tmpl-mode', MODE_TEXT, 'Text', tmpl.mode !== MODE_VOICE);
    const voiceRadio = this._createRadio(modeRow, 'tmpl-mode', MODE_VOICE, 'Voice', tmpl.mode === MODE_VOICE);
    form.appendChild(modeRow);

    // Preset row: buttons, not checkboxes (the chat-defaults guard counts checkboxes).
    const presetModes = this._presetModes();
    const pressed = new Set(ModePresets.normalize(tmpl.presetFor));
    const presetWrapper = document.createElement('div');
    presetWrapper.className = 'project-dialog__preset';
    const presetLabel = document.createElement('label');
    presetLabel.className = 'dialog__label';
    presetWrapper.appendChild(presetLabel);
    const presetRow = document.createElement('div');
    presetRow.className = 'project-dialog__preset-row';
    const presetBtns = {};
    for (const m of presetModes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'project-dialog__preset-btn';
      btn.dataset.testid = `project-template-preset-${m}`;
      btn.textContent = ModePresets.label(m);
      const sync = () => {
        btn.setAttribute('aria-pressed', String(pressed.has(m)));
        btn.classList.toggle('project-dialog__preset-btn--on', pressed.has(m));
      };
      sync();
      btn.addEventListener('click', () => {
        if (pressed.has(m)) pressed.delete(m); else pressed.add(m);
        sync();
      });
      presetRow.appendChild(btn);
      presetBtns[m] = btn;
    }
    presetWrapper.appendChild(presetRow);
    form.appendChild(presetWrapper);
    const updatePresetLabel = () => {
      presetLabel.textContent = voiceRadio.checked ? 'Voice preset in' : 'Ask preset in';
    };
    textRadio.addEventListener('change', updatePresetLabel);
    voiceRadio.addEventListener('change', updatePresetLabel);
    updatePresetLabel();

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
      if (!modelSelect.value.trim()) {
        this._showError('Pick a model for this template.');
        modelSelect.focus();
        return;
      }

      this._templatesDirty = true;
      // Modes the form does not show keep what the template had.
      const hidden = ModePresets.normalize(tmpl.presetFor).filter(m => !presetModes.includes(m));
      let next = [...this._templates];
      next[idx] = {
        id: tmpl.id,
        name,
        model: modelSelect.value,
        mode: voiceRadio.checked ? MODE_VOICE : MODE_TEXT,
        voice: voiceRadio.checked ? voiceSelect.value : '',
        systemPrompt: promptArea.value.trim(),
        presetFor: ModePresets.normalize([...hidden, ...presetModes.filter(m => pressed.has(m))]),
      };
      // One preset of a kind per mode: a pressed mode clears from the others.
      for (const m of presetModes) {
        if (pressed.has(m)) next = ModePresets.withPreset(next, idx, m, true);
      }
      this._templates = next;
      this._editingTemplateIdx = -1;
      this._showTab('templates');
    });

    actions.appendChild(backBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    container.appendChild(form);
    nameInput.focus();
  }

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
