/**
 * Modal lifecycle management: show/hide for all modals,
 * confirmation flow, permission prompts, input prompts.
 */
class ModalManager {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.confirmCallback = null;
    this.editingProjectId = null;
    this.editingTaskId = null;
    this.taskProjectId = null;
    this.pendingPermissionId = null;
    this.permissionQueue = [];
    this.planApprovalCallback = null;

    // Per-session "Allow All" bypass; cleared on session_ended.
    this.bypassedSessions = new Set();
  }

  initEventListeners() {
    const el = this.app.elements;

    // Escape key closes the topmost open modal
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (el.permissionModal && !el.permissionModal.classList.contains('hidden')) {
        this.respondToPermission(false);
      } else if (!el.confirmModal.classList.contains('hidden')) {
        this.hideConfirmModal();
      } else if (el.taskModal && !el.taskModal.classList.contains('hidden')) {
        this.hideTaskModal();
      } else if (!el.modal.classList.contains('hidden')) {
        this.hideSessionModal();
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    });

    // Session Modal
    el.cancelModal.addEventListener('click', () => this.hideSessionModal());
    el.modal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideSessionModal());

    // Confirmation modal
    el.cancelConfirm.addEventListener('click', () => this.hideConfirmModal());
    el.confirmModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideConfirmModal());
    el.confirmDelete.addEventListener('click', () => this.handleConfirm());

    // Permission modal
    if (el.permissionAllow) {
      el.permissionAllow.addEventListener('click', () => this.respondToPermission(true));
    }
    if (el.permissionAllowAll) {
      el.permissionAllowAll.addEventListener('click', () => this.respondToPermissionAll());
    }
    if (el.permissionDeny) {
      el.permissionDeny.addEventListener('click', () => this.respondToPermission(false));
    }
    if (el.permissionModal) {
      el.permissionModal.querySelector('.modal-backdrop').addEventListener('click', () => this.respondToPermission(false));
    }

    // Plan approval bar
    if (el.planApprove) {
      el.planApprove.addEventListener('click', () => this.respondToPlanApproval(true));
    }
    if (el.planRevise) {
      el.planRevise.addEventListener('click', () => this.respondToPlanApproval(false));
    }

    // Task modal
    if (el.cancelTaskModal) {
      el.cancelTaskModal.addEventListener('click', () => this.hideTaskModal());
    }
    if (el.taskModal) {
      el.taskModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideTaskModal());
    }
    if (el.taskScheduleType) {
      el.taskScheduleType.addEventListener('change', () => this.renderScheduleConfig());
    }
  }

  // --- Session modal ---

  showSessionModal(projectId = null) {
    const el = this.app.elements;
    el.modal.classList.remove('hidden');

    if (projectId && this.app.projects.has(projectId)) {
      el.projectSelect.value = projectId;
      const project = this.app.projects.get(projectId);
      el.directoryInput.value = project.path || '';
    }

    this.app.updateDirectoryInputRequirement();
    this.app.renderProviderSettings();
    el.directoryInput.focus();
    el.directoryInput.select();
  }

  hideSessionModal() {
    const el = this.app.elements;
    el.modal.classList.add('hidden');
    el.directoryInput.value = '';
    el.projectSelect.value = '';
    if (this.app.models.length > 0) {
      el.sessionModelSelect.value = this.app.models[0].value;
    }
    el.providerSettings.innerHTML = '';
    this.app.updateDirectoryInputRequirement();
  }

  // --- Confirm modal ---

  showConfirmModal(message, callback) {
    this.app.elements.confirmMessage.textContent = message;
    this.confirmCallback = callback;
    this.app.elements.confirmModal.classList.remove('hidden');
    this.app.elements.confirmDelete.focus();
  }

  hideConfirmModal() {
    this.app.elements.confirmModal.classList.add('hidden');
    this.confirmCallback = null;
  }

  handleConfirm() {
    if (this.confirmCallback) {
      this.confirmCallback();
    }
    this.hideConfirmModal();
  }

  // --- Permission modal ---

  showPermissionModal(data) {
    if (this._isSessionBypassed(data.sessionId)) {
      this._sendPermissionResponse(data.permissionId, true);
      return;
    }
    if (this.pendingPermissionId) {
      this.permissionQueue.push(data);
      return;
    }
    this._displayPermission(data);
  }

  _isSessionBypassed(sessionId) {
    return !!sessionId && this.bypassedSessions.has(sessionId);
  }

  _sendPermissionResponse(permissionId, approved) {
    if (!permissionId) return;
    this.app.wsClient.send({ type: 'permission_response', permissionId, approved });
  }

  clearSessionBypass(sessionId) {
    if (sessionId) this.bypassedSessions.delete(sessionId);
  }

  _displayPermission(data) {
    this.pendingPermissionId = data.permissionId;
    this.pendingPermissionToolUseId = data.toolUseId || null;
    this.app.elements.permissionToolName.textContent = data.toolName || 'Unknown';
    this.app.elements.permissionToolInput.textContent = data.toolInput || '';
    this.app.elements.permissionModal.classList.remove('hidden');
    this.app.elements.permissionAllow.focus();
    if (this.pendingPermissionToolUseId) {
      this.app.messageRenderer?.markToolPermissionPending(this.pendingPermissionToolUseId);
    }
  }

  hidePermissionModal() {
    this.app.elements.permissionModal.classList.add('hidden');
    if (this.pendingPermissionToolUseId) {
      this.app.messageRenderer?.clearToolPermissionPending(this.pendingPermissionToolUseId);
      this.pendingPermissionToolUseId = null;
    }
    this.pendingPermissionId = null;
  }

  respondToPermission(approved) {
    if (!this.pendingPermissionId) return;
    this.app.wsClient.send({
      type: 'permission_response',
      permissionId: this.pendingPermissionId,
      approved
    });
    this.hidePermissionModal();

    // Show next queued permission if any (or auto-approve when bypassed)
    while (this.permissionQueue.length > 0) {
      const next = this.permissionQueue.shift();
      if (this._isSessionBypassed(next.sessionId)) {
        this._sendPermissionResponse(next.permissionId, true);
        continue;
      }
      this._displayPermission(next);
      break;
    }
  }

  /** Approve current + mark session as bypassed; respondToPermission then
   *  drains the queue, honoring per-data sessionId for cross-session items. */
  respondToPermissionAll() {
    if (!this.pendingPermissionId) return;
    const sid = this.app.state?.currentSessionId;
    if (sid) this.bypassedSessions.add(sid);
    this.respondToPermission(true);
  }

  // --- Plan approval ---

  showPlanApproval(onRespond) {
    this.planApprovalCallback = onRespond;
    this.app.elements.planApprovalBar.classList.remove('hidden');
    this.app.elements.planApprove.focus();
  }

  hidePlanApproval() {
    if (!this.app.elements.planApprovalBar.classList.contains('hidden')) {
      this.app.elements.planApprovalBar.classList.add('hidden');
      this.app.elements.userInput.placeholder = 'Type your message...';
    }
    this.planApprovalCallback = null;
  }

  respondToPlanApproval(approved) {
    const callback = this.planApprovalCallback;
    this.hidePlanApproval();
    if (callback) callback(approved);
  }

  // --- Input prompt ---

  showPermissionPrompt(message) {
    this.app.elements.inputPrompt.classList.remove('hidden');
    this.app.elements.promptText.textContent = message;
    this.app.elements.userInput.placeholder = 'Type yes/no or your response...';
    this.app.elements.userInput.focus();
  }

  showInputPrompt(message) {
    this.app.elements.inputPrompt.classList.remove('hidden');
    this.app.elements.promptText.textContent = message;
    this.app.elements.userInput.focus();
  }

  hideInputPrompt() {
    this.app.elements.inputPrompt.classList.add('hidden');
    this.app.elements.userInput.placeholder = 'Type your message...';
  }

  // --- Task modal ---

  showTaskModal(projectId, taskId = null) {
    const el = this.app.elements;
    this.taskProjectId = projectId;
    this.editingTaskId = taskId;

    // Populate model dropdown (reuse app's model list), scoped to the task's
    // project so its allowed-model allowlist applies.
    this.app.renderModelSelect(el.taskModelSelect, projectId);

    if (taskId) {
      const task = this.app.state.getTask(taskId);
      if (!task) return;
      el.taskModalTitle.textContent = 'Edit Task';
      el.taskSubmitBtn.textContent = 'Save';
      el.taskNameInput.value = task.name;
      el.taskPromptInput.value = task.prompt;
      if (task.model) el.taskModelSelect.value = task.model;
      el.taskEnabledInput.checked = task.enabled;
      el.taskCatchUpInput.checked = task.catchUp || false;

      let schedule = task.schedule;
      if (typeof schedule === 'string') {
        try { schedule = JSON.parse(schedule); } catch { schedule = {}; }
      }
      el.taskScheduleType.value = schedule.type || 'daily';
      this.renderScheduleConfig(schedule);

      // Load and render last execution result
      this.renderTaskLastResult(taskId);
    } else {
      el.taskModalTitle.textContent = 'New Task';
      el.taskSubmitBtn.textContent = 'Create Task';
      el.taskNameInput.value = '';
      el.taskPromptInput.value = '';
      el.taskEnabledInput.checked = true;
      el.taskCatchUpInput.checked = false;
      el.taskScheduleType.value = 'daily';
      this.renderScheduleConfig();
    }

    el.taskModal.classList.remove('hidden');
    el.taskNameInput.focus();
  }

  hideTaskModal() {
    const el = this.app.elements;
    el.taskModal.classList.add('hidden');
    el.taskLastResult.innerHTML = '';
    this.editingTaskId = null;
    this.taskProjectId = null;
  }

  async renderTaskLastResult(taskId) {
    const container = this.app.elements.taskLastResult;
    container.innerHTML = '';

    const history = await this.app.taskManager.loadHistory(taskId);
    if (!Array.isArray(history) || history.length === 0) return;

    const last = history[0];
    const isError = last.status === 'error';
    const timestamp = last.executedAt || last.startedAt || '';
    const timeStr = timestamp ? new Date(timestamp).toLocaleString() : '';

    let html = '<div class="task-last-result">';
    html += '<div class="task-result-meta">';

    // Status badge
    const statusClass = isError ? 'status-error' : 'status-success';
    html += `<span class="task-result-status ${statusClass}">${this.escapeHtml(last.status || 'unknown')}</span>`;

    // Timestamp
    if (timeStr) {
      html += `<span class="task-result-time">${timeStr}</span>`;
    }

    // Stats (tokens, cost)
    if (last.stats) {
      const parts = [];
      if (last.stats.inputTokens != null || last.stats.outputTokens != null) {
        const inp = last.stats.inputTokens ?? 0;
        const out = last.stats.outputTokens ?? 0;
        parts.push(`${inp + out} tokens`);
      }
      if (last.stats.costUsd != null) {
        parts.push(`$${last.stats.costUsd.toFixed(4)}`);
      }
      if (parts.length > 0) {
        html += `<span class="task-result-stats">${parts.join(' / ')}</span>`;
      }
    }

    html += '</div>';

    // Error message
    if (isError && last.error) {
      html += `<div class="task-result-error-msg">${this.escapeHtml(last.error)}</div>`;
    }

    // Collapsible response text
    if (last.response) {
      html += '<details class="think-block">';
      html += '<summary>Response</summary>';
      html += `<pre class="permission-input-preview">${this.escapeHtml(last.response)}</pre>`;
      html += '</details>';
    }

    html += '</div>';
    container.innerHTML = html;
  }

  escapeHtml(str) {
    return this.app.messageRenderer.escapeHtml(str);
  }

  renderScheduleConfig(existingSchedule) {
    const el = this.app.elements;
    const type = el.taskScheduleType.value;
    const container = el.taskScheduleConfig;
    container.innerHTML = '';

    const addField = (id, label, placeholder, value) => {
      const lbl = document.createElement('label');
      lbl.setAttribute('for', id);
      lbl.textContent = label;
      container.appendChild(lbl);
      const input = document.createElement('input');
      input.type = 'text';
      input.id = id;
      input.placeholder = placeholder;
      if (value) input.value = value;
      container.appendChild(input);
    };

    const existing = existingSchedule || {};

    switch (type) {
      case 'daily':
        addField('taskTimeInput', 'Time (HH:MM)', '09:00', existing.time || '');
        break;
      case 'hourly':
        addField('taskMinuteInput', 'Minute (0-59)', '0', existing.minute != null ? String(existing.minute) : '');
        break;
      case 'interval':
        addField('taskIntervalInput', 'Minutes', '60', existing.minutes ? String(existing.minutes) : '');
        break;
      case 'weekly':
        addField('taskDayInput', 'Day', 'monday', existing.day || '');
        addField('taskTimeInput', 'Time (HH:MM)', '09:00', existing.time || '');
        break;
      case 'cron':
        addField('taskCronInput', 'Expression', '0 9 * * *', existing.expression || '');
        break;
      case 'once':
        addField('taskAtInput', 'At (ISO8601)', new Date(Date.now() + 3600000).toISOString(), existing.at || '');
        break;
      case 'on_demand':
        // No config needed
        break;
    }
  }

  collectSchedule() {
    const type = this.app.elements.taskScheduleType.value;
    switch (type) {
      case 'daily': {
        const time = (document.getElementById('taskTimeInput') || {}).value || '09:00';
        return { type, time };
      }
      case 'hourly': {
        const minute = parseInt((document.getElementById('taskMinuteInput') || {}).value || '0', 10);
        return { type, minute };
      }
      case 'interval': {
        const minutes = parseInt((document.getElementById('taskIntervalInput') || {}).value || '60', 10);
        return { type, minutes };
      }
      case 'weekly': {
        const day = (document.getElementById('taskDayInput') || {}).value || 'monday';
        const time = (document.getElementById('taskTimeInput') || {}).value || '09:00';
        return { type, day, time };
      }
      case 'cron': {
        const expression = (document.getElementById('taskCronInput') || {}).value || '0 * * * *';
        return { type, expression };
      }
      case 'once': {
        const at = (document.getElementById('taskAtInput') || {}).value || '';
        return { type, at };
      }
      case 'on_demand':
        return { type };
      default:
        return { type };
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ModalManager;
}
