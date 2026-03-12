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
    this.sidebarRenderer = new SidebarRenderer(this);
    this.tabManager = new TabManager(this);
    this.fileBrowser = new FileBrowser(this);
    this.fileEditor = new FileEditor(this);
    this.terminalManager = new TerminalManager(this);
    this.messageDispatcher = new MessageDispatcher(this);
    this.fileAttachmentManager = new FileAttachmentManager(this);

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
      stopBtn: document.getElementById('stopBtn')
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
    this.elements.stopBtn.addEventListener('click', () => this.handleStop());

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

  }

  // --- WebSocket ready ---

  onWebSocketReady() {
    // Clear stale thinking indicator from previous connection
    this.messageRenderer.hideThinkingIndicator();

    this.loadProjects();
    this.loadSessions();

    // Restore session ID from localStorage if lost (e.g. page refresh).
    if (!this.currentSessionId) {
      this.currentSessionId = localStorage.getItem('eve_currentSession');
    }

    // Re-join current session so the server-side WS handler knows which
    // session to route messages to (its closure-scoped currentSessionId
    // resets to null on every new WebSocket connection).
    if (this.currentSessionId) {
      this.wsClient.send({ type: 'join_session', sessionId: this.currentSessionId });
    }

    this.terminalManager.onReady(() => this.terminalManager.requestTerminalList());
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
      const data = await response.json();
      this.models = data.models || [];
      this.providerSettings = data.providerSettings || {};
      this.renderModelSelect(this.elements.sessionModelSelect);
    } catch (err) {
      console.error('Failed to load models:', err);
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

    const files = this.fileAttachmentManager.consumeFiles();
    this.messageRenderer.appendUserMessage(text, files);
    this.wsClient.send({ type: 'user_input', text, files });

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

  toggleSidebar(open) {
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
