/**
 * Modal lifecycle management: show/hide for all modals,
 * confirmation flow, permission prompts, input prompts.
 */
class ModalManager {
  constructor(app) {
    this.app = app;
    this.confirmCallback = null;
    this.editingProjectId = null;
    this.pendingPermissionId = null;
  }

  initEventListeners() {
    const el = this.app.elements;

    // Session Modal
    el.cancelModal.addEventListener('click', () => this.hideSessionModal());
    el.modal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideSessionModal());

    // Project Modal
    el.cancelProjectModal.addEventListener('click', () => this.hideProjectModal());
    el.projectModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideProjectModal());

    // Confirmation modal
    el.cancelConfirm.addEventListener('click', () => this.hideConfirmModal());
    el.confirmModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideConfirmModal());
    el.confirmDelete.addEventListener('click', () => this.handleConfirm());

    // Tasks modal
    if (el.closeTasksModal) {
      el.closeTasksModal.addEventListener('click', () => this.hideTasksModal());
      el.tasksModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideTasksModal());
    }

    // Task form modal
    if (el.cancelTaskForm) {
      el.cancelTaskForm.addEventListener('click', () => this.hideTaskForm());
      el.taskFormModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideTaskForm());
    }

    // Permission modal
    if (el.permissionAllow) {
      el.permissionAllow.addEventListener('click', () => this.respondToPermission(true));
    }
    if (el.permissionDeny) {
      el.permissionDeny.addEventListener('click', () => this.respondToPermission(false));
    }
    if (el.permissionModal) {
      el.permissionModal.querySelector('.modal-backdrop').addEventListener('click', () => this.respondToPermission(false));
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
      if (project.model) {
        el.sessionModelSelect.value = project.model;
      }
    }

    this.app.updateDirectoryInputRequirement();
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
    this.app.updateDirectoryInputRequirement();
    this.app.toggleSidebar(false);
  }

  // --- Project modal ---

  showProjectModal(projectId = null) {
    const el = this.app.elements;
    this.editingProjectId = projectId;

    if (projectId) {
      const project = this.app.projects.get(projectId);
      if (!project) return;
      el.projectModalTitle.textContent = 'Edit Project';
      el.projectSubmitBtn.textContent = 'Save';
      el.projectNameInput.value = project.name;
      el.projectPathInput.value = project.path;
      el.projectModelSelect.value = project.model || 'haiku';
      el.projectAllowedToolsInput.value = (project.allowedTools || []).join(' ');
    } else {
      el.projectModalTitle.textContent = 'New Project';
      el.projectSubmitBtn.textContent = 'Create Project';
      el.projectNameInput.value = '';
      el.projectPathInput.value = '';
      el.projectAllowedToolsInput.value = '';
      if (this.app.models.length > 0) {
        el.projectModelSelect.value = this.app.models[0].value;
      }
    }

    el.projectModal.classList.remove('hidden');
    el.projectNameInput.focus();
  }

  hideProjectModal() {
    const el = this.app.elements;
    el.projectModal.classList.add('hidden');
    this.editingProjectId = null;
    el.projectNameInput.value = '';
    el.projectPathInput.value = '';
    el.projectAllowedToolsInput.value = '';
    if (this.app.models.length > 0) {
      el.projectModelSelect.value = this.app.models[0].value;
    }
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

  // --- Tasks modal ---

  hideTasksModal() {
    this.app.elements.tasksModal.classList.add('hidden');
    this.app.taskUI.currentTasksProjectId = null;
  }

  hideTaskForm() {
    this.app.elements.taskFormModal.classList.add('hidden');
    this.app.taskUI.editingTask = null;
  }

  // --- Permission modal ---

  showPermissionModal(data) {
    this.pendingPermissionId = data.permissionId;
    this.app.elements.permissionToolName.textContent = data.toolName || 'Unknown';
    this.app.elements.permissionToolInput.textContent = data.toolInput || '';
    this.app.elements.permissionModal.classList.remove('hidden');
    this.app.elements.permissionAllow.focus();
  }

  hidePermissionModal() {
    this.app.elements.permissionModal.classList.add('hidden');
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
}
