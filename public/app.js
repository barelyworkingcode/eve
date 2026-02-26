/**
 * EveWorkspaceClient - thin orchestrator wiring together focused modules.
 *
 * Modules (loaded via <script> tags before this file):
 *   WsClient, MessageRenderer, ModalManager, TaskUI,
 *   SidebarRenderer, TabManager, FileBrowser, FileEditor, TerminalManager
 */
class EveWorkspaceClient {
  constructor() {
    this.currentSessionId = null;
    this.sessions = new Map();
    this.sessionHistories = new Map();
    this.projects = new Map();
    this.attachedFiles = [];
    this.models = [];
    this.isRenderingHistory = false;

    this.authClient = new AuthClient();
    this.authClient.init();

    window.addEventListener('auth:success', () => this.initApp());

    this.authClient.checkStatus().then(authenticated => {
      if (authenticated) this.initApp();
    });
  }

  initApp() {
    this.initElements();

    // Initialize modules
    this.wsClient = new WsClient(this);
    this.messageRenderer = new MessageRenderer(this);
    this.modalManager = new ModalManager(this);
    this.taskUI = new TaskUI(this);
    this.sidebarRenderer = new SidebarRenderer(this);
    this.tabManager = new TabManager(this);
    this.fileBrowser = new FileBrowser(this);
    this.fileEditor = new FileEditor(this);
    this.terminalManager = new TerminalManager(this);

    this.initEventListeners();
    this.modalManager.initEventListeners();
    this.taskUI.initEventListeners();
    this.initSidebarResize();
    this.initSwipeGesture();
    this.loadModels();
    this.wsClient.connect();
  }

  // Proxy for existing modules that reference client.ws directly
  get ws() {
    return this.wsClient?.ws;
  }

  getAuthHeaders() {
    const token = localStorage.getItem('eve_session');
    return token ? { 'X-Session-Token': token } : {};
  }

  initElements() {
    this.elements = {
      welcomeScreen: document.getElementById('welcomeScreen'),
      chatScreen: document.getElementById('chatScreen'),
      messages: document.getElementById('messages'),
      userInput: document.getElementById('userInput'),
      inputForm: document.getElementById('inputForm'),
      sendBtn: document.getElementById('sendBtn'),
      newSessionBtn: document.getElementById('newSessionBtn'),
      welcomeNewSession: document.getElementById('welcomeNewSession'),
      modal: document.getElementById('modal'),
      newSessionForm: document.getElementById('newSessionForm'),
      directoryInput: document.getElementById('directoryInput'),
      cancelModal: document.getElementById('cancelModal'),
      projectModal: document.getElementById('projectModal'),
      newProjectForm: document.getElementById('newProjectForm'),
      projectNameInput: document.getElementById('projectNameInput'),
      projectPathInput: document.getElementById('projectPathInput'),
      projectModelSelect: document.getElementById('projectModelSelect'),
      cancelProjectModal: document.getElementById('cancelProjectModal'),
      newProjectBtn: document.getElementById('newProjectBtn'),
      projectList: document.getElementById('projectList'),
      projectSelect: document.getElementById('projectSelect'),
      sessionModelSelect: document.getElementById('sessionModelSelect'),
      inputPrompt: document.getElementById('inputPrompt'),
      promptText: document.getElementById('promptText'),
      sidebar: document.getElementById('sidebar'),
      sidebarResizer: document.getElementById('sidebarResizer'),
      openSidebar: document.getElementById('openSidebar'),
      closeSidebar: document.getElementById('closeSidebar'),
      attachBtn: document.getElementById('attachBtn'),
      fileInput: document.getElementById('fileInput'),
      attachedFiles: document.getElementById('attachedFiles'),
      costStat: document.getElementById('costStat'),
      sessionStats: document.getElementById('sessionStats'),
      confirmModal: document.getElementById('confirmModal'),
      confirmMessage: document.getElementById('confirmMessage'),
      confirmDelete: document.getElementById('confirmDelete'),
      cancelConfirm: document.getElementById('cancelConfirm'),
      tasksModal: document.getElementById('tasksModal'),
      tasksProjectName: document.getElementById('tasksProjectName'),
      tasksList: document.getElementById('tasksList'),
      taskHistorySection: document.getElementById('taskHistorySection'),
      taskHistoryList: document.getElementById('taskHistoryList'),
      closeTasksModal: document.getElementById('closeTasksModal'),
      taskResultName: document.getElementById('taskResultName'),
      taskResultMeta: document.getElementById('taskResultMeta'),
      taskResultBody: document.getElementById('taskResultBody'),
      newTaskBtn: document.getElementById('newTaskBtn'),
      taskFormModal: document.getElementById('taskFormModal'),
      taskFormTitle: document.getElementById('taskFormTitle'),
      taskForm: document.getElementById('taskForm'),
      taskNameInput: document.getElementById('taskNameInput'),
      taskPromptInput: document.getElementById('taskPromptInput'),
      taskScheduleType: document.getElementById('taskScheduleType'),
      taskScheduleConfig: document.getElementById('taskScheduleConfig'),
      taskModelSelect: document.getElementById('taskModelSelect'),
      taskArgsInput: document.getElementById('taskArgsInput'),
      taskEnabledCheck: document.getElementById('taskEnabledCheck'),
      taskDeleteBtn: document.getElementById('taskDeleteBtn'),
      cancelTaskForm: document.getElementById('cancelTaskForm'),
      projectModalTitle: document.getElementById('projectModalTitle'),
      projectSubmitBtn: document.getElementById('projectSubmitBtn'),
      projectAllowedToolsInput: document.getElementById('projectAllowedToolsInput'),
      permissionModal: document.getElementById('permissionModal'),
      permissionToolName: document.getElementById('permissionToolName'),
      permissionToolInput: document.getElementById('permissionToolInput'),
      permissionAllow: document.getElementById('permissionAllow'),
      permissionDeny: document.getElementById('permissionDeny'),
      connectionStatus: document.getElementById('connectionStatus'),
      welcomeOpenSidebar: document.getElementById('welcomeOpenSidebar'),
      refreshModelsBtn: document.getElementById('refreshModelsBtn')
    };
  }

  initEventListeners() {
    // New session buttons
    this.elements.newSessionBtn.addEventListener('click', () => this.modalManager.showSessionModal());
    this.elements.welcomeNewSession.addEventListener('click', () => this.modalManager.showSessionModal());

    // Project modal
    this.elements.newProjectBtn.addEventListener('click', () => this.modalManager.showProjectModal());
    this.elements.newProjectForm.addEventListener('submit', (e) => this.handleNewProject(e));

    // Session form
    this.elements.newSessionForm.addEventListener('submit', (e) => this.handleNewSession(e));

    // Chat input
    this.elements.inputForm.addEventListener('submit', (e) => this.handleSubmit(e));
    this.elements.userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit(e);
      }
    });
    this.elements.userInput.addEventListener('input', () => this.autoResizeTextarea());

    // File attachment
    this.elements.attachBtn.addEventListener('click', () => this.elements.fileInput.click());
    this.elements.fileInput.addEventListener('change', (e) => this.handleFileSelect(e));

    // Paste images
    this.elements.userInput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            const ext = item.type.split('/')[1] || 'png';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            file.customName = `pasted-${timestamp}.${ext}`;
            this.addFiles([file]);
          }
        }
      }
    });

    // Drag and drop
    this.elements.userInput.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.elements.userInput.classList.add('dragover');
    });
    this.elements.userInput.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.elements.userInput.classList.remove('dragover');
    });
    this.elements.userInput.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.elements.userInput.classList.remove('dragover');
      this.addFiles(Array.from(e.dataTransfer.files));
    });

    // Mobile sidebar toggle
    this.elements.openSidebar.addEventListener('click', () => this.toggleSidebar(true));
    this.elements.welcomeOpenSidebar.addEventListener('click', () => this.toggleSidebar(true));
    this.elements.closeSidebar.addEventListener('click', () => this.toggleSidebar(false));

    // Project select
    this.elements.projectSelect.addEventListener('change', () => {
      this.updateDirectoryInputRequirement();
      const projectId = this.elements.projectSelect.value;
      if (projectId) {
        const project = this.projects.get(projectId);
        if (project?.model) {
          this.elements.sessionModelSelect.value = project.model;
        }
      }
    });

    // Refresh models
    this.elements.refreshModelsBtn.addEventListener('click', () => this.refreshModels());
  }

  // --- WebSocket ready ---

  onWebSocketReady() {
    this.loadProjects();
    this.loadSessions();
    this.taskUI.loadScheduledTasks();

    if (this.terminalManager && this.terminalManager.xtermLoaded) {
      this.terminalManager.requestTerminalList();
    } else {
      const checkXterm = setInterval(() => {
        if (this.terminalManager && this.terminalManager.xtermLoaded) {
          clearInterval(checkXterm);
          this.terminalManager.requestTerminalList();
        }
      }, 100);
      setTimeout(() => clearInterval(checkXterm), 5000);
    }
  }

  // --- Server message dispatch ---

  handleServerMessage(data) {
    switch (data.type) {
      case 'session_created':
        this.sessions.set(data.sessionId, {
          id: data.sessionId,
          directory: data.directory,
          projectId: data.projectId || null,
          name: data.name || null,
          model: data.model || null,
          active: true
        });
        this.currentSessionId = data.sessionId;
        this.sessionHistories.set(data.sessionId, []);
        this.showChatScreen();
        this.tabManager.openSession(data.sessionId);
        this.sidebarRenderer.renderProjectList();
        this.modalManager.hideSessionModal();
        break;

      case 'session_joined': {
        this.currentSessionId = data.sessionId;
        const existingSession = this.sessions.get(data.sessionId);
        if (existingSession) {
          if (data.name !== undefined) {
            existingSession.name = data.name || existingSession.name;
          }
          if (data.model) {
            existingSession.model = data.model;
          }
        }
        if (data.history && data.history.length > 0) {
          this.sessionHistories.set(data.sessionId, data.history);
        } else {
          this.sessionHistories.set(data.sessionId, []);
        }
        this.elements.messages.innerHTML = '';
        this.showChatScreen();
        this.tabManager.openSession(data.sessionId);
        this.sidebarRenderer.renderProjectList();
        break;
      }

      case 'session_renamed': {
        const renamedSession = this.sessions.get(data.sessionId);
        if (renamedSession) renamedSession.name = data.name;
        if (this.sidebarRenderer.renamingSessionId !== data.sessionId) {
          this.sidebarRenderer.renderProjectList();
        }
        if (this.tabManager) {
          this.tabManager.updateTabLabel(data.sessionId, data.name || this.getSessionDisplayName(data.sessionId));
        }
        break;
      }

      case 'llm_event':
        this.handleLlmEvent(data.event);
        break;

      case 'raw_output':
        this.messageRenderer.appendRawOutput(data.text);
        break;

      case 'stderr':
        this.messageRenderer.appendSystemMessage(data.text, 'error');
        break;

      case 'session_ended':
        this.sessions.delete(data.sessionId);
        this.sessionHistories.delete(data.sessionId);
        this.tabManager.closeTab(data.sessionId);
        if (this.currentSessionId === data.sessionId) {
          this.currentSessionId = null;
          this.showWelcomeScreen();
        }
        this.sidebarRenderer.renderProjectList();
        break;

      case 'process_exited':
        this.messageRenderer.hideThinkingIndicator();
        this.messageRenderer.appendSystemMessage('Provider process exited. Will restart on next message.');
        break;

      case 'error':
        this.messageRenderer.hideThinkingIndicator();
        this.messageRenderer.appendSystemMessage(data.message, 'error');
        break;

      case 'system_message':
        this.messageRenderer.appendSystemMessage(data.message);
        break;

      case 'clear_messages':
        this.elements.messages.innerHTML = '';
        break;

      case 'message_complete':
        this.messageRenderer.hideThinkingIndicator();
        this.messageRenderer.finishAssistantMessage();
        break;

      case 'stats_update':
        this.updateStats(data.stats);
        break;

      case 'directory_listing':
        this.fileBrowser.handleDirectoryListing(data.projectId, data.path, data.entries);
        break;

      case 'file_content':
        this.handleFileContent(data.projectId, data.path, data.content);
        break;

      case 'file_error':
        this.fileBrowser.handleFileError(data.projectId, data.path, data.error);
        break;

      case 'file_saved':
        this.handleFileSaved(data.projectId, data.path);
        break;

      case 'file_renamed':
        this.fileBrowser.handleFileRenamed(data.projectId, data.oldPath, data.newPath);
        break;

      case 'file_moved':
        this.fileBrowser.handleFileMoved(data.projectId, data.oldPath, data.newPath);
        break;

      case 'file_deleted':
        this.fileBrowser.handleFileDeleted(data.projectId, data.path);
        break;

      case 'directory_created':
        this.fileBrowser.handleDirectoryCreated(data.projectId, data.path, data.name);
        break;

      case 'file_uploaded':
        this.fileBrowser.handleFileUploaded(data.projectId, data.destDirectory, data.fileName);
        break;

      case 'terminal_request':
        this.terminalManager.createTerminal(data.directory, data.command, data.args, data.sessionId);
        break;

      case 'terminal_created':
        this.terminalManager.onTerminalCreated(data.terminalId, data.directory, data.command);
        break;

      case 'terminal_output':
        this.terminalManager.onTerminalOutput(data.terminalId, data.data);
        break;

      case 'terminal_exit':
        this.terminalManager.onTerminalExit(data.terminalId, data.exitCode);
        break;

      case 'terminal_list':
        this.terminalManager.onTerminalList(data.terminals);
        break;

      case 'task_started':
        this.taskUI.handleTaskStarted(data);
        break;

      case 'task_completed':
        this.taskUI.handleTaskCompleted(data);
        break;

      case 'task_failed':
        this.taskUI.handleTaskFailed(data);
        break;

      case 'tasks_updated':
        this.taskUI.loadScheduledTasks();
        break;

      case 'permission_request':
        this.modalManager.showPermissionModal(data);
        break;

      case 'warning':
        this.messageRenderer.appendSystemMessage(data.message, 'warning');
        break;
    }
  }

  // --- LLM event handling ---

  handleLlmEvent(event) {
    switch (event.type) {
      case 'user':
        break;
      case 'assistant':
        this.handleAssistantEvent(event);
        break;
      case 'result':
        this.handleResultEvent(event);
        break;
      case 'system':
        this.handleSystemEvent(event);
        break;
    }
  }

  handleAssistantEvent(event) {
    if (event.message) {
      if (event.message.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            this.messageRenderer.startAssistantMessage(block.text);
          } else if (block.type === 'tool_use') {
            this.messageRenderer.appendToolUse(block.name, block.input);
          }
        }
      }
    } else if (event.content_block) {
      if (event.content_block.type === 'text') {
        this.messageRenderer.updateAssistantMessage(event.content_block.text);
      } else if (event.content_block.type === 'tool_use') {
        this.messageRenderer.appendToolUse(event.content_block.name, event.content_block.input);
      } else if (event.content_block.type === 'tool_use_input') {
        this.messageRenderer.updateToolInput(event.content_block.input);
      }
    } else if (event.delta) {
      if (event.delta.type === 'text_delta') {
        this.messageRenderer.appendToAssistantMessage(event.delta.text);
      }
    }
  }

  handleResultEvent(event) {
    if (event.subtype === 'error') {
      this.messageRenderer.appendSystemMessage(`Tool error: ${event.error}`, 'error');
    } else if (event.subtype === 'tool_result') {
      this.messageRenderer.markToolComplete();
    }
  }

  handleSystemEvent(event) {
    if (event.subtype === 'permission_request') {
      this.modalManager.showPermissionPrompt(event.message || 'Permission requested');
    } else if (event.subtype === 'question') {
      this.modalManager.showInputPrompt(event.message || 'Assistant is asking a question');
    } else if (event.subtype === 'status') {
      if (event.message) {
        this.messageRenderer.updateThinkingIndicator(event.message);
      } else {
        this.messageRenderer.hideThinkingIndicator();
      }
    } else if (event.message) {
      this.messageRenderer.appendSystemMessage(event.message);
    }
  }

  // --- Stats ---

  updateStats(stats) {
    if (!stats) return;
    const cost = stats.costUsd || 0;
    if (this.currentSessionId) {
      const session = this.sessions.get(this.currentSessionId);
      if (session) session.costUsd = cost;
    }
    this.elements.costStat.textContent = `$${cost.toFixed(4)}`;
    this.elements.costStat.title = `Session cost: $${cost.toFixed(6)}`;
  }

  updateStatsForSession(sessionId) {
    const session = this.sessions.get(sessionId);
    const cost = session?.costUsd ?? 0;
    this.elements.costStat.textContent = `$${cost.toFixed(4)}`;
    this.elements.costStat.title = `Session cost: $${cost.toFixed(6)}`;
  }

  // --- Data loading ---

  async loadModels() {
    try {
      const response = await fetch('/api/models', { headers: this.getAuthHeaders() });
      this.models = await response.json();
      this.renderModelSelect(this.elements.projectModelSelect);
      this.renderModelSelect(this.elements.sessionModelSelect);
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  }

  async refreshModels() {
    try {
      const response = await fetch('/api/models/refresh', {
        method: 'POST',
        headers: this.getAuthHeaders()
      });
      this.models = await response.json();
      this.renderModelSelect(this.elements.projectModelSelect);
      this.renderModelSelect(this.elements.sessionModelSelect);
    } catch (err) {
      console.error('Failed to refresh models:', err);
    }
  }

  renderModelSelect(selectEl) {
    selectEl.innerHTML = '';

    const groups = {};
    for (const model of this.models) {
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
      selectEl.appendChild(optgroup);
    }

    if (this.models.length > 0) selectEl.value = this.models[0].value;
  }

  async loadProjects() {
    try {
      const response = await fetch('/api/projects', { headers: this.getAuthHeaders() });
      const projects = await response.json();
      this.projects.clear();
      projects.forEach(project => this.projects.set(project.id, project));
      this.sidebarRenderer.renderProjectList();
      this.updateProjectSelect();
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }

  async loadSessions() {
    try {
      const response = await fetch('/api/sessions', { headers: this.getAuthHeaders() });
      const sessions = await response.json();
      sessions.forEach(session => this.sessions.set(session.id, session));
      this.sidebarRenderer.renderProjectList();
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }

  // --- Session actions ---

  handleNewSession(e) {
    e.preventDefault();
    const projectId = this.elements.projectSelect.value || null;
    const directory = this.elements.directoryInput.value.trim();
    const model = this.elements.sessionModelSelect.value || null;
    if (!projectId && !directory) return;
    this.wsClient.send({ type: 'create_session', directory, projectId, model });
  }

  joinSession(sessionId) {
    this.wsClient.send({ type: 'join_session', sessionId });
  }

  endSession() {
    if (this.currentSessionId) {
      this.wsClient.send({ type: 'end_session' });
    }
  }

  deleteSession(sessionId) {
    const displayName = this.getSessionDisplayName(sessionId);
    this.modalManager.showConfirmModal(
      `Delete session "${displayName}"? This will terminate the process and delete all history.`,
      () => this.wsClient.send({ type: 'delete_session', sessionId })
    );
  }

  // --- Project actions ---

  async handleNewProject(e) {
    e.preventDefault();
    const name = this.elements.projectNameInput.value.trim();
    const projectPath = this.elements.projectPathInput.value.trim();
    const model = this.elements.projectModelSelect.value;
    const allowedTools = this.parseArgsString(this.elements.projectAllowedToolsInput.value);
    if (!name || !projectPath) return;

    try {
      const isEdit = !!this.modalManager.editingProjectId;
      const url = isEdit ? `/api/projects/${this.modalManager.editingProjectId}` : '/api/projects';
      const method = isEdit ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
        body: JSON.stringify({ name, path: projectPath, model, allowedTools })
      });
      const project = await response.json();
      this.projects.set(project.id, project);
      this.sidebarRenderer.renderProjectList();
      this.updateProjectSelect();
      this.modalManager.hideProjectModal();
    } catch (err) {
      console.error('Failed to save project:', err);
    }
  }

  async deleteProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;

    const sessionCount = Array.from(this.sessions.values()).filter(s => s.projectId === projectId).length;
    const message = sessionCount > 0
      ? `Delete '${project.name}'? ${sessionCount} session(s) will become ungrouped.`
      : `Delete '${project.name}'?`;

    this.modalManager.showConfirmModal(message, async () => {
      try {
        await fetch(`/api/projects/${projectId}`, { method: 'DELETE', headers: this.getAuthHeaders() });
        this.projects.delete(projectId);
        this.sidebarRenderer.renderProjectList();
        this.updateProjectSelect();
      } catch (err) {
        console.error('Failed to delete project:', err);
      }
    });
  }

  updateProjectSelect() {
    const select = this.elements.projectSelect;
    select.innerHTML = '<option value="">No project</option>';
    for (const [id, project] of this.projects) {
      if (project.disabled) continue;
      const option = document.createElement('option');
      option.value = id;
      option.textContent = project.name;
      select.appendChild(option);
    }
  }

  // --- Chat submission ---

  handleSubmit(e) {
    e.preventDefault();
    const text = this.elements.userInput.value.trim();
    if (!text || !this.currentSessionId) return;

    const files = [...this.attachedFiles];
    this.messageRenderer.appendUserMessage(text, files);
    this.wsClient.send({ type: 'user_input', text, files });

    this.elements.userInput.value = '';
    this.attachedFiles = [];
    this.renderAttachedFiles();
    this.autoResizeTextarea();
    this.modalManager.hideInputPrompt();
    this.messageRenderer.finishAssistantMessage();
    this.messageRenderer.showThinkingIndicator();
  }

  // --- File handling ---

  handleFileSelect(e) {
    this.addFiles(Array.from(e.target.files));
    e.target.value = '';
  }

  async addFiles(files) {
    for (const file of files) {
      if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
        this.messageRenderer.appendSystemMessage(`Skipped unsupported file type: ${file.name}`, 'error');
        continue;
      }
      try {
        const isImage = file.type.startsWith('image/');
        const content = isImage
          ? await this.readFileAsDataURL(file)
          : await this.readFileAsText(file);
        this.attachedFiles.push({
          name: file.customName || file.name,
          content,
          type: isImage ? 'image' : 'text',
          mediaType: file.type
        });
      } catch (err) {
        this.messageRenderer.appendSystemMessage(`Failed to read file: ${file.name}`, 'error');
      }
    }
    this.renderAttachedFiles();
  }

  readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file);
    });
  }

  readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  renderAttachedFiles() {
    if (this.attachedFiles.length === 0) {
      this.elements.attachedFiles.classList.add('hidden');
      this.elements.attachedFiles.innerHTML = '';
      return;
    }

    this.elements.attachedFiles.classList.remove('hidden');
    this.elements.attachedFiles.innerHTML = this.attachedFiles.map((f, i) => {
      const isImage = f.type === 'image';
      const thumbnail = isImage ? `<img class="file-thumbnail" src="${f.content}" alt="">` : '';
      const icon = isImage ? '' : '<span class="file-icon">&#128196;</span>';
      return `
        <div class="attached-file ${isImage ? 'attached-image' : ''}">
          ${thumbnail}${icon}
          <span class="file-name">${this.messageRenderer.escapeHtml(f.name)}</span>
          <button type="button" class="file-remove" data-index="${i}">&times;</button>
        </div>
      `;
    }).join('');

    this.elements.attachedFiles.querySelectorAll('.file-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.attachedFiles.splice(index, 1);
        this.renderAttachedFiles();
      });
    });
  }

  handleFileContent(projectId, path, content) {
    const filename = path.split('/').pop();
    if (this.fileEditor) this.fileEditor.openFile(projectId, path, content);
    this.tabManager.openFile(projectId, path, filename);
  }

  handleFileSaved(projectId, path) {
    this.tabManager.setFileModified(projectId, path, false);
  }

  // --- UI helpers ---

  showWelcomeScreen() {
    this.elements.welcomeScreen.classList.remove('hidden');
    this.elements.chatScreen.classList.add('hidden');
  }

  showChatScreen() {
    this.elements.welcomeScreen.classList.add('hidden');
    this.elements.chatScreen.classList.remove('hidden');
  }

  toggleSidebar(open) {
    if (open) {
      this.elements.sidebar.classList.add('open');
    } else {
      this.elements.sidebar.classList.remove('open');
    }
  }

  renderMessages() {
    this.elements.messages.innerHTML = '';
    this.messageRenderer.currentAssistantMessage = null;

    const history = this.sessionHistories.get(this.currentSessionId);
    if (history && history.length > 0) {
      this.messageRenderer.renderHistory(history);
    }

    this.elements.userInput.focus();
  }

  updateDirectoryInputRequirement() {
    const projectSelected = this.elements.projectSelect.value;
    this.elements.directoryInput.required = !projectSelected;
    this.elements.directoryInput.placeholder = projectSelected
      ? 'Optional: override project path'
      : '/path/to/your/project';
  }

  autoResizeTextarea() {
    const textarea = this.elements.userInput;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  shortenPath(path) {
    const parts = path.split('/');
    if (parts.length > 3) return '.../' + parts.slice(-2).join('/');
    return path;
  }

  getSessionDisplayName(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return sessionId;
    return session.name || this.shortenPath(session.directory);
  }

  // --- Proxy methods for existing modules (file-browser, etc.) ---

  appendSystemMessage(text, type) {
    this.messageRenderer.appendSystemMessage(text, type);
  }

  showConfirmModal(message, callback) {
    this.modalManager.showConfirmModal(message, callback);
  }

  // Delegated to TaskUI for display
  showTaskResult(projectId, taskId) {
    this.taskUI.showTaskResult(projectId, taskId);
  }

  parseArgsString(str) {
    if (!str || !str.trim()) return [];
    const args = [];
    const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
      let val = match[0];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      args.push(val);
    }
    return args;
  }

  // --- Sidebar resize ---

  initSidebarResize() {
    const minWidth = 200;
    const maxWidth = 600;
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const savedWidth = localStorage.getItem('sidebarWidth');
    if (savedWidth) this.setSidebarWidth(parseInt(savedWidth));

    const startResize = (e) => {
      isResizing = true;
      startX = e.clientX;
      startWidth = this.elements.sidebar.offsetWidth;
      this.elements.sidebarResizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    };

    const resize = (e) => {
      if (!isResizing) return;
      const delta = e.clientX - startX;
      this.setSidebarWidth(Math.min(maxWidth, Math.max(minWidth, startWidth + delta)));
    };

    const stopResize = () => {
      if (!isResizing) return;
      isResizing = false;
      this.elements.sidebarResizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem('sidebarWidth', this.elements.sidebar.offsetWidth.toString());
    };

    this.elements.sidebarResizer.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
  }

  setSidebarWidth(width) {
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  }

  // --- Swipe gesture ---

  initSwipeGesture() {
    let startX = 0;
    let startY = 0;

    document.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      const deltaX = endX - startX;
      const deltaY = Math.abs(endY - startY);

      if (deltaY > Math.abs(deltaX)) return;

      const sidebarOpen = this.elements.sidebar.classList.contains('open');
      if (!sidebarOpen && startX < 30 && deltaX > 60) this.toggleSidebar(true);
      if (sidebarOpen && deltaX < -60) this.toggleSidebar(false);
    }, { passive: true });
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.client = new EveWorkspaceClient();
});
