/**
 * EveWorkspaceClient - thin orchestrator wiring together focused modules.
 *
 * Modules (loaded via <script> tags before this file):
 *   WsClient, MessageRenderer, ModalManager,
 *   SidebarRenderer, TabManager, FileBrowser, FileEditor, TerminalManager
 */
class EveWorkspaceClient {
  constructor() {

    // Core infrastructure (Phase 1) — available for new modules.
    this.bus = new EventBus();
    this.container = new Container();
    this.container.register('bus', this.bus);
    const logger = new Logger('debug');
    this.container.register('logger', logger);
    this.api = new ApiClient();
    this.container.register('api', this.api);

    this.authClient = new AuthClient(logger.child('Auth'));
    this.authClient.init();

    window.addEventListener('auth:success', () => this.initApp());

    this.authClient.checkStatus().then(authenticated => {
      if (authenticated) this.initApp();
    });
  }

  initApp() {
    this.log = this.container.get('logger').child('App');

    // Wire state store into infrastructure.
    this.state = new StateStore(this.bus);
    this.container.register('state', this.state);
    this.container.register('app', this); // Legacy bridge: modules can access app via container during migration

    // Apply saved settings before any rendering
    this.settings = new SettingsManager(this.bus);
    this.container.register('settings', this.settings);
    this.settings.applyToDOM();

    this.initElements();

    // Initialize modules — register each in the container immediately after creation
    // so subsequent modules (and Phase 2+ container-based modules) can resolve them.
    this.wsClient = new WsClient(this.container, {
      onReady: () => this.onWebSocketReady(),
      onMessage: (data) => this.handleServerMessage(data),
    });
    this.wsClient.setConnectionStatusEl(this.elements.connectionStatus);
    this.container.register('ws', this.wsClient);
    this.messageRenderer = new MessageRenderer(this.container);
    this.container.register('messageRenderer', this.messageRenderer);
    this.taskManager = new TaskManager(this.container);
    this.container.register('taskManager', this.taskManager);
    this.modalManager = new ModalManager(this.container);
    this.container.register('modalManager', this.modalManager);
    this.sidebarRenderer = new SidebarRenderer(this.container);
    this.container.register('sidebarRenderer', this.sidebarRenderer);
    this.tabManager = new TabManager(this.container);
    this.container.register('tabManager', this.tabManager);
    this.fileBrowser = new FileBrowser(this.container);
    this.container.register('fileBrowser', this.fileBrowser);
    this.fileEditor = new FileEditor(this.container);
    this.container.register('fileEditor', this.fileEditor);

    // Modules (AI-backed mini-apps inside projects)
    this.moduleStore = new ModuleStore(this.container);
    this.container.register('moduleStore', this.moduleStore);
    this.moduleHost = new ModuleHost(this.container);
    this.container.register('moduleHost', this.moduleHost);
    this.moduleHost.init();
    this.moduleActivityOrb = new ModuleActivityOrb(this.container);
    this.container.register('moduleActivityOrb', this.moduleActivityOrb);
    this.moduleActivityOrb.init();

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
    this.projectDialog = new ProjectDialog(this.container);
    this.projectDialog.init();
    this.searchDialog = new SearchDialog(this.container);
    this.searchDialog.init();

    this.terminalManager = new TerminalManager(this.container);
    this.container.register('terminalManager', this.terminalManager);
    // TaskViewer must be registered AFTER terminalManager and the DI app
    // entry — it dispatches into both. It's intentionally tiny: a single
    // dispatch table keyed by view.kind.
    this.taskViewer = new TaskViewer(this.container);
    this.container.register('taskViewer', this.taskViewer);
    this.fileAttachmentManager = new FileAttachmentManager(this.container);
    this.container.register('fileAttachmentManager', this.fileAttachmentManager);
    this.inputHistory = new InputHistory('eve-input-history', 100);
    // Recover from a prior on-device voice load that hard-crashed the page (e.g.
    // Safari OOM): reverts the persisted backend to 'server' before the managers
    // below read their preferences. Notified to the user once the toast manager exists.
    const voiceCrashRecovery = VoiceCrashGuard.detectAndRecover();
    this.ttsManager = new TTSManager(this.container);
    this.container.register('ttsManager', this.ttsManager);
    this.sttManager = new STTManager(this.container);
    this.container.register('sttManager', this.sttManager);
    this.voiceChatManager = new VoiceChatManager(this.container);
    this.container.register('voiceChatManager', this.voiceChatManager);
    this.toastManager = new ToastManager(this.container);
    this.container.register('toastManager', this.toastManager);
    this._notifyVoiceCrashRecovery(voiceCrashRecovery);
    this.voiceInitCoordinator = new VoiceInitCoordinator(this.container);
    this.container.register('voiceInitCoordinator', this.voiceInitCoordinator);
    // MessageDispatcher must be created after all services it depends on
    this.messageDispatcher = new MessageDispatcher(this.container);
    this.container.register('messageDispatcher', this.messageDispatcher);

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
    Promise.all([this.loadModels(), this.loadMcps()]);
    this.wsClient.connect();
  }

  // Proxy for existing modules that reference client.ws directly
  get ws() {
    return this.wsClient?.ws;
  }

  // State delegates — single source of truth is StateStore.
  // These getters let module code (e.g. this.app.sessions.get(...))
  // work transparently while StateStore owns the data.
  get sessions() { return this.state.sessions; }
  get sessionHistories() { return this.state.sessionHistories; }
  get projects() { return this.state.projects; }
  get models() { return this.state.models; }
  set models(value) { this.state.models = value; }
  get providerSettings() { return this.state.providerSettings; }
  set providerSettings(value) { this.state.providerSettings = value; }
  get currentSessionId() { return this.state.currentSessionId; }
  set currentSessionId(id) {
    this.state.currentSessionId = id;
    const session = id ? this.sessions.get(id) : null;
    this._updateChatInputCapabilities(session?.model);
  }
  get isRenderingHistory() { return this.messageRenderer?.isRenderingHistory ?? false; }
  set isRenderingHistory(value) { if (this.messageRenderer) this.messageRenderer.isRenderingHistory = value; }

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
      welcomeNewSession: document.getElementById('welcomeNewSession'), // legacy, may not exist
      modal: document.getElementById('modal'),
      newSessionForm: document.getElementById('newSessionForm'),
      directoryInput: document.getElementById('directoryInput'),
      cancelModal: document.getElementById('cancelModal'),
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
      planModeBtn: document.getElementById('planModeBtn'),
      fileInput: document.getElementById('fileInput'),
      attachedFiles: document.getElementById('attachedFiles'),
      costStat: document.getElementById('costStat'),
      sessionStats: document.getElementById('sessionStats'),
      confirmModal: document.getElementById('confirmModal'),
      confirmMessage: document.getElementById('confirmMessage'),
      confirmDelete: document.getElementById('confirmDelete'),
      cancelConfirm: document.getElementById('cancelConfirm'),
      providerSettings: document.getElementById('providerSettings'),
      permissionModal: document.getElementById('permissionModal'),
      permissionToolName: document.getElementById('permissionToolName'),
      permissionToolInput: document.getElementById('permissionToolInput'),
      permissionAllow: document.getElementById('permissionAllow'),
      permissionAllowAll: document.getElementById('permissionAllowAll'),
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
        // Stash lineNumber on the side; handleFileContent consumes it after
        // the read_file round-trip lands.
        if (typeof data.lineNumber === 'number') {
          this._pendingFileLineNumber = {
            projectId: data.projectId,
            path: data.path,
            lineNumber: data.lineNumber,
          };
        }
        if (this.viewerRegistry.isViewerFile(data.path)) {
          // Viewer files load via HTTP, no WebSocket read needed
          const filename = data.path.split('/').pop();
          this.tabManager.openFile(data.projectId, data.path, filename);
        } else {
          this.wsClient.send({ type: 'read_file', projectId: data.projectId, path: data.path });
        }
      }
    });

    window.addEventListener('keydown', (e) => this._handleSearchHotkey(e));

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

    // Keep legacy project select in sync when projects change
    this.bus.on(EVT.PROJECTS_LOADED, () => {
      this.sidebarRenderer.renderProjectList();
      this.updateProjectSelect();
    });

    // Re-evaluate chat-input icon gating whenever data that feeds the
    // lookup changes — handles late session.model arrival via WS join and
    // late model catalog load.
    this.bus.on(EVT.MODELS_LOADED, () => {
      this._updateChatInputCapabilities(this._activeModelValue());
    });
    this.bus.on(EVT.SESSION_UPDATED, ({ sessionId }) => {
      if (sessionId === this.currentSessionId) {
        this._updateChatInputCapabilities(this._activeModelValue());
      }
    });

    this.bus.on(EVT.PROJECT_RENAMED, ({ projectId }) => {
      if (this.state.scopedProjectId === projectId) this._syncUrlToScope();
    });

    // Bridge: sidebar toggle from mobile bar
    this.bus.on(EVT.UI_TOGGLE_SIDEBAR, () => {
      this.toggleSidebar();
    });

    // Auto-close sidebar on mobile after actions that leave the sidebar context
    const sidebarCloseEvents = [
      EVT.FILE_CONTENT,
      EVT.DIALOG_SHELL_LAUNCHER,
      EVT.DIALOG_TASK,
      EVT.DIALOG_PROJECT,
      EVT.DIALOG_SETTINGS,
    ];
    sidebarCloseEvents.forEach(evt => {
      this.bus.on(evt, () => this.closeSidebarOnMobile());
    });

    // Module launch — open a tab for a module the user clicked in the sidebar.
    this.bus.on(EVT.MODULE_LAUNCH_REQUEST, ({ projectId, moduleName, displayName }) => {
      this.tabManager.openModule(projectId, moduleName, displayName || moduleName);
    });

    // Module create — open a chat session preloaded with the builder prompt.
    this.bus.on(EVT.MODULE_CREATE_REQUEST, ({ projectId }) => {
      this._startModuleBuilder(projectId).catch(err => {
        this.log.error('Failed to start module builder:', err);
        this.bus.emit(EVT.TOAST_SHOW, {
          id: 'module-builder-error',
          message: 'Failed to start the module builder. Check the console.',
          type: 'error', duration: 4000,
        });
      });
    });
  }

  async _startModuleBuilder(projectId) {
    const project = this.projects.get(projectId);
    if (!project) throw new Error('Project not found');

    let systemPrompt = '';
    try {
      const res = await fetch('/modules/module-builder-prompt.md');
      if (res.ok) systemPrompt = await res.text();
    } catch { /* fall through with empty prompt */ }

    this.wsClient.send({
      type: 'create_session',
      projectId,
      directory: project.path || '',
      name: `${project.name} - Module Builder`,
      systemPrompt,
      appendClaudeMd: false,
    });

    this.bus.emit(EVT.TOAST_SHOW, {
      id: 'module-builder-started',
      message: 'Module builder ready. Describe the module you want.',
      type: 'info', duration: 4000,
    });

    // Pre-fill input once the session is created and switched-to.
    const once = ({ sessionId }) => {
      if (!sessionId) return;
      this.bus.off(EVT.SESSION_SWITCH, once);
      const ta = this.elements.userInput;
      if (ta && !ta.value) {
        ta.value = 'I want a module that ...';
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        this.autoResizeTextarea();
      }
    };
    this.bus.on(EVT.SESSION_SWITCH, once);
  }

  initEventListeners() {
    // New session buttons
    this.elements.newSessionBtn?.addEventListener('click', () => this.modalManager.showSessionModal());
    this.elements.welcomeNewSession?.addEventListener('click', () => this.modalManager.showSessionModal());

    // Terminal picker (legacy button, may not exist in new sidebar)
    this.elements.newTerminalBtn?.addEventListener('click', () => {
      const dir = this.getCurrentProjectDirectory();
      this.terminalManager.showTemplatePicker(dir);
    });

    // Settings
    document.getElementById('settingsBtn')?.addEventListener('click', () => {
      this.bus.emit(EVT.DIALOG_SETTINGS, {});
    });

    // Project dialog (via EventBus — ProjectDialog handles it)
    this.elements.newProjectBtn.addEventListener('click', () => this.bus.emit(EVT.DIALOG_PROJECT, {}));

    // Session form
    this.elements.newSessionForm.addEventListener('submit', (e) => this.handleNewSession(e));

    // Chat input
    this.elements.inputForm.addEventListener('submit', (e) => this.handleSubmit(e));
    const onFirstLine = (ta) => ta.value.lastIndexOf('\n', ta.selectionStart - 1) === -1;
    const onLastLine = (ta) => ta.value.indexOf('\n', ta.selectionStart) === -1;
    this.elements.userInput.addEventListener('keydown', (e) => {
      const applyRecall = (recalled) => {
        if (recalled === null) return;
        e.preventDefault();
        this.elements.userInput.value = recalled;
        this.elements.userInput.setSelectionRange(recalled.length, recalled.length);
        this.autoResizeTextarea();
      };
      if (e.key === 'ArrowUp' && onFirstLine(this.elements.userInput)) {
        applyRecall(this.inputHistory.prev(this.elements.userInput.value));
        return;
      }
      if (e.key === 'ArrowDown' && onLastLine(this.elements.userInput)) {
        applyRecall(this.inputHistory.next());
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSubmit(e);
      }
    });
    this.elements.userInput.addEventListener('input', () => {
      this.inputHistory.reset();
      this.autoResizeTextarea();
    });
    this.elements.stopBtn.addEventListener('click', () => this.handleStop());

    // Plan-mode toggle. The button's .active class reflects the server's
    // current mode (set via the mode_changed event), so reading it gives the
    // up-to-date state. relayLLM restarts Claude with --resume + the new
    // --permission-mode flag.
    if (this.elements.planModeBtn) {
      this.elements.planModeBtn.addEventListener('click', () => {
        if (!this.currentSessionId) return;
        const next = this.elements.planModeBtn.classList.contains('active') ? 'default' : 'plan';
        this.wsClient.send({
          type: 'set_permission_mode',
          sessionId: this.currentSessionId,
          mode: next,
        });
      });
    }

    // Voice mode toggle + voice selection
    if (this.elements.voiceModeBtn) {
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

    // Start voice model preloading (non-blocking toast, not overlay)
    this.voiceInitCoordinator.init();

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
      if (!this.currentSessionId) {
        this._updateChatInputCapabilities(this.elements.sessionModelSelect.value);
      }
    });

    // Task form
    if (this.elements.taskForm) {
      this.elements.taskForm.addEventListener('submit', (e) => this.handleTaskSubmit(e));
    }
  }

  /**
   * Surface a toast when VoiceCrashGuard reverted an on-device backend after a
   * prior load crashed the page. Called after the toast manager is constructed.
   * @param {Array<{kind: string}>} recovered - result from VoiceCrashGuard.detectAndRecover()
   */
  _notifyVoiceCrashRecovery(recovered) {
    if (!recovered?.length) return;
    const names = recovered.map(r => r.kind.toUpperCase()).join(' and ');
    this.bus.emit(EVT.TOAST_SHOW, {
      id: 'voice-crash-recovery',
      message: `On-device ${names} crashed last time (likely out of memory) — switched back to Server. Re-enable in Settings ▸ Voice.`,
      type: 'warning',
      duration: 9000,
    });
  }

  // --- WebSocket ready ---

  onWebSocketReady() {
    // Clear stale thinking indicator from previous connection
    this.messageRenderer.hideThinkingIndicator();

    // Sync voice mode state to server on (re)connect
    if (this.ttsManager.enabled) this.ttsManager.syncVoiceMode(this.wsClient);

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

      // Restore module tabs from localStorage.
      const recentModules = this.tabManager.getRecentModules();
      for (const mod of recentModules) {
        if (this.projects.has(mod.projectId)) {
          this.tabManager.openModule(mod.projectId, mod.moduleName, mod.moduleName);
        }
      }

      // Check for hash-based route (e.g., /#/voice-chat, #session/<id>, #file/<id>/<path>)
      this._handleHashRoute();
      if (!this._hashListenerAdded) {
        window.addEventListener('hashchange', () => this._handleHashRoute());
        this._hashListenerAdded = true;
      }
    });

    this.terminalManager.onReady(() => {
      this.terminalManager.requestTerminalList();
      this.terminalManager.requestTemplates();
    });
    this.tabManager.reestablishFileWatches();
  }

  // --- URL-scoped project filter ---

  // Resolves the URL slug against `projects` and writes scopedProjectId
  // directly (no event). Caller invokes this BEFORE setProjects so the
  // single PROJECTS_LOADED emit already reflects the scope.
  _resolveUrlScope(projects) {
    const slug = readScopeSlugFromUrl();
    if (!slug) { this.state.scopedProjectId = null; return; }
    const match = projects.find(p => slugifyProjectName(p.name) === slug);
    if (!match) {
      history.replaceState(null, '', '/' + this._urlSuffix());
      this.bus.emit(EVT.TOAST_SHOW, {
        id: 'scope-no-match',
        message: `No project matches "/${slug}/" — showing all projects.`,
        type: 'warning', duration: 4000,
      });
      this.state.scopedProjectId = null;
      return;
    }
    this.state.scopedProjectId = match.id;
  }

  _syncUrlToScope() {
    const id = this.state.scopedProjectId;
    const suffix = this._urlSuffix();
    if (!id) {
      if (window.location.pathname !== '/') history.replaceState(null, '', '/' + suffix);
      return;
    }
    const project = this.state.getProject(id);
    if (!project) return;
    const desired = '/' + slugifyProjectName(project.name) + '/' + suffix;
    if (window.location.pathname + suffix !== desired) {
      history.replaceState(null, '', desired);
    }
  }

  _urlSuffix() {
    return window.location.search + window.location.hash;
  }

  // --- Hash route handling (deep links / iOS Action Button) ---

  _clearHash() {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  _hashRouteError(message) {
    this.bus.emit(EVT.TOAST_SHOW, { id: 'hash-route-error', message, type: 'warning', duration: 3000 });
    this._clearHash();
  }

  _handleHashRoute() {
    const hash = window.location.hash;
    if (!hash) return;

    // Voice chat deep links (iOS Action Button) — consume and clear hash
    if (hash === '#/voice-chat' || hash === '#/voice_chat' || hash === '#!/voice-chat' || hash === '#!/voice_chat') {
      this._clearHash();

      const existingId = this._findVoiceSession();
      if (existingId) {
        this.tabManager.switchToTab(existingId);
        return;
      }

      this._launchFavoriteTemplate();
      return;
    }

    // Tab deep links: #session/<id>, #file/<projectId>/<path>, #terminal/<id>, #module/<projectId>/<moduleName>
    const match = hash.match(/^#(session|file|terminal|module)\/(.+)$/);
    if (!match) return;

    const [, routeType, routeData] = match;

    if (routeType === 'session') {
      const sessionId = decodeURIComponent(routeData);
      if (this.sessions.has(sessionId)) {
        const existingTab = this.tabManager.tabs.find(t => t.id === sessionId);
        if (existingTab) {
          this.tabManager.switchToTab(sessionId);
        } else {
          this.joinSession(sessionId);
        }
      } else {
        this._hashRouteError('Session not found.');
      }
    } else if (routeType === 'file') {
      const slashIdx = routeData.indexOf('/');
      if (slashIdx === -1) return;
      const projectId = decodeURIComponent(routeData.substring(0, slashIdx));
      const filePath = decodeURIComponent(routeData.substring(slashIdx + 1));

      if (!this.projects.has(projectId)) {
        this._hashRouteError('Project not found.');
        return;
      }

      const tabId = `${projectId}:${filePath}`;
      const existingTab = this.tabManager.tabs.find(t => t.id === tabId);
      if (existingTab) {
        this.tabManager.switchToTab(tabId);
      } else {
        this.bus.emit(EVT.FILE_CONTENT, { projectId, path: filePath, filename: filePath.split('/').pop(), requestLoad: true });
      }
    } else if (routeType === 'terminal') {
      const terminalId = decodeURIComponent(routeData);
      const existingTab = this.tabManager.tabs.find(t => t.id === terminalId);
      if (existingTab) {
        this.tabManager.switchToTab(terminalId);
      } else {
        const termMgr = this.terminalManager;
        if (termMgr?.terminals.has(terminalId)) {
          termMgr.showTerminal(terminalId);
          const t = termMgr.terminals.get(terminalId);
          this.tabManager.openTerminal(terminalId, t.name || 'Terminal', t.directory || '');
        } else {
          this._hashRouteError('Terminal not found.');
        }
      }
    } else if (routeType === 'module') {
      const slashIdx = routeData.indexOf('/');
      if (slashIdx === -1) return;
      const projectId = decodeURIComponent(routeData.substring(0, slashIdx));
      const moduleName = decodeURIComponent(routeData.substring(slashIdx + 1));
      if (!this.projects.has(projectId)) {
        this._hashRouteError('Project not found.');
        return;
      }
      this.tabManager.openModule(projectId, moduleName, moduleName);
    }
  }

  _findVoiceSession() {
    // Already viewing a voice session
    if (this.voiceChatManager?.isVoiceSession && this.currentSessionId) {
      return this.currentSessionId;
    }
    // Find any voice session tab
    for (const [id, session] of this.sessions) {
      if (session.sessionType === 'voice') return id;
    }
    return null;
  }

  _launchFavoriteTemplate() {
    if (!FAVORITE_TEMPLATE_ENABLED) return;

    const fav = this.settings.getFavoriteTemplate();
    if (!fav) {
      this.bus.emit(EVT.TOAST_SHOW, {
        id: 'no-favorite',
        message: 'No favorite template set. Star a template in the launcher to use as default.',
        type: 'warning',
        duration: 5000,
      });
      const firstProject = this.state.getVisibleProjects()[0];
      if (firstProject) {
        this.bus.emit(EVT.DIALOG_SHELL_LAUNCHER, { projectId: firstProject.id });
      }
      return;
    }

    const project = this.projects.get(fav.projectId);
    if (!project) {
      this.bus.emit(EVT.TOAST_SHOW, {
        id: 'favorite-error',
        message: 'Favorite template project not found. It may have been deleted.',
        type: 'error',
        duration: 5000,
      });
      return;
    }

    const template = (project.chatTemplates || []).find(t => t.id === fav.templateId);
    if (!template) {
      this.bus.emit(EVT.TOAST_SHOW, {
        id: 'favorite-error',
        message: 'Favorite template not found. It may have been deleted.',
        type: 'error',
        duration: 5000,
      });
      return;
    }

    const name = `${project.name} - ${template.name}`;
    const msg = {
      type: 'create_session',
      projectId: fav.projectId,
      model: template.model,
      settings: template.settings || null,
      name,
    };
    if (template.systemPrompt) msg.systemPrompt = template.systemPrompt;
    if (template.appendClaudeMd) msg.appendClaudeMd = true;
    if (template.mode === 'voice') {
      msg.sessionType = 'voice';
      msg.voice = template.voice || 'af_heart';
    }
    this.wsClient.send(msg);
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
      this.state.setModels(data.models || [], data.providerSettings || {});
      this.renderModelSelect(this.elements.sessionModelSelect);
    } catch (err) {
      this.log.error('Failed to load models:', err);
    }
  }

  _activeModelValue() {
    const session = this.currentSessionId ? this.sessions.get(this.currentSessionId) : null;
    return session?.model || this.elements.sessionModelSelect?.value || null;
  }

  _updateChatInputCapabilities(modelValue) {
    const model = modelValue ? this.models.find(m => m.value === modelValue) : null;
    if (this.elements.attachBtn) this.elements.attachBtn.hidden = !(model?.supportsAttachments);
    if (this.elements.planModeBtn) this.elements.planModeBtn.hidden = !(model?.supportsPermissions);
  }

  async loadMcps() {
    try {
      const mcps = await this.api.getMcps();
      this.state.setMcps(Array.isArray(mcps) ? mcps : []);
    } catch (err) {
      this.log.error('Failed to load MCPs:', err);
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
      this._resolveUrlScope(projects);
      this.state.setProjects(projects); // emits PROJECTS_LOADED → renders sidebar + updates select
      await this.loadAllTasks();
    } catch (err) {
      this.log.error('Failed to load projects:', err);
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
      sessions.forEach(session => this.state.addSession(session));
      this.sidebarRenderer.renderProjectList();
    } catch (err) {
      this.log.error('Failed to load sessions:', err);
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
  }

  async deleteProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;

    const sessionCount = Array.from(this.sessions.values()).filter(s => s.projectId === projectId).length;
    const taskCount = this.state.getTasksForProject(projectId).length;
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
        this.state.removeProject(projectId);
        this._syncUrlToScope();
        this.sidebarRenderer.renderProjectList();
        this.updateProjectSelect();
      } catch (err) {
        this.log.error('Failed to delete project:', err);
      }
    });
  }

  updateProjectSelect() {
    const select = this.elements.projectSelect;
    select.innerHTML = '<option value="">No project</option>';
    for (const project of this.state.getVisibleProjects()) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      select.appendChild(option);
    }
  }

  // --- Chat submission ---

  handleSubmit(e) {
    e.preventDefault();
    const text = this.elements.userInput.value.trim();
    if (!text || !this.currentSessionId) return;

    this.inputHistory.push(text);

    // Stop any in-progress TTS playback
    if (this.ttsManager.isPlaying) {
      this.ttsManager.stop();
    }

    // Voice mode auto-speaks the reply. Re-unlock audio within this send gesture
    // so iOS hasn't re-suspended the context by the time the response arrives.
    if (this.ttsManager.enabled) this.ttsManager.unlockAudio();

    const files = this.fileAttachmentManager.consumeFiles();
    this.messageRenderer.appendUserMessage(text, files);
    this.messageDispatcher.markLocalSubmit(this.currentSessionId);
    this.wsClient.send({ type: 'user_input', text: this._buildSendText(text, false), files, sessionId: this.currentSessionId });

    this.elements.userInput.value = '';
    this.autoResizeTextarea();
    this.modalManager.hideInputPrompt();
    this.modalManager.hidePlanApproval();
    document.querySelectorAll('.question-options').forEach(el => el.remove());
    this.messageRenderer.finishAssistantMessage();
    this.messageRenderer.showThinkingIndicator();
    this.showStopButton();
  }

  _buildSendText(rawText, isDictated) {
    if (rawText.startsWith('/')) return rawText;
    const sttTag = this.settings.get('sttPromptTag');
    const ttsTag = this.settings.get('ttsPromptTag');
    let text = rawText;
    if (isDictated && sttTag) text = sttTag + text;
    if (this.ttsManager.enabled && ttsTag) text = text + ttsTag;
    return text;
  }

  handleStop() {
    if (!this.currentSessionId) return;
    this.wsClient.send({ type: 'stop_generation', sessionId: this.currentSessionId });
    this.messageDispatcher.resetTurnState(this.currentSessionId);
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
    let lineNumber;
    const pending = this._pendingFileLineNumber;
    if (pending && pending.projectId === projectId && pending.path === path) {
      lineNumber = pending.lineNumber;
      this._pendingFileLineNumber = null;
    }
    if (this.fileEditor) this.fileEditor.openFile(projectId, path, content, lineNumber);
    this.tabManager.openFile(projectId, path, filename);
  }

  _handleSearchHotkey(e) {
    const isMeta = e.metaKey || e.ctrlKey;
    if (!isMeta || !e.shiftKey || e.key.toLowerCase() !== 'f') return;
    const projectId = this._resolveActiveProjectId();
    if (!projectId) return;
    e.preventDefault();
    this.bus.emit(EVT.DIALOG_SEARCH, { projectId });
  }

  _resolveActiveProjectId() {
    // Prefer URL-scoped project, then the project of the active session,
    // then fall back to the first available project.
    if (this.state.scopedProjectId) return this.state.scopedProjectId;
    const session = this.state.currentSessionId
      ? this.state.sessions.get(this.state.currentSessionId)
      : null;
    if (session?.projectId) return session.projectId;
    const projects = Array.from(this.state.projects?.values?.() || []);
    return projects[0]?.id || null;
  }

  handleFileSaved(projectId, path) {
    this.tabManager.setFileModified(projectId, path, false);
  }

  handleFileChanged(projectId, path, content) {
    if (content === undefined) {
      this.tabManager?.handleViewerFileChanged(projectId, path);
    } else if (this.fileEditor) {
      this.fileEditor.handleExternalChange(projectId, path, content);
    }
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
      } else if (field.type === 'json') {
        const label = document.createElement('label');
        label.textContent = field.label;
        wrapper.appendChild(label);
        const input = document.createElement('textarea');
        input.dataset.settingKey = field.key;
        input.dataset.settingType = 'json';
        input.rows = 6;
        input.style.fontFamily = 'monospace';
        input.style.fontSize = '12px';
        input.style.width = '100%';
        input.style.resize = 'vertical';
        if (field.default != null) input.value = typeof field.default === 'string' ? field.default : JSON.stringify(field.default, null, 2);
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
      } else if (input.dataset.settingType === 'json') {
        const val = input.value.trim();
        if (val) {
          try {
            settings[key] = JSON.parse(val);
          } catch (e) {
            console.warn(`Invalid JSON for setting "${key}":`, e.message);
          }
        }
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

  // Show a "starting model…" placeholder in the chat area while session
  // creation is in flight. Cleared by handleSessionCreated (re-enables input;
  // the spinner is wiped by the subsequent renderMessages) or by _handleError.
  showSessionStarting(text = 'Starting model…') {
    this.messageRenderer.clearMessages();
    this.showChatScreen();
    this.messageRenderer.showThinkingIndicator(text);
    this.elements.userInput.disabled = true;
    this.elements.sendBtn.disabled = true;
  }

  clearSessionStarting() {
    this.elements.userInput.disabled = false;
    this.elements.sendBtn.disabled = false;
  }

  enableVoiceMode(voice) {
    this.ttsManager.unlockAudio(); // iOS: unlock audio within the triggering gesture
    if (voice) this.ttsManager.setVoice(voice);
    this.ttsManager.setEnabled(true);
    this.elements.voiceModeBtn?.classList.add('btn-voice-mode--active');
    this.ttsManager.syncVoiceMode(this.wsClient);
    this._updateVoiceUIBtnVisibility();
  }

  toggleVoiceMode() {
    const enabling = !this.ttsManager.enabled;
    if (enabling) this.ttsManager.unlockAudio(); // iOS: unlock audio within the triggering gesture
    this.ttsManager.setEnabled(enabling);
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

  closeSidebarOnMobile() {
    if (window.innerWidth <= 768) {
      this.toggleSidebar(false);
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
    for (const p of this.state.getVisibleProjects()) {
      if (p.path) return p.path;
    }
    return '';
  }

  getSessionDisplayName(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return sessionId;
    return session.name || this.shortenPath(session.directory);
  }

  initSidebarResize() {
    initSidebarResize(this.elements.sidebar, this.elements.sidebarResizer);
  }

  initSwipeGesture() {
    initSwipeGesture(this.elements.sidebar, (open) => this.toggleSidebar(open));
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

// Global flag: set to true to suppress sidebar swipe-to-close temporarily
// (e.g. during an in-sidebar swipe-to-delete gesture)
window._sidebarSwipeLocked = false;

function initSwipeGesture(sidebar, toggleSidebar) {
  let startX = 0;
  let startY = 0;

  document.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (window._sidebarSwipeLocked) return;
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
