/**
 * Tokenize an "extra args" input string, honoring "double quoted" and
 * 'single quoted' substrings so users can pass shell commands like
 *   -c "npm test"
 * as two args ("-c", "npm test") rather than three.
 */
function parseExtraArgs(input) {
  if (!input) return [];
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * TaskDialog - task management with Tasks and New tabs.
 * Lists existing tasks, supports run/edit/delete/join, and create new.
 */
class TaskDialog extends DialogBase {
  constructor(container) {
    super(container, 'task-dialog');
    this.log = container.get('logger').child('TaskDialog');
    this.state = container.get('state');
    this.api = container.get('api');
    this.projectId = null;
    this._tasks = [];
    this._editTaskId = null;
  }

  init() {
    this.bus.on(EVT.DIALOG_TASK, (data) => {
      this.projectId = data.projectId;
      this._editTaskId = data.editTaskId || null;
      this._loadAndShow();
    });
    // Live-refresh while open: a scheduled task firing in the background
    // bumps task.view in state. Re-render the Tasks tab
    // so "View Last Run" points at the newest run, not the snapshot from
    // when the dialog opened.
    const refresh = () => {
      if (!this.isVisible) return;
      if (this._activeTab === 'tasks') this._renderTasksList();
    };
    this.bus.on(EVT.TASKS_LOADED, refresh);
    this.bus.on(EVT.TASK_UPDATED, refresh);
  }

  _loadAndShow() {
    this._tasks = this.state.getTasksForProject(this.projectId);
    this.render();
    this.show();
    if (this._editTaskId) {
      this._switchTab('new');
    }
  }

  render() {
    const project = this.state.getProject(this.projectId);
    const projectName = project?.name || 'Unknown';

    this._panel.innerHTML = '';
    this._panel.style.maxWidth = '520px';

    this._panel.appendChild(this._createTitleBar('Tasks', projectName));

    // Tabs
    const { header, setActiveTab } = this._createTabs(
      [{ name: 'tasks', label: 'Tasks' }, { name: 'new', label: 'New' }],
      (tab) => this._switchTab(tab)
    );
    this._panel.appendChild(header);
    this._setActiveTab = setActiveTab;

    // Content container
    this._tabContent = document.createElement('div');
    this._tabContent.className = 'dialog__tab-content';
    this._panel.appendChild(this._tabContent);

    this._switchTab('tasks');
  }

  _switchTab(tabName) {
    if (this._setActiveTab) this._setActiveTab(tabName);
    this._activeTab = tabName;
    this._tabContent.innerHTML = '';
    if (tabName === 'tasks') {
      this._renderTasksList();
    } else {
      this._renderNewForm();
    }
  }

  _renderTasksList() {
    // Always re-read from state. The dialog can stay open across multiple
    // runs of the same task, and the live-refresh subscription in init()
    // re-invokes this method on TASK_UPDATED. Reading state here keeps
    // closures below pinned to the latest IDs.
    this._tasks = this.state.getTasksForProject(this.projectId);
    if (this._tabContent) this._tabContent.innerHTML = '';
    if (this._tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'task-dialog__empty';
      empty.textContent = 'No tasks for this project.';
      this._tabContent.appendChild(empty);
      return;
    }

    for (const task of this._tasks) {
      const item = document.createElement('div');
      item.className = 'task-dialog__item';
      item.dataset.testid = `task-dialog-item-${task.id}`;

      // Info row
      const info = document.createElement('div');
      info.className = 'task-dialog__info';

      const name = document.createElement('div');
      name.className = 'task-dialog__name';
      name.textContent = task.name;

      const schedule = document.createElement('div');
      schedule.className = 'task-dialog__schedule';
      schedule.textContent = this._formatSchedule(task.schedule);

      info.appendChild(name);
      info.appendChild(schedule);

      // Status badge
      const lastStatus = task.lastStatus || task.lastResult?.status;
      const status = document.createElement('span');
      status.className = `task-dialog__status task-dialog__status--${lastStatus || 'none'}`;
      status.textContent = lastStatus || (task.enabled ? 'ready' : 'disabled');

      // Actions row
      const actions = document.createElement('div');
      actions.className = 'task-dialog__actions';

      const runBtn = this._actionBtn('Run', () => this._runTask(task));
      actions.appendChild(runBtn);

      // The TaskViewer module owns the interactive-vs-readonly dispatch.
      // We re-read the task from state at click time so a run completing
      // while the dialog is open still hands off to the newest run.
      const taskViewer = this.container.get('taskViewer');
      if (taskViewer.hasLastRun(task)) {
        const joinBtn = this._actionBtn('View Last Run', () => {
          const fresh = this.state.getTask(task.id) || task;
          this.hide();
          taskViewer.openLastRun(fresh);
        });
        actions.appendChild(joinBtn);
      }

      const editBtn = this._actionBtn('Edit', () => {
        this._editTaskId = task.id;
        this._switchTab('new');
      });
      actions.appendChild(editBtn);

      const deleteBtn = this._actionBtn('Delete', () => this._deleteTask(task), true);
      actions.appendChild(deleteBtn);

      item.appendChild(info);
      item.appendChild(status);
      item.appendChild(actions);
      this._tabContent.appendChild(item);
    }
  }

  _actionBtn(label, onClick, danger = false) {
    const btn = document.createElement('button');
    btn.className = `task-dialog__action-btn${danger ? ' task-dialog__action-btn--danger' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  _renderNewForm() {
    // Read directly from state so an edit-after-update sees the latest
    // server-confirmed shape rather than the dialog-open snapshot.
    const editTask = this._editTaskId ? this.state.getTask(this._editTaskId) : null;

    const form = document.createElement('div');
    form.className = 'task-dialog__form';

    // Name
    form.appendChild(this._formField('Task Name', 'text', 'taskName', editTask?.name || '', 'Daily summary'));

    // Type: chat vs terminal. Drives which fields below are visible.
    // Stored as task.sessionType ("" / "headless" → chat, "pty" → terminal).
    const typeLabel = document.createElement('label');
    typeLabel.className = 'dialog__label';
    typeLabel.textContent = 'Type';
    form.appendChild(typeLabel);
    const typeSelect = document.createElement('select');
    typeSelect.className = 'dialog__select';
    typeSelect.name = 'taskType';
    for (const [value, label] of [['headless', 'Chat (LLM)'], ['pty', 'Terminal (shell)']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      typeSelect.appendChild(opt);
    }
    typeSelect.value = editTask?.sessionType === 'pty' ? 'pty' : 'headless';
    form.appendChild(typeSelect);

    // --- Chat fields (Prompt + Model) ---
    const chatFields = document.createElement('div');
    chatFields.className = 'task-dialog__type-fields';

    const promptLabel = document.createElement('label');
    promptLabel.className = 'dialog__label';
    promptLabel.textContent = 'Prompt';
    chatFields.appendChild(promptLabel);
    const promptInput = document.createElement('textarea');
    promptInput.className = 'dialog__textarea';
    promptInput.name = 'taskPrompt';
    promptInput.rows = 3;
    promptInput.placeholder = 'Summarize today\'s activity...';
    promptInput.value = editTask?.prompt || '';
    chatFields.appendChild(promptInput);

    const modelLabel = document.createElement('label');
    modelLabel.className = 'dialog__label';
    modelLabel.textContent = 'Model';
    chatFields.appendChild(modelLabel);
    const modelSelect = document.createElement('select');
    renderModelSelect(modelSelect, this.state.modelsForProject(this.projectId), {
      className: 'dialog__select',
      name: 'taskModel',
      selectedValue: editTask?.model,
    });
    chatFields.appendChild(modelSelect);
    form.appendChild(chatFields);

    // --- Terminal fields (template + extraArgs + directory + timeout) ---
    const ptyFields = document.createElement('div');
    ptyFields.className = 'task-dialog__type-fields';

    const tplLabel = document.createElement('label');
    tplLabel.className = 'dialog__label';
    tplLabel.textContent = 'Template';
    ptyFields.appendChild(tplLabel);
    const tplSelect = document.createElement('select');
    tplSelect.className = 'dialog__select';
    tplSelect.name = 'taskTemplateId';
    // Populate from cached templates; if empty, ask the terminal manager to
    // refresh and re-render once they arrive.
    const populateTemplates = () => {
      tplSelect.innerHTML = '';
      const templates = this.state.terminalTemplates || [];
      if (templates.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no templates available)';
        tplSelect.appendChild(opt);
      }
      for (const t of templates) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name || t.id;
        if (editTask?.templateId === t.id) opt.selected = true;
        tplSelect.appendChild(opt);
      }
    };
    populateTemplates();
    if ((this.state.terminalTemplates || []).length === 0) {
      // Best-effort fetch via the API; will refresh on next dialog open.
      this.api.getTerminalTemplates?.().then(list => {
        if (list && list.length) {
          this.state.terminalTemplates = list;
          populateTemplates();
        }
      }).catch(() => { /* swallow — template list is non-critical */ });
    }
    ptyFields.appendChild(tplSelect);

    ptyFields.appendChild(this._formField(
      'Extra Args (space-separated, use quotes for grouped args)',
      'text', 'taskExtraArgs',
      Array.isArray(editTask?.extraArgs) ? editTask.extraArgs.join(' ') : '',
      '-c "npm test"',
    ));

    ptyFields.appendChild(this._formField(
      'Directory (optional, defaults to project path)',
      'text', 'taskDirectory',
      editTask?.directory || '',
      '/path/to/dir',
    ));

    ptyFields.appendChild(this._formField(
      'Timeout (minutes, 0 = use default 30)',
      'number', 'taskTimeoutMinutes',
      editTask?.maxDurationSeconds ? Math.round(editTask.maxDurationSeconds / 60) : '',
      '30',
    ));

    form.appendChild(ptyFields);

    // Show only the active type's fields. Re-renders on change.
    const refreshTypeFields = () => {
      const isPty = typeSelect.value === 'pty';
      chatFields.style.display = isPty ? 'none' : '';
      ptyFields.style.display = isPty ? '' : 'none';
    };
    typeSelect.addEventListener('change', refreshTypeFields);
    refreshTypeFields();

    // Schedule type
    const schedLabel = document.createElement('label');
    schedLabel.className = 'dialog__label';
    schedLabel.textContent = 'Schedule';
    form.appendChild(schedLabel);
    const schedSelect = document.createElement('select');
    schedSelect.className = 'dialog__select';
    schedSelect.name = 'scheduleType';
    for (const s of ['daily', 'hourly', 'interval', 'weekly', 'cron', 'once', 'on_demand']) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s.charAt(0).toUpperCase() + s.slice(1).replace('_', ' ');
      if (editTask?.schedule?.type === s) opt.selected = true;
      schedSelect.appendChild(opt);
    }
    form.appendChild(schedSelect);

    // Schedule config (dynamic based on type)
    const schedConfig = document.createElement('div');
    schedConfig.className = 'task-dialog__sched-config';
    form.appendChild(schedConfig);

    const renderScheduleConfig = () => {
      schedConfig.innerHTML = '';
      const type = schedSelect.value;
      const sched = editTask?.schedule || {};

      if (type === 'daily' || type === 'weekly') {
        const timeLbl = document.createElement('label');
        timeLbl.className = 'dialog__label';
        timeLbl.textContent = 'Time';
        const timeInput = document.createElement('input');
        timeInput.type = 'time';
        timeInput.name = 'schedTime';
        timeInput.value = sched.time || '09:00';
        timeInput.className = 'dialog__input';
        schedConfig.appendChild(timeLbl);
        schedConfig.appendChild(timeInput);
      }

      if (type === 'weekly') {
        const dayLbl = document.createElement('label');
        dayLbl.className = 'dialog__label';
        dayLbl.textContent = 'Day';
        const daySelect = document.createElement('select');
        daySelect.name = 'schedDay';
        daySelect.className = 'dialog__select';
        for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = d.charAt(0).toUpperCase() + d.slice(1);
          if (sched.day === d) opt.selected = true;
          daySelect.appendChild(opt);
        }
        schedConfig.appendChild(dayLbl);
        schedConfig.appendChild(daySelect);
      }

      if (type === 'hourly') {
        const minLbl = document.createElement('label');
        minLbl.className = 'dialog__label';
        minLbl.textContent = 'Minute';
        const minInput = document.createElement('input');
        minInput.type = 'number';
        minInput.name = 'schedMinute';
        minInput.min = '0';
        minInput.max = '59';
        minInput.value = sched.minute || '0';
        minInput.className = 'dialog__input';
        schedConfig.appendChild(minLbl);
        schedConfig.appendChild(minInput);
      }

      if (type === 'interval') {
        const intLbl = document.createElement('label');
        intLbl.className = 'dialog__label';
        intLbl.textContent = 'Interval (minutes)';
        const intInput = document.createElement('input');
        intInput.type = 'number';
        intInput.name = 'schedMinutes';
        intInput.min = '1';
        intInput.value = sched.minutes || '60';
        intInput.className = 'dialog__input';
        schedConfig.appendChild(intLbl);
        schedConfig.appendChild(intInput);
      }

      if (type === 'cron') {
        const cronLbl = document.createElement('label');
        cronLbl.className = 'dialog__label';
        cronLbl.textContent = 'Cron Expression';
        const cronInput = document.createElement('input');
        cronInput.type = 'text';
        cronInput.name = 'schedExpression';
        cronInput.value = sched.expression || '';
        cronInput.placeholder = '0 9 * * *';
        cronInput.className = 'dialog__input';
        schedConfig.appendChild(cronLbl);
        schedConfig.appendChild(cronInput);
      }

      if (type === 'once') {
        const dtLbl = document.createElement('label');
        dtLbl.className = 'dialog__label';
        dtLbl.textContent = 'Date & Time';
        const dtInput = document.createElement('input');
        dtInput.type = 'datetime-local';
        dtInput.name = 'schedDatetime';
        dtInput.value = sched.datetime || '';
        dtInput.className = 'dialog__input';
        schedConfig.appendChild(dtLbl);
        schedConfig.appendChild(dtInput);
      }
    };

    schedSelect.addEventListener('change', renderScheduleConfig);
    renderScheduleConfig();

    // Enabled checkbox
    const enabledRow = document.createElement('label');
    enabledRow.className = 'dialog__checkbox-row';
    const enabledCheck = document.createElement('input');
    enabledCheck.type = 'checkbox';
    enabledCheck.name = 'taskEnabled';
    enabledCheck.checked = editTask ? editTask.enabled : true;
    enabledRow.appendChild(enabledCheck);
    enabledRow.appendChild(document.createTextNode(' Enabled'));
    form.appendChild(enabledRow);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'dialog__actions';

    if (editTask) {
      const backBtn = document.createElement('button');
      backBtn.className = 'dialog__btn dialog__btn--secondary';
      backBtn.textContent = 'Back';
      backBtn.addEventListener('click', () => {
        this._editTaskId = null;
        this._switchTab('tasks');
      });
      actions.appendChild(backBtn);
    }

    const submitBtn = document.createElement('button');
    submitBtn.className = 'dialog__btn dialog__btn--primary';
    submitBtn.textContent = editTask ? 'Update Task' : 'Create Task';
    submitBtn.addEventListener('click', () => {
      const schedType = form.querySelector('[name="scheduleType"]').value;
      const schedule = { type: schedType };
      // Collect schedule config fields
      const time = form.querySelector('[name="schedTime"]');
      if (time) schedule.time = time.value;
      const day = form.querySelector('[name="schedDay"]');
      if (day) schedule.day = day.value;
      const minute = form.querySelector('[name="schedMinute"]');
      if (minute) schedule.minute = parseInt(minute.value, 10);
      const minutes = form.querySelector('[name="schedMinutes"]');
      if (minutes) schedule.minutes = parseInt(minutes.value, 10);
      const expression = form.querySelector('[name="schedExpression"]');
      if (expression) schedule.expression = expression.value;
      const datetime = form.querySelector('[name="schedDatetime"]');
      if (datetime) schedule.datetime = datetime.value;

      const sessionType = form.querySelector('[name="taskType"]').value;
      const data = {
        name: form.querySelector('[name="taskName"]').value,
        projectId: this.projectId,
        schedule,
        enabled: form.querySelector('[name="taskEnabled"]').checked,
        sessionType,
      };
      if (sessionType === 'pty') {
        data.templateId = form.querySelector('[name="taskTemplateId"]').value;
        // Tokenize extraArgs honoring "quoted strings" so users can pass
        // shell commands like  -c "npm test"  without the shell glueing them
        // back together.
        data.extraArgs = parseExtraArgs(form.querySelector('[name="taskExtraArgs"]').value);
        const dir = form.querySelector('[name="taskDirectory"]').value.trim();
        if (dir) data.directory = dir;
        const minutes = parseInt(form.querySelector('[name="taskTimeoutMinutes"]').value, 10);
        if (Number.isFinite(minutes) && minutes > 0) {
          data.maxDurationSeconds = minutes * 60;
        }
      } else {
        data.prompt = form.querySelector('[name="taskPrompt"]').value;
        data.model = form.querySelector('[name="taskModel"]').value;
      }
      if (editTask) {
        this._updateTask(editTask.id, data);
      } else {
        this._createTask(data);
      }
    });
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    this._tabContent.appendChild(form);
  }

  _formField(label, type, name, value, placeholder) {
    const wrapper = document.createDocumentFragment();
    const lbl = document.createElement('label');
    lbl.className = 'dialog__label';
    lbl.textContent = label;
    const input = document.createElement('input');
    input.type = type;
    input.name = name;
    input.value = value;
    input.placeholder = placeholder || '';
    input.className = 'dialog__input';
    wrapper.appendChild(lbl);
    wrapper.appendChild(input);
    return wrapper;
  }

  async _runTask(task) {
    try {
      // Mark as user-triggered so auto-join fires on task_completed
      this.container.get('taskManager').userTriggeredRuns.add(task.id);
      await this.api.runTask(task.id);
      this.hide();
    } catch (err) {
      this.log.error('Failed to run task:', err);
    }
  }

  async _deleteTask(task) {
    if (!confirm(`Delete task "${task.name}"?`)) return;
    // Route through TaskManager so StateStore stays in sync — that's what
    // emits TASKS_LOADED for the sidebar to re-render. Calling the API
    // directly leaves the sidebar showing stale data until refresh.
    await this.container.get('taskManager').deleteTask(task.id);
    // _renderTasksList re-reads from state, which TaskManager.deleteTask
    // has already pruned — no need to maintain a parallel local cache.
    this._switchTab('tasks');
  }

  async _createTask(data) {
    const task = await this.container.get('taskManager').createTask(data);
    if (task) this.hide();
  }

  async _updateTask(id, data) {
    const task = await this.container.get('taskManager').updateTask(id, data);
    if (task) {
      this._editTaskId = null;
      this.hide();
    }
  }

  _formatSchedule(schedule) {
    if (!schedule) return 'Not scheduled';
    switch (schedule.type) {
      case 'daily': return `Daily at ${schedule.time || '09:00'}`;
      case 'hourly': return `Hourly at :${schedule.minute || '00'}`;
      case 'weekly': return `Weekly ${schedule.day || 'mon'} at ${schedule.time || '09:00'}`;
      case 'cron': return `Cron: ${schedule.expression || ''}`;
      case 'interval': return `Every ${schedule.minutes || 60}m`;
      case 'once': return `Once at ${schedule.datetime || ''}`;
      case 'on_demand': return 'On demand';
      default: return schedule.type;
    }
  }
}
