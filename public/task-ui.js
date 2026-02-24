/**
 * Task scheduling UI: task CRUD, schedule config, task history,
 * task result display, sidebar task rendering.
 */
class TaskUI {
  constructor(app) {
    this.app = app;
    this.scheduledTasks = [];
    this.taskHistory = new Map(); // projectId:taskId -> executions
    this.editingTask = null; // { projectId, taskId } when editing
    this.currentTasksProjectId = null;
  }

  initEventListeners() {
    const el = this.app.elements;

    if (el.newTaskBtn) {
      el.newTaskBtn.addEventListener('click', () => this.showTaskForm());
    }
    if (el.taskForm) {
      el.taskForm.addEventListener('submit', (e) => this.handleTaskFormSubmit(e));
    }
    if (el.taskScheduleType) {
      el.taskScheduleType.addEventListener('change', () => this.renderScheduleConfig());
    }
    if (el.taskDeleteBtn) {
      el.taskDeleteBtn.addEventListener('click', () => this.handleTaskDelete());
    }
  }

  // --- Data loading ---

  async loadScheduledTasks() {
    try {
      const response = await fetch('/api/tasks', {
        headers: this.app.getAuthHeaders()
      });
      this.scheduledTasks = await response.json();
      this.app.sidebarRenderer.renderProjectList();
    } catch (err) {
      console.error('Failed to load scheduled tasks:', err);
    }
  }

  async loadTaskHistory(projectId, taskId) {
    try {
      const response = await fetch(`/api/tasks/${projectId}/${taskId}/history`, {
        headers: this.app.getAuthHeaders()
      });
      const history = await response.json();
      this.taskHistory.set(`${projectId}:${taskId}`, history);
      return history;
    } catch (err) {
      console.error('Failed to load task history:', err);
      return [];
    }
  }

  // --- Event handlers from server ---

  handleTaskStarted(data) {
    this.app.messageRenderer.appendSystemMessage(`Task started: ${data.taskName} (${data.projectName})`);
    const task = this.scheduledTasks.find(t => t.projectId === data.projectId && t.id === data.taskId);
    if (task) {
      task.lastStatus = 'running';
      this.app.sidebarRenderer.renderProjectList();
    }
  }

  handleTaskCompleted(data) {
    this.app.messageRenderer.appendSystemMessage(`Task completed: ${data.taskName}`);
    const task = this.scheduledTasks.find(t => t.projectId === data.projectId && t.id === data.taskId);
    if (task) {
      task.lastStatus = 'success';
    }
    this.taskHistory.delete(`${data.projectId}:${data.taskId}`);

    const taskTabId = `task:${data.projectId}:${data.taskId}`;
    if (this.app.tabManager && this.app.tabManager.activeTabId === taskTabId) {
      this.showTaskResult(data.projectId, data.taskId);
    }

    if (!this.app.elements.tasksModal?.classList.contains('hidden')) {
      this.showTasksPanel(data.projectId);
    }

    this.app.sidebarRenderer.renderProjectList();
  }

  handleTaskFailed(data) {
    this.app.messageRenderer.appendSystemMessage(`Task failed: ${data.taskName} - ${data.error}`, 'error');
    const task = this.scheduledTasks.find(t => t.projectId === data.projectId && t.id === data.taskId);
    if (task) {
      task.lastStatus = 'error';
    }
    this.taskHistory.delete(`${data.projectId}:${data.taskId}`);

    const taskTabId = `task:${data.projectId}:${data.taskId}`;
    if (this.app.tabManager && this.app.tabManager.activeTabId === taskTabId) {
      this.showTaskResult(data.projectId, data.taskId);
    }

    this.app.sidebarRenderer.renderProjectList();
  }

  // --- Task panel ---

  getTaskCountForProject(projectId) {
    return this.scheduledTasks.filter(t => t.projectId === projectId).length;
  }

  showTasksPanel(projectId) {
    const project = this.app.projects.get(projectId);
    if (!project) return;

    this.currentTasksProjectId = projectId;
    this.app.elements.tasksProjectName.textContent = project.name;
    this.app.elements.tasksModal.classList.remove('hidden');
    this.app.elements.taskHistorySection.classList.add('hidden');

    this.renderTasksPanel(projectId);
  }

  showTaskForm(task = null) {
    this.populateTaskModelSelect();
    const el = this.app.elements;

    if (task) {
      this.editingTask = { projectId: this.currentTasksProjectId, taskId: task.id };
      el.taskFormTitle.textContent = 'Edit Task';
      el.taskNameInput.value = task.name;
      el.taskPromptInput.value = task.prompt || '';
      el.taskScheduleType.value = task.schedule?.type || 'daily';
      el.taskModelSelect.value = task.model || '';
      el.taskArgsInput.value = (task.args || []).join(' ');
      el.taskEnabledCheck.checked = task.enabled !== false;
      el.taskDeleteBtn.classList.remove('hidden');
    } else {
      this.editingTask = null;
      el.taskFormTitle.textContent = 'New Task';
      el.taskNameInput.value = '';
      el.taskPromptInput.value = '';
      el.taskScheduleType.value = 'daily';
      el.taskModelSelect.value = '';
      el.taskArgsInput.value = '';
      el.taskEnabledCheck.checked = true;
      el.taskDeleteBtn.classList.add('hidden');
    }

    this.renderScheduleConfig(task?.schedule);
    el.taskFormModal.classList.remove('hidden');
    el.taskNameInput.focus();
  }

  populateTaskModelSelect() {
    const select = this.app.elements.taskModelSelect;
    select.innerHTML = '<option value="">Use project default</option>';

    const groups = {};
    for (const model of this.app.models) {
      if (!groups[model.group]) groups[model.group] = [];
      groups[model.group].push(model);
    }

    for (const [groupName, models] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupName;
      for (const model of models) {
        const option = document.createElement('option');
        option.value = model.value;
        option.textContent = model.label;
        optgroup.appendChild(option);
      }
      select.appendChild(optgroup);
    }
  }

  renderScheduleConfig(schedule = null) {
    const type = this.app.elements.taskScheduleType.value;
    const container = this.app.elements.taskScheduleConfig;

    switch (type) {
      case 'daily':
        container.innerHTML = `
          <label for="taskScheduleTime">Time (HH:MM)</label>
          <input type="time" id="taskScheduleTime" value="${schedule?.time || '09:00'}">
        `;
        break;
      case 'hourly':
        container.innerHTML = `
          <label for="taskScheduleMinute">Minute of hour</label>
          <input type="number" id="taskScheduleMinute" min="0" max="59" value="${schedule?.minute ?? 0}">
        `;
        break;
      case 'interval':
        container.innerHTML = `
          <label for="taskScheduleMinutes">Every N minutes</label>
          <input type="number" id="taskScheduleMinutes" min="1" value="${schedule?.minutes || 60}">
        `;
        break;
      case 'weekly':
        container.innerHTML = `
          <label for="taskScheduleDay">Day of week</label>
          <select id="taskScheduleDay">
            ${['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map(d =>
              `<option value="${d.toLowerCase()}" ${(schedule?.day || 'monday') === d.toLowerCase() ? 'selected' : ''}>${d}</option>`
            ).join('')}
          </select>
          <label for="taskScheduleTime">Time (HH:MM)</label>
          <input type="time" id="taskScheduleTime" value="${schedule?.time || '09:00'}">
        `;
        break;
      case 'cron':
        container.innerHTML = `
          <label for="taskScheduleCron">Cron expression (min hour day month weekday)</label>
          <input type="text" id="taskScheduleCron" placeholder="0 9 * * *" value="${schedule?.expression || ''}">
        `;
        break;
    }
  }

  getScheduleFromForm() {
    const type = this.app.elements.taskScheduleType.value;
    switch (type) {
      case 'daily':
        return { type: 'daily', time: document.getElementById('taskScheduleTime')?.value || '09:00' };
      case 'hourly':
        return { type: 'hourly', minute: parseInt(document.getElementById('taskScheduleMinute')?.value || '0') };
      case 'interval':
        return { type: 'interval', minutes: parseInt(document.getElementById('taskScheduleMinutes')?.value || '60') };
      case 'weekly':
        return {
          type: 'weekly',
          day: document.getElementById('taskScheduleDay')?.value || 'monday',
          time: document.getElementById('taskScheduleTime')?.value || '09:00'
        };
      case 'cron':
        return { type: 'cron', expression: document.getElementById('taskScheduleCron')?.value || '' };
      default:
        return { type: 'daily', time: '09:00' };
    }
  }

  async handleTaskFormSubmit(e) {
    e.preventDefault();
    const projectId = this.currentTasksProjectId;
    if (!projectId) return;

    const taskData = {
      name: this.app.elements.taskNameInput.value.trim(),
      prompt: this.app.elements.taskPromptInput.value.trim(),
      schedule: this.getScheduleFromForm(),
      model: this.app.elements.taskModelSelect.value || null,
      args: this.app.parseArgsString(this.app.elements.taskArgsInput.value),
      enabled: this.app.elements.taskEnabledCheck.checked
    };

    try {
      if (this.editingTask) {
        await fetch(`/api/tasks/${projectId}/${this.editingTask.taskId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...this.app.getAuthHeaders() },
          body: JSON.stringify(taskData)
        });
      } else {
        await fetch(`/api/tasks/${projectId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.app.getAuthHeaders() },
          body: JSON.stringify(taskData)
        });
      }

      this.app.modalManager.hideTaskForm();
      await this.loadScheduledTasks();
      this.renderTasksPanel(projectId);
    } catch (err) {
      console.error('Failed to save task:', err);
    }
  }

  handleTaskDelete() {
    if (!this.editingTask) return;
    const { projectId, taskId } = this.editingTask;

    this.app.modalManager.hideTaskForm();
    this.app.modalManager.showConfirmModal('Delete this task? This cannot be undone.', async () => {
      try {
        await fetch(`/api/tasks/${projectId}/${taskId}`, {
          method: 'DELETE',
          headers: this.app.getAuthHeaders()
        });
        await this.loadScheduledTasks();
        this.renderTasksPanel(projectId);
      } catch (err) {
        console.error('Failed to delete task:', err);
      }
    });
  }

  renderTasksPanel(projectId) {
    const escapeHtml = (t) => this.app.messageRenderer.escapeHtml(t);
    const tasks = this.scheduledTasks.filter(t => t.projectId === projectId);

    if (tasks.length === 0) {
      this.app.elements.tasksList.innerHTML = `
        <div class="tasks-empty">
          No scheduled tasks. Click "New Task" to create one.
        </div>
      `;
      return;
    }

    this.app.elements.tasksList.innerHTML = tasks.map(task => `
      <div class="task-item task-item-clickable" data-task-id="${task.id}">
        <div class="task-info" data-action="edit">
          <div class="task-name">${escapeHtml(task.name)}</div>
          <div class="task-schedule">${this.formatSchedule(task.schedule)}</div>
          ${task.nextRun ? `<div class="task-next-run">Next: ${this.formatRelativeTime(task.nextRun)}</div>` : ''}
        </div>
        <div class="task-actions">
          <label class="task-toggle">
            <input type="checkbox" ${task.enabled ? 'checked' : ''} data-action="toggle">
            <span class="toggle-slider"></span>
          </label>
          <button class="task-run-btn" data-action="run" title="Run now">&#9654;</button>
          <button class="task-history-btn" data-action="history" title="View history">&#128337;</button>
        </div>
      </div>
    `).join('');

    this.app.elements.tasksList.querySelectorAll('.task-item').forEach(item => {
      const taskId = item.dataset.taskId;
      const task = tasks.find(t => t.id === taskId);

      item.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
        if (task) this.showTaskForm(task);
      });

      item.querySelector('[data-action="toggle"]')?.addEventListener('change', (e) => {
        this.handleTaskToggle(projectId, taskId, e.target.checked);
      });

      item.querySelector('[data-action="run"]')?.addEventListener('click', () => {
        this.handleTaskRun(projectId, taskId);
      });

      item.querySelector('[data-action="history"]')?.addEventListener('click', () => {
        this.showTaskHistory(projectId, taskId);
      });
    });
  }

  // --- Task actions ---

  async handleTaskToggle(projectId, taskId, enabled) {
    try {
      await fetch(`/api/tasks/${projectId}/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...this.app.getAuthHeaders() },
        body: JSON.stringify({ enabled })
      });
      await this.loadScheduledTasks();
      this.renderTasksPanel(projectId);
    } catch (err) {
      console.error('Failed to toggle task:', err);
    }
  }

  async handleTaskRun(projectId, taskId) {
    try {
      await fetch(`/api/tasks/${projectId}/${taskId}/run`, {
        method: 'POST',
        headers: this.app.getAuthHeaders()
      });
      this.app.messageRenderer.appendSystemMessage('Task execution started...');
    } catch (err) {
      console.error('Failed to run task:', err);
      this.app.messageRenderer.appendSystemMessage('Failed to start task', 'error');
    }
  }

  async showTaskHistory(projectId, taskId) {
    const history = await this.loadTaskHistory(projectId, taskId);
    this.renderTaskHistory(history);
    this.app.elements.taskHistorySection.classList.remove('hidden');
  }

  renderTaskHistory(history) {
    const escapeHtml = (t) => this.app.messageRenderer.escapeHtml(t);

    if (!history || history.length === 0) {
      this.app.elements.taskHistoryList.innerHTML = '<div class="task-history-empty">No execution history</div>';
      return;
    }

    this.app.elements.taskHistoryList.innerHTML = history.slice(0, 20).map(exec => `
      <div class="task-history-item task-status-${exec.status}">
        <div class="task-history-time">${new Date(exec.startedAt).toLocaleString()}</div>
        <div class="task-history-status">${exec.status}</div>
        ${exec.error ? `<div class="task-history-error">${escapeHtml(exec.error)}</div>` : ''}
        ${exec.response ? `<div class="task-history-response">${escapeHtml(exec.response.substring(0, 200))}${exec.response.length > 200 ? '...' : ''}</div>` : ''}
      </div>
    `).join('');
  }

  // --- Task result tab ---

  async openTaskResult(projectId, taskId, taskName) {
    const historyKey = `${projectId}:${taskId}`;
    if (!this.taskHistory.has(historyKey)) {
      await this.loadTaskHistory(projectId, taskId);
    }
    this.app.tabManager.openTask(projectId, taskId, taskName);
  }

  showTaskResult(projectId, taskId) {
    const escapeHtml = (t) => this.app.messageRenderer.escapeHtml(t);
    const task = this.scheduledTasks.find(t => t.projectId === projectId && t.id === taskId);
    const historyKey = `${projectId}:${taskId}`;
    const history = this.taskHistory.get(historyKey) || [];

    this.app.elements.taskResultName.textContent = task?.name || 'Task';

    if (history.length === 0) {
      this.app.elements.taskResultMeta.innerHTML = '';
      this.app.elements.taskResultBody.innerHTML = '<div class="task-result-empty">No executions yet</div>';
      return;
    }

    const latest = history[0];
    const statusClass = latest.status === 'success' ? 'status-success' :
                        latest.status === 'error' ? 'status-error' : 'status-running';
    const startTime = new Date(latest.startedAt).toLocaleString();
    const endTime = latest.completedAt ? new Date(latest.completedAt).toLocaleString() : 'In progress';

    this.app.elements.taskResultMeta.innerHTML = `
      <span class="task-meta-item">
        <span class="task-meta-status ${statusClass}">${latest.status}</span>
      </span>
      <span class="task-meta-item">Started: ${startTime}</span>
      ${latest.completedAt ? `<span class="task-meta-item">Completed: ${endTime}</span>` : ''}
    `;

    let bodyHtml = '';
    if (latest.error) {
      bodyHtml += `<div class="task-result-error">${escapeHtml(latest.error)}</div>`;
    }
    if (latest.response) {
      bodyHtml += escapeHtml(latest.response);
    }
    if (!latest.error && !latest.response) {
      bodyHtml = '<div class="task-result-empty">No output</div>';
    }

    this.app.elements.taskResultBody.innerHTML = bodyHtml;
  }

  getTaskStatusInfo(task) {
    const historyKey = `${task.projectId}:${task.id}`;
    const history = this.taskHistory.get(historyKey);

    if (task.lastStatus === 'running') {
      return { className: 'status-running', label: 'Running' };
    }

    if (history && history.length > 0) {
      const latest = history[0];
      if (latest.status === 'success') return { className: 'status-success', label: 'OK' };
      if (latest.status === 'error') return { className: 'status-error', label: 'Failed' };
      if (latest.status === 'running') return { className: 'status-running', label: 'Running' };
    }

    if (task.lastStatus === 'success') return { className: 'status-success', label: 'OK' };
    if (task.lastStatus === 'error') return { className: 'status-error', label: 'Failed' };

    return { className: 'status-pending', label: 'Pending' };
  }

  // --- Formatting ---

  formatSchedule(schedule) {
    if (!schedule) return 'No schedule';
    switch (schedule.type) {
      case 'daily': return `Daily at ${schedule.time || '00:00'}`;
      case 'hourly': return `Hourly at :${String(schedule.minute || 0).padStart(2, '0')}`;
      case 'interval': return `Every ${schedule.minutes} minutes`;
      case 'weekly': return `${schedule.day} at ${schedule.time || '00:00'}`;
      case 'cron': return `Cron: ${schedule.expression}`;
      default: return 'Unknown schedule';
    }
  }

  formatRelativeTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = date - now;
    const diffMins = Math.round(diffMs / 60000);

    if (diffMins < 0) return 'overdue';
    if (diffMins < 1) return 'less than a minute';
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''}`;

    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''}`;

    const diffDays = Math.round(diffHours / 24);
    return `${diffDays} day${diffDays !== 1 ? 's' : ''}`;
  }
}
