/**
 * EveWorkspaceClient - thin orchestrator wiring together focused modules.
 *
 * Modules (loaded via <script> tags before this file):
 *   WsClient, MessageRenderer, ModalManager,
 *   SidebarRenderer, TabManager, FileBrowser, FileEditor, TerminalManager
 */
class EveWorkspaceClient {
  constructor() {
    this.currentSessionId = null;
    this.sessions = new Map();
    this.sessionHistories = new Map();
    this.projects = new Map();
    this.models = [];
    this.isRenderingHistory = false;

    // Core infrastructure (Phase 1) — available for new modules.
    this.bus = new EventBus();
    this.container = new Container();
    this.container.register('bus', this.bus);
    this.api = new ApiClient();
    this.container.register('api', this.api);

    this.authClient = new AuthClient();
    this.authClient.init();

    window.addEventListener('auth:success', () => this.initApp());

    this.authClient.checkStatus().then(authenticated => {
      if (authenticated) this.initApp();
    });
  }

  initApp() {
    // Wire state store into infrastructure.
    this.state = new StateStore(this.bus);
    this.container.register('state', this.state);
    this.container.register('app', this); // Legacy bridge: modules can access app via container during migration

    // Apply saved settings before any rendering
    this.settings = new SettingsManager(this.bus);
    this.container.register('settings', this.settings);
    this.settings.applyToDOM();

    this.initElements();

    // Initialize modules
    this.wsClient = new WsClient(this);
    this.container.register('ws', this.wsClient);
    this.messageRenderer = new MessageRenderer(this);
    this.taskManager = new TaskManager(this);
    this.modalManager = new ModalManager(this);
    this.sidebarRenderer = new SidebarRenderer(this);
    this.tabManager = new TabManager(this);
    this.fileBrowser = new FileBrowser(this);
    this.fileEditor = new FileEditor(this);

    // File viewer registry (IoC: viewers register themselves)
    this.viewerRegistry = new ViewerRegistry();
    this.viewerRegistry.register(new ImageViewer());
    this.viewerRegistry.register(new PdfViewer());
    this.viewerRegistry.register(new VideoViewer());
    this.viewerRegistry.register(new AudioViewer());
    this.container.register('viewerRegistry', this.viewerRegistry);

    // New sidebar: project tree (Phase 2)
    this.projectTree = new ProjectTree(this.container);
    this.projectTree.init();

    // New dialogs (Phase 3)
    this.shellLauncher = new ShellLauncherDialog(this.container);
    this.shellLauncher.init();
    this.taskDialog = new TaskDialog(this.container);
    this.taskDialog.init();
    this.settingsDialog = new SettingsDialog(this.container);
    this.settingsDialog.init();

    // Mobile bar (Phase 5)
    this.mobileBar = new MobileBar(this.container);
    this.mobileBar.init();
    this.terminalManager = new TerminalManager(this);
    this.messageDispatcher = new MessageDispatcher(this);
    this.fileAttachmentManager = new FileAttachmentManager(this);
    this.ttsManager = new TTSManager(this);
    this.sttManager = new STTManager(this);
    this.voiceChatManager = new VoiceChatManager(this);

    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
      });
    }

    this.initEventListeners();
    this.modalManager.initEventListeners();
    this.initSidebarResize();
    this.initSwipeGesture();
    this._initBusListeners();
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
      cancelProjectModal: document.getElementById('cancelProjectModal'),
      newProjectBtn: document.getElementById('newProjectBtn'),
      newTerminalBtn: document.getElementById('newTerminalBtn'),
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
      projectModalTitle: document.getElementById('projectModalTitle'),
      projectSubmitBtn: document.getElementById('projectSubmitBtn'),
      projectAllowedToolsInput: document.getElementById('projectAllowedToolsInput'),
      providerSettings: document.getElementById('providerSettings'),
      permissionModal: document.getElementById('permissionModal'),
      permissionToolName: document.getElementById('permissionToolName'),
      permissionToolInput: document.getElementById('permissionToolInput'),
      permissionAllow: document.getElementById('permissionAllow'),
      permissionAlwaysAllow: document.getElementById('permissionAlwaysAllow'),
      permissionDeny: document.getElementById('permissionDeny'),
      planApprovalBar: document.getElementById('planApprovalBar'),
      planApprove: document.getElementById('planApprove'),
      planRevise: document.getElementById('planRevise'),
      connectionStatus: document.getElementById('connectionStatus'),
      welcomeOpenSidebar: document.getElementById('welcomeOpenSidebar'),
      stopBtn: document.getElementById('stopBtn'),
      micBtn: document.getElementById('micBtn'),
      voiceModeBtn: document.getElementById('voiceModeBtn'),
      voiceUIBtn: document.getElementById('voiceUIBtn'),
      voiceDrawer: document.getElementById('voiceDrawer'),
      voiceDrawerToggle: document.getElementById('voiceDrawerToggle'),
      voiceDrawerPanel: document.getElementById('voiceDrawerPanel'),
      voiceSelect: document.getElementById('voiceSelect'),
      taskModal: document.getElementById('taskModal'),
      taskModalTitle: document.getElementById('taskModalTitle'),
      taskForm: document.getElementById('taskForm'),
      taskNameInput: document.getElementById('taskNameInput'),
      taskPromptInput: document.getElementById('taskPromptInput'),
      taskModelSelect: document.getElementById('taskModelSelect'),
      taskScheduleType: document.getElementById('taskScheduleType'),
      taskScheduleConfig: document.getElementById('taskScheduleConfig'),
      taskEnabledInput: document.getElementById('taskEnabledInput'),
      taskCatchUpInput: document.getElementById('taskCatchUpInput'),
      cancelTaskModal: document.getElementById('cancelTaskModal'),
      taskSubmitBtn: document.getElementById('taskSubmitBtn'),
      taskLastResult: document.getElementById('taskLastResult')
    };
  }

  _initBusListeners() {
    // Bridge: new file tree click -> open file via existing read_file flow
    this.bus.on(EVT.FILE_CONTENT, (data) => {
      if (data.requestLoad) {
        if (this.viewerRegistry.isViewerFile(data.path)) {
          // Viewer files load via HTTP, no WebSocket read needed
          const filename = data.path.split('/').pop();
          this.tabManager.openFile(data.projectId, data.path, filename);
        } else {
          this.wsClient.send({ type: 'read_file', projectId: data.projectId, path: data.path });
        }
      }
    });

    // Bridge: confirm dialog requests from new components
    this.bus.on(EVT.DIALOG_CONFIRM, (data) => {
      if (confirm(data.message)) {
        if (data.onConfirm) data.onConfirm();
      }
    });

    // Bridge: project delete from new sidebar
    this.bus.on(EVT.PROJECT_DELETED, (data) => {
      this.deleteProject(data.projectId);
    });

    // Shell launcher and task dialog are handled by their own EventBus subscriptions
    // (ShellLauncherDialog and TaskDialog listen for DIALOG_SHELL_LAUNCHER / DIALOG_TASK directly)

    // Bridge: project edit from new sidebar
    this.bus.on(EVT.DIALOG_PROJECT, (data) => {
      this.modalManager.showProjectModal(data.projectId);
    });

    // Bridge: sidebar toggle from mobile bar
    this.bus.on(EVT.UI_TOGGLE_SIDEBAR, () => {
      this.toggleSidebar();
    });
  }

  initEventListeners() {
    // New session buttons
    this.elements.newSessionBtn?.addEventListener('click', () => this.modalManager.showSessionModal());
    this.elements.welcomeNewSession.addEventListener('click', () => this.modalManager.showSessionModal());

    // Terminal picker (legacy button, may not exist in new sidebar)
    this.elements.newTerminalBtn?.addEventListener('click', () => {
      const dir = this.getCurrentProjectDirectory();
      this.terminalManager.showTemplatePicker(dir);
    });

    // Settings
    document.getElementById('settingsBtn')?.addEventListener('click', () => {
      this.bus.emit(EVT.DIALOG_SETTINGS, {});
    });

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
    this.elements.stopBtn.addEventListener('click', () => this.handleStop());

    // Voice mode toggle + voice selection
    if (this.elements.voiceModeBtn) {
      if (this.ttsManager.enabled) {
        this.elements.voiceModeBtn.classList.add('btn-voice-mode--active');
      }
      this.ttsManager.init();

      // Short tap: toggle TTS. Long press (500ms+): switch to voice UI.
      let voiceBtnTimer = null;
      let voiceBtnHandled = false;
      const startLongPress = () => {
        voiceBtnHandled = false;
        voiceBtnTimer = setTimeout(() => {
          voiceBtnHandled = true;
          if (this.currentSessionId) {
            this.enableVoiceMode();
            this.voiceChatManager.convertToVoiceChat();
          }
        }, 500);
      };
      const cancelLongPress = () => { clearTimeout(voiceBtnTimer); };
      const shortTap = () => {
        if (voiceBtnHandled) return;
        voiceBtnHandled = true;
        this.toggleVoiceMode();
      };

      this.elements.voiceModeBtn.addEventListener('mousedown', startLongPress);
      this.elements.voiceModeBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startLongPress(); });
      this.elements.voiceModeBtn.addEventListener('mouseup', cancelLongPress);
      this.elements.voiceModeBtn.addEventListener('mouseleave', cancelLongPress);
      this.elements.voiceModeBtn.addEventListener('touchend', (e) => { e.preventDefault(); cancelLongPress(); shortTap(); });
      this.elements.voiceModeBtn.addEventListener('click', (e) => { e.preventDefault(); shortTap(); });

      if (this.elements.voiceSelect) {
        this.elements.voiceSelect.addEventListener('change', (e) => {
          this.ttsManager.setVoice(e.target.value);
          this.ttsManager.syncVoiceMode(this.wsClient);
        });
      }

    }

    // Voice UI switch button (text chat -> voice chat)
    if (this.elements.voiceUIBtn) {
      this.elements.voiceUIBtn.addEventListener('click', () => {
        this.voiceChatManager.convertToVoiceChat();
      });
    }

    // Voice controls drawer toggle
    if (this.elements.voiceDrawerToggle) {
      this.elements.voiceDrawerToggle.addEventListener('click', () => {
        const panel = this.elements.voiceDrawerPanel;
        const drawer = this.elements.voiceDrawer;
        panel.classList.toggle('hidden');
        drawer.classList.toggle('voice-drawer--open');
      });
    }

    // Microphone / STT
    if (this.elements.micBtn) {
      this.sttManager.init();
      this.elements.micBtn.addEventListener('click', () => {
        this.sttManager.toggleRecording();
      });
    }

    // Voice Chat Manager
    this.voiceChatManager.init();

    // Show model loading overlay if browser backends need to download models
    this._showModelLoadingOverlay();

    // Mobile sidebar toggle
    this.elements.openSidebar.addEventListener('click', () => this.toggleSidebar(true));
    this.elements.welcomeOpenSidebar.addEventListener('click', () => this.toggleSidebar(true));
    this.elements.closeSidebar.addEventListener('click', () => this.toggleSidebar(false));

    // Project select
    this.elements.projectSelect.addEventListener('change', () => {
      this.updateDirectoryInputRequirement();
    });

    // Model select — render provider-specific settings
    this.elements.sessionModelSelect.addEventListener('change', () => {
      this.renderProviderSettings();
    });

    // Task form
    if (this.elements.taskForm) {
      this.elements.taskForm.addEventListener('submit', (e) => this.handleTaskSubmit(e));
    }
  }

  // --- WebSocket ready ---

  onWebSocketReady() {
    // Clear stale thinking indicator from previous connection
    this.messageRenderer.hideThinkingIndicator();

    // Sync voice mode state to server on (re)connect
    this.ttsManager.syncVoiceMode(this.wsClient);

    // Load projects (and tasks) first, then sessions, then re-join.
    // Order matters: task session IDs must be known before sessions load
    // so task sessions are filtered from the sidebar.
    this.loadProjects().then(() => this.loadSessions()).then(() => {
      // Restore session tabs from localStorage (sessions opened in the last 24h).
      const recentIds = this.tabManager.getRecentSessionIds();
      for (const sessionId of recentIds) {
        // Only restore if the session still exists on the server.
        if (this.sessions.has(sessionId)) {
          this.joinSession(sessionId);
        }
      }

      // Also re-join any already-open session tabs (e.g. from WebSocket reconnect).
      const sessionTabs = this.tabManager.tabs.filter(t => t.type === 'session');
      for (const tab of sessionTabs) {
        if (!recentIds.includes(tab.id)) {
          this.wsClient.send({ type: 'join_session', sessionId: tab.id });
        }
      }

      // Restore file tabs from localStorage (files opened in the last 24h).
      const recentFiles = this.tabManager.getRecentFiles();
      for (const file of recentFiles) {
        if (this.projects.has(file.projectId)) {
          if (this.viewerRegistry.isViewerFile(file.path)) {
            const filename = file.path.split('/').pop();
            this.tabManager.openFile(file.projectId, file.path, filename);
          } else {
            this.wsClient.send({ type: 'read_file', projectId: file.projectId, path: file.path });
          }
        }
      }
    });

    this.terminalManager.onReady(() => {
      this.terminalManager.requestTerminalList();
      this.terminalManager.requestTemplates();
    });
    this.tabManager.reestablishFileWatches();
  }

  // --- Server message dispatch ---

  handleServerMessage(data) {
    this.messageDispatcher.dispatch(data);
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
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const data = await response.json();
      this.models = data.models || [];
      this.providerSettings = data.providerSettings || {};
      // Sync to StateStore for new dialog components
      this.state.setModels(this.models, this.providerSettings);
      this.renderModelSelect(this.elements.sessionModelSelect);
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  }

  renderModelSelect(selectEl) {
    renderModelSelect(selectEl, this.models);
  }

  async loadProjects() {
    try {
      const response = await fetch('/api/projects', { headers: this.getAuthHeaders() });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const projects = await response.json();
      this.projects.clear();
      projects.forEach(project => this.projects.set(project.id, project));
      // Sync to new StateStore (Phase 2)
      this.state.setProjects(projects);
      await this.loadAllTasks();
      this.sidebarRenderer.renderProjectList();
      this.updateProjectSelect();
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }

  async loadAllTasks() {
    await this.taskManager.loadTasks();
  }

  async loadSessions() {
    try {
      const response = await fetch('/api/sessions', { headers: this.getAuthHeaders() });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const sessions = await response.json();
      sessions.forEach(session => {
        this.sessions.set(session.id, session);
        // Sync to StateStore for new dialog components
        this.state.addSession(session);
      });
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
    const settings = this.collectSettings();
    this.wsClient.send({ type: 'create_session', directory, projectId, model, settings });
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
    const allowedTools = this.parseArgsString(this.elements.projectAllowedToolsInput.value);
    if (!name || !projectPath) return;

    try {
      const isEdit = !!this.modalManager.editingProjectId;
      const url = isEdit ? `/api/projects/${this.modalManager.editingProjectId}` : '/api/projects';
      const method = isEdit ? 'PUT' : 'POST';

      const body = { name, path: projectPath, allowedTools };

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Server error: ${response.status}`);
      const project = await response.json();
      this.projects.set(project.id, project);
      this.sidebarRenderer.renderProjectList();
      this.updateProjectSelect();
      this.modalManager.hideProjectModal();
    } catch (err) {
      console.error('Failed to save project:', err);
    }
  }

  async handleTaskSubmit(e) {
    e.preventDefault();
    const el = this.elements;
    const name = el.taskNameInput.value.trim();
    const prompt = el.taskPromptInput.value.trim();
    const model = el.taskModelSelect.value || undefined;
    const enabled = el.taskEnabledInput.checked;
    const catchUp = el.taskCatchUpInput.checked;
    const schedule = this.modalManager.collectSchedule();
    const projectId = this.modalManager.taskProjectId;
    if (!name || !prompt || !projectId) return;

    const data = { name, prompt, model, enabled, catchUp, schedule, projectId };
    const taskId = this.modalManager.editingTaskId;

    if (taskId) {
      await this.taskManager.updateTask(taskId, data);
    } else {
      await this.taskManager.createTask(data);
    }

    this.modalManager.hideTaskModal();
    this.sidebarRenderer.renderProjectList();
  }

  async deleteProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;

    const sessionCount = Array.from(this.sessions.values()).filter(s => s.projectId === projectId).length;
    const taskCount = this.taskManager.getTasksForProject(projectId).length;
    const parts = [];
    if (sessionCount > 0) parts.push(`${sessionCount} session(s) will become ungrouped`);
    if (taskCount > 0) parts.push(`${taskCount} task(s) will be deleted`);
    const message = parts.length > 0
      ? `Delete '${project.name}'? ${parts.join(', ')}.`
      : `Delete '${project.name}'?`;

    this.modalManager.showConfirmModal(message, async () => {
      try {
        await this.taskManager.deleteByProject(projectId);
        const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE', headers: this.getAuthHeaders() });
        if (!response.ok) throw new Error(`Server error: ${response.status}`);
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

    // Stop any in-progress TTS playback
    if (this.ttsManager.isPlaying) {
      this.ttsManager.stop();
    }

    const files = this.fileAttachmentManager.consumeFiles();
    this.messageRenderer.appendUserMessage(text, files);
    this.wsClient.send({ type: 'user_input', text, files, sessionId: this.currentSessionId });

    this.elements.userInput.value = '';
    this.autoResizeTextarea();
    this.modalManager.hideInputPrompt();
    this.modalManager.hidePlanApproval();
    document.querySelectorAll('.question-options').forEach(el => el.remove());
    this.messageRenderer.finishAssistantMessage();
    this.messageRenderer.showThinkingIndicator();
    this.showStopButton();
  }

  handleStop() {
    if (!this.currentSessionId) return;
    this.wsClient.send({ type: 'stop_generation', sessionId: this.currentSessionId });
    this.messageRenderer.hideThinkingIndicator();
    this.messageRenderer.finishAssistantMessage();
    this.hideStopButton();
  }

  showStopButton() {
    this.elements.sendBtn.classList.add('hidden');
    this.elements.stopBtn.classList.remove('hidden');
  }

  hideStopButton() {
    this.elements.stopBtn.classList.add('hidden');
    this.elements.sendBtn.classList.remove('hidden');
  }

  handleFileContent(projectId, path, content) {
    const filename = path.split('/').pop();
    if (this.fileEditor) this.fileEditor.openFile(projectId, path, content);
    this.tabManager.openFile(projectId, path, filename);
  }

  handleFileSaved(projectId, path) {
    this.tabManager.setFileModified(projectId, path, false);
  }

  handleFileChanged(projectId, path, content) {
    if (this.fileEditor) this.fileEditor.handleExternalChange(projectId, path, content);
  }

  // --- Provider settings ---

  renderProviderSettings() {
    const container = this.elements.providerSettings;
    container.innerHTML = '';

    const modelValue = this.elements.sessionModelSelect.value;
    const model = this.models.find(m => m.value === modelValue);
    if (!model) return;

    const fields = (this.providerSettings || {})[model.provider] || [];
    if (fields.length === 0) return;

    for (const field of fields) {
      const wrapper = document.createElement('div');
      wrapper.className = 'provider-setting-field';

      if (field.type === 'boolean') {
        wrapper.className += ' provider-setting-checkbox';
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.settingKey = field.key;
        if (field.default === true) input.checked = true;
        label.appendChild(input);
        label.appendChild(document.createTextNode(' ' + field.label));
        wrapper.appendChild(label);
      } else if (field.type === 'number') {
        const label = document.createElement('label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        const input = document.createElement('input');
        input.type = 'number';
        input.dataset.settingKey = field.key;
        if (field.min != null) input.min = field.min;
        if (field.max != null) input.max = field.max;
        if (field.step != null) input.step = field.step;
        if (field.default != null) input.value = field.default;
        if (field.placeholder) input.placeholder = field.placeholder;
        wrapper.appendChild(input);
      } else {
        // string or string[]
        const label = document.createElement('label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        const input = document.createElement('input');
        input.type = 'text';
        input.dataset.settingKey = field.key;
        input.dataset.settingType = field.type;
        if (field.default != null) input.value = field.default;
        if (field.placeholder) input.placeholder = field.placeholder;
        wrapper.appendChild(input);
      }

      if (field.hint) {
        const hint = document.createElement('span');
        hint.className = 'field-hint';
        hint.textContent = field.hint;
        wrapper.appendChild(hint);
      }

      container.appendChild(wrapper);
    }
  }

  collectSettings() {
    const container = this.elements.providerSettings;
    const inputs = container.querySelectorAll('[data-setting-key]');
    if (inputs.length === 0) return null;

    const settings = {};
    for (const input of inputs) {
      const key = input.dataset.settingKey;
      if (input.type === 'checkbox') {
        settings[key] = input.checked;
      } else if (input.type === 'number') {
        if (input.value !== '') settings[key] = parseFloat(input.value);
      } else if (input.dataset.settingType === 'string[]') {
        const val = input.value.trim();
        if (val) settings[key] = val.split(/\s+/);
      } else {
        if (input.value.trim()) settings[key] = input.value.trim();
      }
    }
    return Object.keys(settings).length > 0 ? settings : null;
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

  enableVoiceMode(voice) {
    const v = voice || this.ttsManager.voice;
    this.ttsManager.setEnabled(true);
    this.elements.voiceModeBtn?.classList.add('btn-voice-mode--active');
    this.ttsManager.syncVoiceMode(this.wsClient);
    this._updateVoiceUIBtnVisibility();
  }

  toggleVoiceMode() {
    this.ttsManager.setEnabled(!this.ttsManager.enabled);
    this.elements.voiceModeBtn?.classList.toggle('btn-voice-mode--active', this.ttsManager.enabled);
    this.ttsManager.syncVoiceMode(this.wsClient);
    this._updateVoiceUIBtnVisibility();
  }

  _updateVoiceUIBtnVisibility() {
    const btn = this.elements.voiceUIBtn;
    if (!btn) return;
    const session = this.sessions.get(this.currentSessionId);
    btn.classList.toggle('hidden', session?.sessionType === 'voice');
  }

  toggleSidebar(open) {
    if (open === undefined) {
      open = !this.elements.sidebar.classList.contains('open');
    }
    if (open) {
      this.elements.sidebar.classList.add('open');
    } else {
      this.elements.sidebar.classList.remove('open');
    }
  }

  renderMessages() {
    this.messageRenderer.clearMessages();

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

  getCurrentProjectDirectory() {
    const session = this.sessions.get(this.currentSessionId);
    if (session?.directory) return session.directory;
    // Fall back to the first project path.
    for (const p of this.projects.values()) {
      if (p.path) return p.path;
    }
    return '';
  }

  getSessionDisplayName(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return sessionId;
    return session.name || this.shortenPath(session.directory);
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

  initSidebarResize() {
    initSidebarResize(this.elements.sidebar, this.elements.sidebarResizer);
  }

  initSwipeGesture() {
    initSwipeGesture(this.elements.sidebar, (open) => this.toggleSidebar(open));
  }

  /**
   * Show a blocking overlay while browser STT/TTS models are downloading.
   * Hides automatically when all active browser backends report ready.
   */
  _showModelLoadingOverlay() {
    const sttOnDevice = this.sttManager.backend === 'browser' || this.sttManager.backend === 'native';
    const ttsOnDevice = this.ttsManager.backend === 'browser' || this.ttsManager.backend === 'native';
    if (!sttOnDevice && !ttsOnDevice) return;

    // Check what actually needs loading
    const sttNeedsLoad = sttOnDevice && !this.sttManager.activeBackend.ready;
    const ttsNeedsLoad = ttsOnDevice && !this.ttsManager.activeBackend.ready;
    if (!sttNeedsLoad && !ttsNeedsLoad) return;

    const overlay = document.getElementById('modelLoadingOverlay');
    const sttItem = document.getElementById('sttLoadingItem');
    const ttsItem = document.getElementById('ttsLoadingItem');
    const sttFill = document.getElementById('sttLoadingFill');
    const ttsFill = document.getElementById('ttsLoadingFill');
    const sttPct = document.getElementById('sttLoadingPct');
    const ttsPct = document.getElementById('ttsLoadingPct');

    if (!overlay) return;

    // Reset and show only items that need loading
    if (sttItem) sttItem.style.display = sttNeedsLoad ? '' : 'none';
    if (ttsItem) ttsItem.style.display = ttsNeedsLoad ? '' : 'none';
    if (sttFill) { sttFill.style.width = '0%'; }
    if (ttsFill) { ttsFill.style.width = '0%'; }
    if (sttPct) sttPct.textContent = 'waiting...';
    if (ttsPct) ttsPct.textContent = 'waiting...';

    overlay.classList.remove('hidden');

    const checkDone = () => {
      const sDone = !sttNeedsLoad || this.sttManager.activeBackend.ready;
      const tDone = !ttsNeedsLoad || this.ttsManager.activeBackend.ready;

      if (sttNeedsLoad && sttFill) {
        const pct = sDone ? 100 : (this._sttLoadPct || 0);
        sttFill.style.width = (pct || (this.sttManager.activeBackend.loading ? 50 : 0)) + '%';
        sttPct.textContent = sDone ? 'ready' : (pct ? pct + '%' : 'loading...');
      }
      if (ttsNeedsLoad && ttsFill) {
        const pct = tDone ? 100 : (this._ttsLoadPct || 0);
        ttsFill.style.width = (pct || (this.ttsManager.activeBackend.loading ? 50 : 0)) + '%';
        ttsPct.textContent = tDone ? 'ready' : (pct ? pct + '%' : 'loading...');
      }

      if (sDone && tDone) {
        overlay.classList.add('hidden');
      } else {
        requestAnimationFrame(checkDone);
      }
    };
    requestAnimationFrame(checkDone);
  }
}

// --- Standalone UI helpers (no class dependency) ---

function initSidebarResize(sidebar, resizer) {
  const minWidth = 200;
  const maxWidth = 600;
  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  const setWidth = (w) => document.documentElement.style.setProperty('--sidebar-width', `${w}px`);

  const saved = localStorage.getItem('sidebarWidth');
  if (saved) setWidth(parseInt(saved));

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    startX = e.clientX;
    startWidth = sidebar.offsetWidth;
    resizer.classList.add('resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    setWidth(Math.min(maxWidth, Math.max(minWidth, startWidth + (e.clientX - startX))));
  });

  document.addEventListener('mouseup', () => {
    if (!isResizing) return;
    isResizing = false;
    resizer.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('sidebarWidth', sidebar.offsetWidth.toString());
  });
}

function initSwipeGesture(sidebar, toggleSidebar) {
  let startX = 0;
  let startY = 0;

  document.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    const deltaX = e.changedTouches[0].clientX - startX;
    const deltaY = Math.abs(e.changedTouches[0].clientY - startY);
    if (deltaY > Math.abs(deltaX)) return;

    const open = sidebar.classList.contains('open');
    if (!open && startX < 30 && deltaX > 60) toggleSidebar(true);
    if (open && deltaX < -60) toggleSidebar(false);
  }, { passive: true });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.client = new EveWorkspaceClient();
});
