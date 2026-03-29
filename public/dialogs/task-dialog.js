/**
 * TaskDialog - task management with Tasks and New tabs.
 * Lists existing tasks, supports run/edit/delete/join, and create new.
 */
class TaskDialog extends DialogBase {
  constructor(container) {
    super(container, 'task-dialog');
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
  }

  async _loadAndShow() {
    try {
      const tasks = await this.api.getTasks(this.projectId);
      this._tasks = Array.isArray(tasks) ? tasks : [];
    } catch { this._tasks = []; }
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

    // Header
    const titleBar = document.createElement('div');
    titleBar.className = 'dialog__title-bar';

    const title = document.createElement('h3');
    title.className = 'dialog__title';
    title.textContent = 'Tasks';

    const badge = document.createElement('span');
    badge.className = 'dialog__badge';
    badge.textContent = projectName;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialog__close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.hide());

    titleBar.appendChild(title);
    titleBar.appendChild(badge);
    titleBar.appendChild(closeBtn);
    this._panel.appendChild(titleBar);

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
    this._tabContent.innerHTML = '';
    if (tabName === 'tasks') {
      this._renderTasksList();
    } else {
      this._renderNewForm();
    }
  }

  _renderTasksList() {
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
      const status = document.createElement('span');
      status.className = `task-dialog__status task-dialog__status--${task.lastResult?.status || 'none'}`;
      status.textContent = task.lastResult?.status || (task.enabled ? 'ready' : 'disabled');

      // Actions row
      const actions = document.createElement('div');
      actions.className = 'task-dialog__actions';

      const runBtn = this._actionBtn('Run', () => this._runTask(task));
      actions.appendChild(runBtn);

      if (task.lastResult?.sessionId) {
        const joinBtn = this._actionBtn('Join Last', () => this._joinSession(task.lastResult.sessionId));
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
    const editTask = this._editTaskId
      ? this._tasks.find(t => t.id === this._editTaskId)
      : null;

    const form = document.createElement('div');
    form.className = 'task-dialog__form';

    // Name
    form.appendChild(this._formField('Task Name', 'text', 'taskName', editTask?.name || '', 'Daily summary'));

    // Prompt
    const promptLabel = document.createElement('label');
    promptLabel.className = 'dialog__label';
    promptLabel.textContent = 'Prompt';
    form.appendChild(promptLabel);
    const promptInput = document.createElement('textarea');
    promptInput.className = 'dialog__textarea';
    promptInput.name = 'taskPrompt';
    promptInput.rows = 3;
    promptInput.placeholder = 'Summarize today\'s activity...';
    promptInput.value = editTask?.prompt || '';
    form.appendChild(promptInput);

    // Model
    const modelLabel = document.createElement('label');
    modelLabel.className = 'dialog__label';
    modelLabel.textContent = 'Model';
    form.appendChild(modelLabel);
    const modelSelect = document.createElement('select');
    modelSelect.className = 'dialog__select';
    modelSelect.name = 'taskModel';
    for (const m of this.state.models) {
      const opt = document.createElement('option');
      opt.value = m.value;
      opt.textContent = m.label;
      if (editTask?.model === m.value) opt.selected = true;
      modelSelect.appendChild(opt);
    }
    form.appendChild(modelSelect);

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
      const data = {
        name: form.querySelector('[name="taskName"]').value,
        prompt: form.querySelector('[name="taskPrompt"]').value,
        model: form.querySelector('[name="taskModel"]').value,
        projectId: this.projectId,
        schedule: { type: form.querySelector('[name="scheduleType"]').value },
        enabled: form.querySelector('[name="taskEnabled"]').checked,
      };
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
      await this.api.runTask(task.id);
      this.hide();
    } catch (err) {
      console.error('Failed to run task:', err);
    }
  }

  _joinSession(sessionId) {
    this.hide();
    const app = this.container.get('app');
    app.joinSession(sessionId);
  }

  async _deleteTask(task) {
    if (!confirm(`Delete task "${task.name}"?`)) return;
    try {
      await this.api.deleteTask(task.id);
      this._tasks = this._tasks.filter(t => t.id !== task.id);
      this._switchTab('tasks');
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }

  async _createTask(data) {
    try {
      await this.api.createTask(data);
      this.hide();
    } catch (err) {
      console.error('Failed to create task:', err);
    }
  }

  async _updateTask(id, data) {
    try {
      await this.api.updateTask(id, data);
      this._editTaskId = null;
      this.hide();
    } catch (err) {
      console.error('Failed to update task:', err);
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
