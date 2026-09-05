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
    // Same relay contract as chat_templates: shell_templates is only
    // included in the save body once edited here.
    this._shellTemplates = [];
    this._shellTemplatesDirty = false;
    // The '*' wildcard is just another id, matching relay's isWildcard
    // convention.
    this._selectedMcpIds = new Set();
    this._selectedModels = new Set();
    this._editingTemplateIdx = -1;
    this._editingShellTemplate = null;
    this._policy = this._defaultPolicy();
  }

  _defaultPolicy() {
    return { default_mode: 'default', allowed_tools: [], denied_tools: [] };
  }

  // relay treats an empty struct as "clear the policy".
  _serializePolicy() {
    const p = this._policy || {};
    const out = {};
    if (p.default_mode && p.default_mode !== 'default') out.default_mode = p.default_mode;
    if (p.allowed_tools && p.allowed_tools.length > 0) out.allowed_tools = p.allowed_tools;
    if (p.denied_tools && p.denied_tools.length > 0) out.denied_tools = p.denied_tools;
    return out;
  }

  init() {
    this.bus.on(EVT.DIALOG_PROJECT, (data) => {
      this._projectId = data?.projectId || null;
      this._project = this._projectId ? this.state.getProject(this._projectId) : null;
      this._templates = this._project?.chatTemplates ? JSON.parse(JSON.stringify(this._project.chatTemplates)) : [];
      this._templatesDirty = false;
      this._shellTemplates = this._project?.shellTemplates ? JSON.parse(JSON.stringify(this._project.shellTemplates)) : [];
      this._shellTemplatesDirty = false;

      this._selectedMcpIds = new Set(this._project?.allowedMcpIds || []);
      this._selectedModels = new Set(this._project?.allowedModels || []);

      const existing = this._project?.permissionPolicy;
      this._policy = existing
        ? {
            default_mode: existing.defaultMode || existing.default_mode || 'default',
            allowed_tools: [...(existing.allowedTools || existing.allowed_tools || [])],
            denied_tools: [...(existing.deniedTools || existing.denied_tools || [])],
          }
        : this._defaultPolicy();

      this._editingTemplateIdx = -1;
      this._editingShellTemplate = null;
      this._hostId = this._project?.hostId || this._project?.host?.id || '';
      this._hostFormOpen = false;
      this._hostFormBusy = false;
      this._hostFormError = '';
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
      if (typeof this.state.setHosts === 'function') this.state.setHosts(hosts);
      if (this._activeTab === 'general') this._renderGeneralTab();
    } catch (err) {
      this.log.warn('Could not load hosts:', err);
    }
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
        { name: 'permissions', label: 'Permissions' },
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
    } else if (tabName === 'permissions') {
      this._renderPermissionsTab();
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

    if (this._hostId) {
      const label = document.createElement('label');
      label.className = 'dialog__label';
      label.textContent = 'Allowed MCPs';
      form.appendChild(label);
      const note = document.createElement('div');
      note.className = 'where-note';
      note.textContent = 'Relay tools aren’t available on a host yet — the agent uses its built-in tools there.';
      form.appendChild(note);
    } else {
      this._renderMcpsPicker(form);
    }
    this._renderModelsPicker(form);

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
    if (!this._hostFormOpen) nameInput.focus();
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
      onClick: () => { this._hostId = ''; this._hostFormOpen = false; this._renderGeneralTab(); },
    });
    for (const h of this._hosts()) {
      const status = this.state.hostStatus?.(h.id) || h.status || 'unknown';
      seg(h.name, {
        active: this._hostId === h.id,
        hostStatus: status,
        testid: `project-where-host-${h.id}`,
        onClick: () => { this._hostId = h.id; this._hostFormOpen = false; this._renderGeneralTab(); },
      });
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'where-control__seg where-control__seg--add';
    add.dataset.testid = 'project-where-add-host';
    add.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span>Host…</span>`;
    add.addEventListener('click', () => { this._hostFormOpen = !this._hostFormOpen; this._renderGeneralTab(); });
    control.appendChild(add);
    parent.appendChild(control);

    if (this._hostFormOpen) {
      parent.appendChild(this._renderHostForm());
    } else if (this._hostId) {
      const h = this._hosts().find(x => x.id === this._hostId);
      if (h) parent.appendChild(this._renderProbeCard(h, { withReprobe: true }));
    }
  }

  _renderHostForm() {
    const card = document.createElement('div');
    card.className = 'host-form';
    card.dataset.testid = 'host-form';

    const title = document.createElement('div');
    title.className = 'host-form__title';
    title.textContent = 'New host';
    card.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'host-form__grid';
    const draft = this._hostDraft || (this._hostDraft = { name: '', target: '', port: '', identity: '' });
    const field = (labelText, key, placeholder) => {
      const wrap = document.createElement('div');
      const input = this._createField(wrap, labelText, 'text', { placeholder, value: draft[key] });
      input.dataset.testid = `host-form-${key}`;
      input.addEventListener('input', () => { draft[key] = input.value; });
      grid.appendChild(wrap);
      return input;
    };
    const nameInput = field('Name', 'name', 'devbox');
    field('SSH target', 'target', 'user@host or ssh-config alias');
    field('Port', 'port', '22');
    field('Identity file', 'identity', 'optional, absolute path');
    card.appendChild(grid);

    const row = document.createElement('div');
    row.className = 'host-form__row';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'dialog__btn dialog__btn--primary';
    test.dataset.testid = 'host-form-add';
    test.textContent = this._hostFormBusy ? 'Connecting…' : 'Test & add';
    test.disabled = this._hostFormBusy;
    test.addEventListener('click', () => this._submitHostForm());
    row.appendChild(test);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'dialog__btn dialog__btn--secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { this._hostFormOpen = false; this._hostFormError = ''; this._renderGeneralTab(); });
    row.appendChild(cancel);
    const spacer = document.createElement('span');
    spacer.className = 'host-form__spacer';
    row.appendChild(spacer);
    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = 'Uses your own ssh keys and config.';
    row.appendChild(hint);
    card.appendChild(row);

    if (this._hostFormBusy) {
      const busy = document.createElement('div');
      busy.className = 'probe-card probe-card--busy';
      busy.textContent = `Connecting to ${draft.target || 'host'}…`;
      card.appendChild(busy);
    }
    if (this._hostFormError) {
      const err = document.createElement('div');
      err.className = 'host-form__error';
      err.textContent = this._hostFormError;
      card.appendChild(err);
    }
    if (this._hostFormResult) {
      card.appendChild(this._renderProbeCard(this._hostFormResult));
    }
    setTimeout(() => nameInput.focus(), 0);
    return card;
  }

  async _submitHostForm() {
    const d = this._hostDraft || {};
    const name = (d.name || '').trim();
    const target = (d.target || '').trim();
    if (!name || !target) {
      this._hostFormError = 'A name and an ssh target are both needed.';
      this._renderGeneralTab();
      return;
    }
    const port = parseInt(d.port, 10);
    const body = { name, target };
    if (Number.isInteger(port) && port > 0) body.port = port;
    if ((d.identity || '').trim()) body.identity_file = d.identity.trim();

    this._hostFormBusy = true;
    this._hostFormError = '';
    this._hostFormResult = null;
    this._renderGeneralTab();
    try {
      const host = await this.api.createHost(body);
      if (typeof this.state.setHosts === 'function') {
        const hosts = this._hosts().filter(h => h.id !== host.id);
        hosts.push(host);
        this.state.setHosts(hosts);
      }
      this._hostFormBusy = false;
      this._hostDraft = null;
      if (host.probe?.ok) {
        this._hostId = host.id;
        this._hostFormOpen = false;
      } else {
        this._hostFormResult = host;
        this._hostId = host.id;
        this._hostFormOpen = false;
      }
      this._renderGeneralTab();
    } catch (err) {
      this._hostFormBusy = false;
      this._hostFormError = err?.message ? `Could not add host: ${err.message}` : 'Could not add host.';
      this._renderGeneralTab();
    }
  }

  // What the probe found, as three verdict lines. The missing thing is named
  // as the thing to fix, so the card reads as a checklist not a log.
  _renderProbeCard(host, { withReprobe = false } = {}) {
    const card = document.createElement('div');
    card.className = 'probe-card';
    card.dataset.testid = `probe-card-${host.id}`;
    const p = host.probe || null;
    const line = (ok, text, path = '', fix = '') => {
      const el = document.createElement('div');
      el.className = `probe-card__line probe-card__line--${ok ? 'ok' : 'bad'}`;
      const mark = document.createElement('span');
      mark.className = 'probe-card__mark';
      mark.textContent = ok ? '✓' : '✗';
      el.appendChild(mark);
      const body = document.createElement('span');
      body.className = 'probe-card__text';
      body.textContent = text;
      if (path) {
        const pathEl = document.createElement('span');
        pathEl.className = 'probe-card__path';
        pathEl.textContent = `  ${path}`;
        body.appendChild(pathEl);
      }
      if (fix) {
        const fixEl = document.createElement('span');
        fixEl.className = 'probe-card__fix';
        fixEl.textContent = fix;
        body.appendChild(fixEl);
      }
      el.appendChild(body);
      card.appendChild(el);
    };

    if (!p) {
      line(false, `${host.name} hasn’t been checked yet.`, '', 'Run a probe to find node and claude on it.');
    } else if (!p.ok) {
      line(false, `Could not reach ${host.target || host.name}.`, '', p.error || 'ssh failed — try it from a terminal first.');
    } else {
      line(true, `Reachable as ${host.target}`, `${p.os || ''} ${p.arch || ''}`.trim());
      if (p.node_path) line(true, `node ${p.node_version || ''}`.trim(), p.node_path);
      else line(false, 'node not found', '', 'Install Node.js on this host and probe again.');
      if (p.claude_path) line(true, `claude ${p.claude_version || ''}`.trim(), p.claude_path);
      else line(false, 'claude not found', '', 'Install Claude Code on this host and probe again.');
    }

    if (withReprobe && typeof this.api.probeHost === 'function') {
      const row = document.createElement('div');
      row.className = 'host-form__row';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dialog__btn dialog__btn--secondary';
      btn.dataset.testid = `probe-again-${host.id}`;
      btn.textContent = 'Probe again';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Probing…';
        try {
          const fresh = await this.api.probeHost(host.id);
          if (typeof this.state.setHosts === 'function') {
            this.state.setHosts(this._hosts().map(h => (h.id === fresh.id ? fresh : h)));
          }
        } catch (err) {
          this.log.warn('Probe failed:', err);
        }
        this._renderGeneralTab();
      });
      row.appendChild(btn);
      card.appendChild(row);
    }
    return card;
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
        host_id: this._hostId || '',
        allowed_mcp_ids: this._hostId ? [] : Array.from(this._selectedMcpIds),
        allowed_models: Array.from(this._selectedModels),
        permission_policy: this._serializePolicy(),
      };
      if (this._templatesDirty) {
        body.chat_templates = this._templates.map(t => ({
          id: t.id,
          name: t.name,
          model: t.model,
          mode: t.mode || MODE_TEXT,
          voice: t.voice || '',
          system_prompt: t.systemPrompt || '',
          append_claude_md: !!t.appendClaudeMd,
          use_relay_tools: !!t.useRelayTools,
        }));
      }
      if (this._shellTemplatesDirty) {
        body.shell_templates = this._shellTemplates.map(t => ({
          id: t.id,
          name: t.name,
          command: t.command || '',
          args: t.args || [],
          env: t.env || {},
          description: t.description || '',
          icon: t.icon || '',
        }));
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
      const existing = this._panel.querySelector('.project-dialog__error');
      if (existing) existing.remove();
      const errEl = document.createElement('div');
      errEl.className = 'project-dialog__error';
      errEl.textContent = err?.message
        ? `Failed to save project: ${err.message}`
        : 'Failed to save project. Please try again.';
      this._tabContent.prepend(errEl);
      errEl.scrollIntoView({ block: 'nearest' });
    }
  }

  _renderPermissionsTab() {
    const form = document.createElement('div');
    form.className = 'project-dialog__form';

    const intro = document.createElement('div');
    intro.className = 'field-hint';
    intro.textContent = 'Per-project Claude permission policy. Applied to every new session in this project.';
    form.appendChild(intro);

    const modeLabel = document.createElement('label');
    modeLabel.className = 'dialog__label';
    modeLabel.textContent = 'Default permission mode';
    form.appendChild(modeLabel);

    const modes = [
      { value: 'default', label: 'Default — prompt for every tool' },
      { value: 'acceptEdits', label: 'Accept edits — auto-approve file edits' },
      { value: 'plan', label: 'Plan — research/plan only, no edits until approved' },
      { value: 'bypassPermissions', label: 'Bypass — auto-approve everything (dangerous)' },
    ];
    const modeList = document.createElement('div');
    modeList.className = 'project-dialog__checkbox-list';
    const currentMode = this._policy.default_mode || 'default';
    for (const m of modes) {
      const radio = this._createRadio(modeList, 'projectPermissionMode', m.value, m.label, currentMode === m.value);
      radio.addEventListener('change', () => {
        if (radio.checked) this._policy.default_mode = m.value;
      });
    }
    form.appendChild(modeList);

    form.appendChild(this._renderToolList(
      'Auto-allow tools',
      'One pattern per line. Examples: Read, Grep, Glob, Bash:ls *',
      this._policy.allowed_tools,
      (lines) => { this._policy.allowed_tools = lines; },
    ));

    form.appendChild(this._renderToolList(
      'Auto-deny tools',
      'One pattern per line. Denies override allows.',
      this._policy.denied_tools,
      (lines) => { this._policy.denied_tools = lines; },
    ));

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
        this._saveProject(this._project.name, this._project.path);
      });
      actions.appendChild(cancelBtn);
      actions.appendChild(saveBtn);
      form.appendChild(actions);
    } else {
      const note = document.createElement('div');
      note.className = 'field-hint';
      note.textContent = 'Fill in name and path on the General tab, then click Create Project — these settings will be saved with it.';
      form.appendChild(note);
    }

    this._tabContent.appendChild(form);
  }

  _renderToolList(label, hint, initialLines, onChange) {
    const wrap = document.createElement('div');
    const lbl = document.createElement('label');
    lbl.className = 'dialog__label';
    lbl.textContent = label;
    wrap.appendChild(lbl);

    const ta = document.createElement('textarea');
    ta.className = 'dialog__input project-dialog__textarea';
    ta.rows = 4;
    ta.value = (initialLines || []).join('\n');
    ta.addEventListener('input', () => {
      const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      onChange(lines);
    });
    wrap.appendChild(ta);

    const h = document.createElement('span');
    h.className = 'field-hint';
    h.textContent = hint;
    wrap.appendChild(h);
    return wrap;
  }

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
        useRelayTools: false,
      });
      this._editingTemplateIdx = this._templates.length - 1;
      this._showTab('templates');
    });
    container.appendChild(addBtn);

    const shellHeader = document.createElement('div');
    shellHeader.className = 'project-dialog__section-title';
    shellHeader.textContent = 'Shell Templates';
    container.appendChild(shellHeader);

    if (this._shellTemplates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'project-dialog__empty';
      empty.textContent = 'No project shell templates yet.';
      container.appendChild(empty);
    } else {
      for (const tmpl of this._shellTemplates) {
        container.appendChild(this._renderShellTemplateItem(tmpl));
      }
    }

    const addShellBtn = document.createElement('button');
    addShellBtn.className = 'dialog__btn dialog__btn--primary project-dialog__add-btn';
    addShellBtn.textContent = '+ Add Shell Template';
    addShellBtn.addEventListener('click', () => {
      this._editingShellTemplate = { id: null, name: '', command: '', args: [], env: {}, description: '', icon: '' };
      this._showTab('templates');
    });
    container.appendChild(addShellBtn);

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

    // Hidden for Claude models and force-cleared below regardless of checkbox
    // state: Claude reads CLAUDE.md natively, and although relayLLM's
    // ClaudeProvider does wire useRelayTools into --mcp-config
    // (relayMCPConfigJSON in relayLLM/provider_claude.go), this UI never
    // offers the option for Claude models.
    const { wrapper: relayToolsWrapper, check: relayToolsCheck } = this._checkboxRow(
      'Use Relay Tools (mail, calendar, contacts, web search)', !!tmpl.useRelayTools);
    const { wrapper: claudeMdWrapper, check: claudeMdCheck } = this._checkboxRow(
      'Append CLAUDE.md to system prompt', !!tmpl.appendClaudeMd);
    form.append(relayToolsWrapper, claudeMdWrapper);

    const isClaude = () => isClaudeModel(this.state.models, modelSelect.value);
    const updateClaudeOnlyRows = () => {
      const display = isClaude() ? 'none' : '';
      relayToolsWrapper.style.display = display;
      claudeMdWrapper.style.display = display;
    };
    modelSelect.addEventListener('change', updateClaudeOnlyRows);
    updateClaudeOnlyRows();

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

      this._templatesDirty = true;
      this._templates[idx] = {
        id: tmpl.id,
        name,
        model: modelSelect.value,
        mode: voiceRadio.checked ? MODE_VOICE : MODE_TEXT,
        voice: voiceRadio.checked ? voiceSelect.value : '',
        systemPrompt: promptArea.value.trim(),
        appendClaudeMd: claudeMdCheck.checked && !isClaude(),
        useRelayTools: relayToolsCheck.checked && !isClaude(),
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
    deleteBtn.addEventListener('click', () => {
      this._shellTemplates = this._shellTemplates.filter(t => t.id !== tmpl.id);
      this._shellTemplatesDirty = true;
      this._showTab('templates');
    });

    actions.appendChild(editBtn);
    actions.appendChild(deleteBtn);

    item.appendChild(info);
    item.appendChild(actions);
    return item;
  }

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
    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      const cmdLine = cmdInput.value.trim();
      if (!name || !cmdLine) { (name ? cmdInput : nameInput).focus(); return; }

      const { command, args } = this._parseCommandLine(cmdLine);
      // relay doesn't mint an id for project-scoped templates, so the client
      // generates one. env/icon aren't editable in this form — carry them
      // over from the working-copy entry so an edit doesn't drop them.
      const entry = {
        id: tmpl.id || crypto.randomUUID(),
        name,
        command,
        args,
        env: tmpl.env || {},
        description: descInput.value.trim(),
        icon: tmpl.icon || '',
      };
      const idx = this._shellTemplates.findIndex(t => t.id === entry.id);
      if (idx >= 0) this._shellTemplates[idx] = entry;
      else this._shellTemplates.push(entry);
      this._shellTemplatesDirty = true;
      this._editingShellTemplate = null;
      this._showTab('templates');
    });

    actions.appendChild(backBtn);
    actions.appendChild(saveBtn);
    form.appendChild(actions);

    container.appendChild(form);
    nameInput.focus();
  }

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

  _checkboxRow(label, checked) {
    const wrapper = document.createElement('div');
    const row = document.createElement('label');
    row.className = 'project-dialog__checkbox-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = checked;
    const text = document.createElement('span');
    text.textContent = label;
    row.append(check, text);
    wrapper.appendChild(row);
    return { wrapper, check };
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
