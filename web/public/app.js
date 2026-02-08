class EveWorkspaceClient {
  constructor() {
    this.ws = null;
    this.currentSessionId = null;
    this.sessions = new Map();
    this.sessionHistories = new Map(); // sessionId -> messages array
    this.projects = new Map();
    this.currentAssistantMessage = null;
    this.attachedFiles = [];
    this.models = [];
    this.confirmCallback = null;
    this.isRenderingHistory = false; // Flag to prevent storing during history render
    this.scheduledTasks = []; // All scheduled tasks
    this.taskHistory = new Map(); // projectId:taskId -> executions

    // Check auth before initializing
    this.authClient = new AuthClient();
    this.authClient.init();

    // Listen for successful auth
    window.addEventListener('auth:success', () => this.initApp());

    // Check auth status
    this.authClient.checkStatus().then(authenticated => {
      if (authenticated) {
        this.initApp();
      }
    });
  }

  initApp() {
    this.initElements();
    this.initEventListeners();
    this.initSidebarResize();
    this.tabManager = new TabManager(this);
    this.fileBrowser = new FileBrowser(this);
    this.fileEditor = new FileEditor(this);
    this.terminalManager = new TerminalManager(this);
    this.loadModels();
    this.connect();
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
      taskResultBody: document.getElementById('taskResultBody')
    };
  }

  initEventListeners() {
    // New session buttons
    this.elements.newSessionBtn.addEventListener('click', () => this.showModal());
    this.elements.welcomeNewSession.addEventListener('click', () => this.showModal());

    // Session Modal
    this.elements.cancelModal.addEventListener('click', () => this.hideModal());
    this.elements.modal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideModal());
    this.elements.newSessionForm.addEventListener('submit', (e) => this.handleNewSession(e));

    // Project Modal
    this.elements.newProjectBtn.addEventListener('click', () => this.showProjectModal());
    this.elements.cancelProjectModal.addEventListener('click', () => this.hideProjectModal());
    this.elements.projectModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideProjectModal());
    this.elements.newProjectForm.addEventListener('submit', (e) => this.handleNewProject(e));

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

    // Paste images from clipboard
    this.elements.userInput.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            // Generate a name for pasted images
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
      this.handleDroppedFiles(e.dataTransfer.files);
    });

    // Mobile sidebar toggle
    this.elements.openSidebar.addEventListener('click', () => this.toggleSidebar(true));
    this.elements.closeSidebar.addEventListener('click', () => this.toggleSidebar(false));

    // Project select - update directory input requirement
    this.elements.projectSelect.addEventListener('change', () => this.updateDirectoryInputRequirement());

    // Confirmation modal
    this.elements.cancelConfirm.addEventListener('click', () => this.hideConfirmModal());
    this.elements.confirmModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideConfirmModal());
    this.elements.confirmDelete.addEventListener('click', () => this.handleConfirm());

    // Tasks modal
    if (this.elements.closeTasksModal) {
      this.elements.closeTasksModal.addEventListener('click', () => this.hideTasksModal());
      this.elements.tasksModal.querySelector('.modal-backdrop').addEventListener('click', () => this.hideTasksModal());
    }
  }

  initSidebarResize() {
    const minWidth = 200;
    const maxWidth = 600;
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    // Load saved width from localStorage
    const savedWidth = localStorage.getItem('sidebarWidth');
    if (savedWidth) {
      this.setSidebarWidth(parseInt(savedWidth));
    }

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
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + delta));
      this.setSidebarWidth(newWidth);
    };

    const stopResize = () => {
      if (!isResizing) return;

      isResizing = false;
      this.elements.sidebarResizer.classList.remove('resizing');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      // Save to localStorage
      const width = this.elements.sidebar.offsetWidth;
      localStorage.setItem('sidebarWidth', width.toString());
    };

    this.elements.sidebarResizer.addEventListener('mousedown', startResize);
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
  }

  setSidebarWidth(width) {
    document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
  }

  updateDirectoryInputRequirement() {
    const projectSelected = this.elements.projectSelect.value;
    this.elements.directoryInput.required = !projectSelected;
    if (projectSelected) {
      this.elements.directoryInput.placeholder = 'Optional: override project path';
    } else {
      this.elements.directoryInput.placeholder = '/path/to/your/project';
    }
  }

  handleFileSelect(e) {
    const files = Array.from(e.target.files);
    this.addFiles(files);
    e.target.value = ''; // Reset input
  }

  handleDroppedFiles(fileList) {
    const files = Array.from(fileList);
    this.addFiles(files);
  }

  async addFiles(files) {
    for (const file of files) {
      // Skip video/audio (too large, not supported)
      if (file.type.startsWith('video/') || file.type.startsWith('audio/')) {
        this.appendSystemMessage(`Skipped unsupported file type: ${file.name}`, 'error');
        continue;
      }

      try {
        const isImage = file.type.startsWith('image/');
        const content = isImage
          ? await this.readFileAsDataURL(file)
          : await this.readFileAsText(file);

        this.attachedFiles.push({
          name: file.customName || file.name,
          content: content,
          type: isImage ? 'image' : 'text',
          mediaType: file.type
        });
      } catch (err) {
        this.appendSystemMessage(`Failed to read file: ${file.name}`, 'error');
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
          <span class="file-name">${this.escapeHtml(f.name)}</span>
          <button type="button" class="file-remove" data-index="${i}">&times;</button>
        </div>
      `;
    }).join('');

    // Add remove handlers
    this.elements.attachedFiles.querySelectorAll('.file-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        this.attachedFiles.splice(index, 1);
        this.renderAttachedFiles();
      });
    });
  }

  toggleSidebar(open) {
    if (open) {
      this.elements.sidebar.classList.add('open');
    } else {
      this.elements.sidebar.classList.remove('open');
    }
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}`);
    this.wsAuthenticated = false;

    this.ws.onopen = () => {
      console.log('Connected to server');
      // Send auth token as first message
      const token = localStorage.getItem('eve_session');
      this.ws.send(JSON.stringify({ type: 'auth', token: token || null }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      // Handle auth responses
      if (data.type === 'auth_success') {
        this.wsAuthenticated = true;
        this.onWebSocketReady();
        return;
      }
      if (data.type === 'auth_failed') {
        console.error('WebSocket auth failed:', data.message);
        localStorage.removeItem('eve_session');
        window.location.reload();
        return;
      }

      this.handleServerMessage(data);
    };

    this.ws.onclose = () => {
      console.log('Disconnected from server');
      this.wsAuthenticated = false;
      setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  onWebSocketReady() {
    this.loadProjects();
    this.loadSessions();
    this.loadScheduledTasks();
    // Request terminal list for reconnection after refresh
    if (this.terminalManager && this.terminalManager.xtermLoaded) {
      this.terminalManager.requestTerminalList();
    } else {
      // Wait for xterm to load, then request terminal list
      const checkXterm = setInterval(() => {
        if (this.terminalManager && this.terminalManager.xtermLoaded) {
          clearInterval(checkXterm);
          this.terminalManager.requestTerminalList();
        }
      }, 100);
      // Give up after 5 seconds
      setTimeout(() => clearInterval(checkXterm), 5000);
    }
  }

  async loadModels() {
    try {
      const response = await fetch('/api/models', {
        headers: this.getAuthHeaders()
      });
      this.models = await response.json();
      this.renderModelSelect();
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  }

  renderModelSelect() {
    const select = this.elements.projectModelSelect;
    select.innerHTML = '';

    // Group models by their group property
    const groups = {};
    for (const model of this.models) {
      if (!groups[model.group]) {
        groups[model.group] = [];
      }
      groups[model.group].push(model);
    }

    // Create optgroups
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

    // Set default to first model if available
    if (this.models.length > 0) {
      select.value = this.models[0].value;
    }
  }

  async loadProjects() {
    try {
      const response = await fetch('/api/projects', {
        headers: this.getAuthHeaders()
      });
      const projects = await response.json();
      this.projects.clear();
      projects.forEach(project => {
        this.projects.set(project.id, project);
      });
      this.renderProjectList();
      this.updateProjectSelect();
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }

  async loadSessions() {
    try {
      const response = await fetch('/api/sessions', {
        headers: this.getAuthHeaders()
      });
      const sessions = await response.json();
      sessions.forEach(session => {
        this.sessions.set(session.id, session);
      });
      this.renderProjectList();
    } catch (err) {
      console.error('Failed to load sessions:', err);
    }
  }

  handleServerMessage(data) {
    switch (data.type) {
      case 'session_created':
        this.sessions.set(data.sessionId, {
          id: data.sessionId,
          directory: data.directory,
          projectId: data.projectId || null,
          active: true
        });
        this.currentSessionId = data.sessionId;
        this.sessionHistories.set(data.sessionId, []); // Initialize empty history
        this.showChatScreen();
        this.tabManager.openSession(data.sessionId);
        this.renderProjectList();
        this.hideModal();
        break;

      case 'session_joined':
        this.currentSessionId = data.sessionId;

        // Store history FIRST (before opening tab which triggers renderMessages)
        if (data.history && data.history.length > 0) {
          this.sessionHistories.set(data.sessionId, data.history);
        } else {
          this.sessionHistories.set(data.sessionId, []);
        }

        this.elements.messages.innerHTML = '';
        this.showChatScreen();
        this.tabManager.openSession(data.sessionId);
        this.renderProjectList();
        break;

      case 'llm_event':
        this.handleLlmEvent(data.event);
        break;

      case 'raw_output':
        this.appendRawOutput(data.text);
        break;

      case 'stderr':
        this.appendSystemMessage(data.text, 'error');
        break;

      case 'session_ended':
        console.log('[Client] Received session_ended for:', data.sessionId);
        this.sessions.delete(data.sessionId);
        this.sessionHistories.delete(data.sessionId);
        this.tabManager.closeTab(data.sessionId);
        if (this.currentSessionId === data.sessionId) {
          this.currentSessionId = null;
          this.showWelcomeScreen();
        }
        this.renderProjectList();
        break;

      case 'process_exited':
        this.appendSystemMessage('Provider process exited. Will restart on next message.');
        break;

      case 'error':
        this.appendSystemMessage(data.message, 'error');
        break;

      case 'system_message':
        this.appendSystemMessage(data.message);
        break;

      case 'clear_messages':
        this.elements.messages.innerHTML = '';
        break;

      case 'message_complete':
        this.finishAssistantMessage();
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

      case 'terminal_request':
        // Server is requesting we create a terminal (from /zsh, /claude, or /transfer-cli command)
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
        this.handleTaskStarted(data);
        break;

      case 'task_completed':
        this.handleTaskCompleted(data);
        break;

      case 'task_failed':
        this.handleTaskFailed(data);
        break;

      case 'tasks_updated':
        this.loadScheduledTasks();
        break;
    }
  }

  updateStats(stats) {
    if (!stats) return;

    // Store cost in session for tab switching
    const cost = stats.costUsd || 0;
    if (this.currentSessionId) {
      const session = this.sessions.get(this.currentSessionId);
      if (session) {
        session.costUsd = cost;
      }
    }

    // Update cost display
    this.elements.costStat.textContent = `$${cost.toFixed(4)}`;
    this.elements.costStat.title = `Session cost: $${cost.toFixed(6)}`;
  }

  updateStatsForSession(sessionId) {
    const session = this.sessions.get(sessionId);
    const cost = session?.costUsd ?? 0;
    this.elements.costStat.textContent = `$${cost.toFixed(4)}`;
    this.elements.costStat.title = `Session cost: $${cost.toFixed(6)}`;
  }

  handleFileContent(projectId, path, content) {
    const filename = path.split('/').pop();

    // Load content into editor FIRST (marks file as loaded)
    if (this.fileEditor) {
      this.fileEditor.openFile(projectId, path, content);
    }

    // Then open tab (which will call showFile, but file is already loaded)
    this.tabManager.openFile(projectId, path, filename);
  }

  handleFileSaved(projectId, path) {
    this.tabManager.setFileModified(projectId, path, false);
    console.log('File saved:', path);
  }

  handleLlmEvent(event) {
    switch (event.type) {
      case 'user':
        // User message echo - already displayed
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
      // Start of a new assistant message
      if (event.message.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            this.startAssistantMessage(block.text);
          } else if (block.type === 'tool_use') {
            this.appendToolUse(block.name, block.input);
          }
        }
      }
    } else if (event.content_block) {
      // Streaming content block
      if (event.content_block.type === 'text') {
        this.updateAssistantMessage(event.content_block.text);
      } else if (event.content_block.type === 'tool_use') {
        this.appendToolUse(event.content_block.name, event.content_block.input);
      }
    } else if (event.delta) {
      // Streaming delta
      if (event.delta.type === 'text_delta') {
        this.appendToAssistantMessage(event.delta.text);
      }
    }
  }

  handleResultEvent(event) {
    // Tool result - could show success/failure
    if (event.subtype === 'success') {
      // Tool completed successfully
    } else if (event.subtype === 'error') {
      this.appendSystemMessage(`Tool error: ${event.error}`, 'error');
    }
  }

  handleSystemEvent(event) {
    if (event.subtype === 'permission_request') {
      this.showPermissionPrompt(event.message || 'Permission requested');
    } else if (event.subtype === 'question') {
      this.showInputPrompt(event.message || 'Assistant is asking a question');
    } else if (event.message) {
      this.appendSystemMessage(event.message);
    }
  }

  startAssistantMessage(text) {
    this.finishAssistantMessage();

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';
    messageEl.innerHTML = `<div class="message-content">${this.formatText(text)}</div>`;
    this.elements.messages.appendChild(messageEl);
    this.currentAssistantMessage = messageEl.querySelector('.message-content');
    // Store raw text for history
    this.currentAssistantMessage.dataset.rawText = text;
    this.scrollToBottom();
  }

  updateAssistantMessage(text) {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage(text);
    } else {
      this.currentAssistantMessage.innerHTML = this.formatText(text);
      this.scrollToBottom();
    }
  }

  appendToAssistantMessage(text) {
    if (!this.currentAssistantMessage) {
      this.startAssistantMessage(text);
    } else {
      const currentText = this.currentAssistantMessage.dataset.rawText || '';
      const newText = currentText + text;
      this.currentAssistantMessage.dataset.rawText = newText;
      this.currentAssistantMessage.innerHTML = this.formatText(newText);
      this.scrollToBottom();
    }
  }

  finishAssistantMessage() {
    if (this.currentAssistantMessage) {
      // Store in session history before clearing (but not when rendering history)
      const text = this.currentAssistantMessage.dataset.rawText;
      if (text && this.currentSessionId && !this.isRenderingHistory) {
        const history = this.sessionHistories.get(this.currentSessionId) || [];
        history.push({
          role: 'assistant',
          content: [{ type: 'text', text }]
        });
        this.sessionHistories.set(this.currentSessionId, history);
      }
      delete this.currentAssistantMessage.dataset.rawText;
      this.currentAssistantMessage = null;
    }
  }

  appendToolUse(toolName, input) {
    this.finishAssistantMessage();

    const messageEl = document.createElement('div');
    messageEl.className = 'message assistant';

    let inputSummary = '';
    if (input) {
      if (typeof input === 'string') {
        inputSummary = input.substring(0, 100);
      } else if (input.command) {
        inputSummary = input.command.substring(0, 100);
      } else if (input.file_path) {
        inputSummary = input.file_path;
      } else if (input.pattern) {
        inputSummary = input.pattern;
      }
    }

    messageEl.innerHTML = `
      <div class="message-content">
        <div class="tool-use">
          <span class="tool-name">${this.escapeHtml(toolName)}</span>
          ${inputSummary ? `<span class="tool-input">${this.escapeHtml(inputSummary)}</span>` : ''}
        </div>
      </div>
    `;
    this.elements.messages.appendChild(messageEl);
    this.scrollToBottom();
  }

  renderHistory(messages) {
    this.isRenderingHistory = true;
    this.elements.messages.innerHTML = '';
    this.currentAssistantMessage = null;

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.appendUserMessage(msg.content, msg.files || []);
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              this.startAssistantMessage(block.text);
              this.finishAssistantMessage();
            } else if (block.type === 'tool_use') {
              this.appendToolUse(block.name, block.input);
            }
          }
        }
      }
    }

    this.scrollToBottom();
    this.isRenderingHistory = false;
  }

  appendUserMessage(text, files = []) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message user';

    let filesHtml = '';
    if (files.length > 0) {
      filesHtml = `<div class="message-files">${files.map(f =>
        `<span class="message-file">${this.escapeHtml(f.name)}</span>`
      ).join('')}</div>`;
    }

    messageEl.innerHTML = `<div class="message-content">${filesHtml}${this.escapeHtml(text)}</div>`;
    this.elements.messages.appendChild(messageEl);
    this.scrollToBottom();

    // Store in session history (but not when rendering history)
    if (this.currentSessionId && !this.isRenderingHistory) {
      const history = this.sessionHistories.get(this.currentSessionId) || [];
      history.push({ role: 'user', content: text, files });
      this.sessionHistories.set(this.currentSessionId, history);
    }
  }

  appendSystemMessage(text, type = '') {
    const messageEl = document.createElement('div');
    messageEl.className = `message system ${type}`;
    messageEl.innerHTML = `<div class="message-content">${this.escapeHtml(text)}</div>`;
    this.elements.messages.appendChild(messageEl);
    this.scrollToBottom();
  }

  appendRawOutput(text) {
    // For non-JSON output, append to current message or create new one
    if (this.currentAssistantMessage) {
      this.appendToAssistantMessage(text);
    } else {
      this.startAssistantMessage(text);
    }
  }

  showPermissionPrompt(message) {
    this.elements.inputPrompt.classList.remove('hidden');
    this.elements.promptText.textContent = message;
    this.elements.userInput.placeholder = 'Type yes/no or your response...';
    this.elements.userInput.focus();
  }

  showInputPrompt(message) {
    this.elements.inputPrompt.classList.remove('hidden');
    this.elements.promptText.textContent = message;
    this.elements.userInput.focus();
  }

  hideInputPrompt() {
    this.elements.inputPrompt.classList.add('hidden');
    this.elements.userInput.placeholder = 'Type your message...';
  }

  formatText(text) {
    // Basic markdown-like formatting
    let formatted = this.escapeHtml(text);

    // Code blocks
    formatted = formatted.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');

    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Line breaks
    formatted = formatted.replace(/\n/g, '<br>');

    return formatted;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    this.elements.messages.scrollTop = this.elements.messages.scrollHeight;
  }

  handleSubmit(e) {
    e.preventDefault();
    const text = this.elements.userInput.value.trim();
    if (!text || !this.currentSessionId) return;

    const files = [...this.attachedFiles];
    this.appendUserMessage(text, files);
    this.ws.send(JSON.stringify({ type: 'user_input', text, files }));

    // Clear input and files
    this.elements.userInput.value = '';
    this.attachedFiles = [];
    this.renderAttachedFiles();
    this.autoResizeTextarea();
    this.hideInputPrompt();
    this.finishAssistantMessage();
  }

  handleNewSession(e) {
    e.preventDefault();
    const projectId = this.elements.projectSelect.value || null;
    const directory = this.elements.directoryInput.value.trim();

    if (!projectId && !directory) {
      return;
    }

    this.ws.send(JSON.stringify({ type: 'create_session', directory, projectId }));
  }

  async handleNewProject(e) {
    e.preventDefault();
    const name = this.elements.projectNameInput.value.trim();
    const projectPath = this.elements.projectPathInput.value.trim();
    const model = this.elements.projectModelSelect.value;
    if (!name || !projectPath) return;

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders()
        },
        body: JSON.stringify({ name, path: projectPath, model })
      });
      const project = await response.json();
      this.projects.set(project.id, project);
      this.renderProjectList();
      this.updateProjectSelect();
      this.hideProjectModal();
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  }

  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    const displayName = session ? this.shortenPath(session.directory) : sessionId;

    this.showConfirmModal(`Delete session "${displayName}"? This will terminate the process and delete all history.`, () => {
      console.log('[Client] Sending delete_session for:', sessionId);
      this.ws.send(JSON.stringify({
        type: 'delete_session',
        sessionId
      }));
    });
  }

  async deleteProject(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;

    // Count sessions in this project
    const sessionCount = Array.from(this.sessions.values()).filter(
      s => s.projectId === projectId
    ).length;

    const message = sessionCount > 0
      ? `Delete '${project.name}'? ${sessionCount} session(s) will become ungrouped.`
      : `Delete '${project.name}'?`;

    this.showConfirmModal(message, async () => {
      try {
        await fetch(`/api/projects/${projectId}`, {
          method: 'DELETE',
          headers: this.getAuthHeaders()
        });
        this.projects.delete(projectId);
        this.renderProjectList();
        this.updateProjectSelect();
      } catch (err) {
        console.error('Failed to delete project:', err);
      }
    });
  }

  showProjectModal() {
    this.elements.projectModal.classList.remove('hidden');
    this.elements.projectNameInput.focus();
  }

  hideProjectModal() {
    this.elements.projectModal.classList.add('hidden');
    this.elements.projectNameInput.value = '';
    this.elements.projectPathInput.value = '';
    // Reset to first model if available
    if (this.models.length > 0) {
      this.elements.projectModelSelect.value = this.models[0].value;
    }
  }

  showConfirmModal(message, callback) {
    this.elements.confirmMessage.textContent = message;
    this.confirmCallback = callback;
    this.elements.confirmModal.classList.remove('hidden');
    this.elements.confirmDelete.focus();
  }

  hideConfirmModal() {
    this.elements.confirmModal.classList.add('hidden');
    this.confirmCallback = null;
  }

  handleConfirm() {
    if (this.confirmCallback) {
      this.confirmCallback();
    }
    this.hideConfirmModal();
  }

  updateProjectSelect() {
    const select = this.elements.projectSelect;
    select.innerHTML = '<option value="">No project</option>';
    for (const [id, project] of this.projects) {
      if (project.disabled) {
        continue; // Skip disabled projects in dropdown
      }
      const option = document.createElement('option');
      option.value = id;
      option.textContent = project.name;
      select.appendChild(option);
    }
  }

  joinSession(sessionId) {
    // Just send the join request - the session_joined handler will open the tab
    // after the history is loaded
    this.ws.send(JSON.stringify({ type: 'join_session', sessionId }));
  }

  endSession() {
    if (this.currentSessionId) {
      this.ws.send(JSON.stringify({ type: 'end_session' }));
    }
  }

  showModal(projectId = null) {
    this.elements.modal.classList.remove('hidden');

    if (projectId && this.projects.has(projectId)) {
      // Pre-select project
      this.elements.projectSelect.value = projectId;

      // Pre-fill directory with project path
      const project = this.projects.get(projectId);
      this.elements.directoryInput.value = project.path || '';
    }

    this.updateDirectoryInputRequirement();
    this.elements.directoryInput.focus();
    this.elements.directoryInput.select();
  }

  hideModal() {
    this.elements.modal.classList.add('hidden');
    this.elements.directoryInput.value = '';
    this.elements.projectSelect.value = '';
    this.updateDirectoryInputRequirement();
    this.toggleSidebar(false); // Close sidebar on mobile
  }

  showWelcomeScreen() {
    this.elements.welcomeScreen.classList.remove('hidden');
    this.elements.chatScreen.classList.add('hidden');
  }

  showChatScreen() {
    this.elements.welcomeScreen.classList.add('hidden');
    this.elements.chatScreen.classList.remove('hidden');
  }

  renderMessages() {
    // Called by tab manager when switching to a session tab
    console.log('renderMessages for session:', this.currentSessionId);
    this.elements.messages.innerHTML = '';
    this.currentAssistantMessage = null;

    // Restore history for the current session
    const history = this.sessionHistories.get(this.currentSessionId);
    console.log('Session history:', history);
    if (history && history.length > 0) {
      console.log('Rendering', history.length, 'messages');
      this.renderHistory(history);
    } else {
      console.log('No history to render');
    }

    this.elements.userInput.focus();
  }

  renderProjectList() {
    this.elements.projectList.innerHTML = '';

    // Group sessions by project
    const projectSessions = new Map();
    const ungroupedSessions = [];

    for (const [id, session] of this.sessions) {
      if (session.projectId && this.projects.has(session.projectId)) {
        if (!projectSessions.has(session.projectId)) {
          projectSessions.set(session.projectId, []);
        }
        projectSessions.get(session.projectId).push({ id, ...session });
      } else {
        ungroupedSessions.push({ id, ...session });
      }
    }

    // Render projects with their sessions
    for (const [projectId, project] of this.projects) {
      const sessions = projectSessions.get(projectId) || [];
      const projectEl = document.createElement('div');
      projectEl.className = project.disabled ? 'project-group disabled' : 'project-group';

      const disabledNote = project.disabled ? '<span class="disabled-note">(provider disabled)</span>' : '';
      const taskCount = this.getTaskCountForProject(projectId);
      const taskBadge = taskCount > 0 ? `<span class="project-task-count" title="${taskCount} scheduled task${taskCount !== 1 ? 's' : ''}">${taskCount}</span>` : '';
      projectEl.innerHTML = `
        <div class="project-header">
          <span class="project-toggle">▼</span>
          <span class="project-name">${this.escapeHtml(project.name)}</span>
          <span class="project-model">${project.model || 'haiku'}</span>
          ${taskBadge}
          ${disabledNote}
          <button class="project-files-toggle" title="Browse files">📁</button>
          <button class="project-tasks-btn" title="Scheduled tasks">&#128337;</button>
          <button class="project-quick-add" title="New session in this project">+</button>
          <button class="project-delete" title="Delete project">&times;</button>
        </div>
        <div class="file-tree" style="display: none;"></div>
        <ul class="project-sessions"></ul>
      `;
      projectEl.dataset.projectId = projectId;

      const header = projectEl.querySelector('.project-header');
      const toggle = projectEl.querySelector('.project-toggle');
      const sessionsList = projectEl.querySelector('.project-sessions');
      const filesToggleBtn = projectEl.querySelector('.project-files-toggle');
      const tasksBtn = projectEl.querySelector('.project-tasks-btn');
      const quickAddBtn = projectEl.querySelector('.project-quick-add');
      const deleteBtn = projectEl.querySelector('.project-delete');

      // Toggle collapse (disabled for disabled projects)
      header.addEventListener('click', (e) => {
        if (e.target === deleteBtn || e.target === quickAddBtn || e.target === filesToggleBtn || e.target === tasksBtn || project.disabled) return;
        projectEl.classList.toggle('collapsed');
        toggle.textContent = projectEl.classList.contains('collapsed') ? '▶' : '▼';
      });

      // Toggle files
      filesToggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!project.disabled) {
          this.fileBrowser.toggleFileTree(projectId);
        }
      });

      // Show tasks panel
      tasksBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showTasksPanel(projectId);
      });

      // Quick add session
      quickAddBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!project.disabled) {
          this.showModal(projectId);
        }
      });

      // Delete project
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteProject(projectId);
      });

      // Render sessions for this project
      for (const session of sessions) {
        const li = document.createElement('li');
        li.className = `session-item ${session.id === this.currentSessionId ? 'active' : ''}`;
        li.innerHTML = `
          <div class="directory">${this.escapeHtml(this.shortenPath(session.directory))}</div>
          <div class="session-actions">
            <span class="status">${session.active ? 'Active' : 'Inactive'}</span>
            <button class="session-delete" title="Delete session">&times;</button>
          </div>
        `;
        const deleteBtn = li.querySelector('.session-delete');
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteSession(session.id);
        });
        if (!project.disabled) {
          li.addEventListener('click', () => {
            this.joinSession(session.id);
            this.toggleSidebar(false);
          });
        }
        sessionsList.appendChild(li);
      }

      // Render tasks for this project
      const projectTasks = this.scheduledTasks.filter(t => t.projectId === projectId);
      for (const task of projectTasks) {
        const taskLi = document.createElement('li');
        const isActiveTask = this.tabManager && this.tabManager.activeTabId === `task:${projectId}:${task.id}`;
        taskLi.className = `task-sidebar-item ${isActiveTask ? 'active' : ''}`;
        const statusInfo = this.getTaskStatusInfo(task);
        taskLi.innerHTML = `
          <span class="task-sidebar-icon">&#128337;</span>
          <span class="task-sidebar-name">${this.escapeHtml(task.name)}</span>
          <span class="task-sidebar-status ${statusInfo.className}">${statusInfo.label}</span>
        `;
        taskLi.addEventListener('click', () => {
          this.openTaskResult(projectId, task.id, task.name);
          this.toggleSidebar(false);
        });
        sessionsList.appendChild(taskLi);
      }

      this.elements.projectList.appendChild(projectEl);
    }

    // Render ungrouped sessions
    if (ungroupedSessions.length > 0) {
      const ungroupedEl = document.createElement('div');
      ungroupedEl.className = 'project-group ungrouped';
      ungroupedEl.innerHTML = `
        <div class="project-header">
          <span class="project-toggle">&#9662;</span>
          <span class="project-name">Ungrouped</span>
        </div>
        <ul class="project-sessions"></ul>
      `;

      const header = ungroupedEl.querySelector('.project-header');
      const toggle = ungroupedEl.querySelector('.project-toggle');
      const sessionsList = ungroupedEl.querySelector('.project-sessions');

      header.addEventListener('click', () => {
        ungroupedEl.classList.toggle('collapsed');
        toggle.textContent = ungroupedEl.classList.contains('collapsed') ? '&#9656;' : '&#9662;';
      });

      for (const session of ungroupedSessions) {
        const li = document.createElement('li');
        li.className = `session-item ${session.id === this.currentSessionId ? 'active' : ''}`;
        li.innerHTML = `
          <div class="directory">${this.escapeHtml(this.shortenPath(session.directory))}</div>
          <div class="session-actions">
            <span class="status">${session.active ? 'Active' : 'Inactive'}</span>
            <button class="session-delete" title="Delete session">&times;</button>
          </div>
        `;
        const deleteBtn = li.querySelector('.session-delete');
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.deleteSession(session.id);
        });
        li.addEventListener('click', () => {
          this.joinSession(session.id);
          this.toggleSidebar(false);
        });
        sessionsList.appendChild(li);
      }

      this.elements.projectList.appendChild(ungroupedEl);
    }
  }

  shortenPath(path) {
    const parts = path.split('/');
    if (parts.length > 3) {
      return '.../' + parts.slice(-2).join('/');
    }
    return path;
  }

  autoResizeTextarea() {
    const textarea = this.elements.userInput;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  }

  // Task scheduler methods
  async loadScheduledTasks() {
    try {
      const response = await fetch('/api/tasks', {
        headers: this.getAuthHeaders()
      });
      this.scheduledTasks = await response.json();
      this.renderProjectList(); // Update task counts
    } catch (err) {
      console.error('Failed to load scheduled tasks:', err);
    }
  }

  async loadTaskHistory(projectId, taskId) {
    try {
      const response = await fetch(`/api/tasks/${projectId}/${taskId}/history`, {
        headers: this.getAuthHeaders()
      });
      const history = await response.json();
      this.taskHistory.set(`${projectId}:${taskId}`, history);
      return history;
    } catch (err) {
      console.error('Failed to load task history:', err);
      return [];
    }
  }

  handleTaskStarted(data) {
    this.appendSystemMessage(`Task started: ${data.taskName} (${data.projectName})`);
    // Update task status in sidebar
    const task = this.scheduledTasks.find(t => t.projectId === data.projectId && t.id === data.taskId);
    if (task) {
      task.lastStatus = 'running';
      this.renderProjectList();
    }
  }

  handleTaskCompleted(data) {
    this.appendSystemMessage(`Task completed: ${data.taskName}`);

    // Update task status and clear cached history
    const task = this.scheduledTasks.find(t => t.projectId === data.projectId && t.id === data.taskId);
    if (task) {
      task.lastStatus = 'success';
    }
    this.taskHistory.delete(`${data.projectId}:${data.taskId}`);

    // Refresh result view if this task's tab is open
    const taskTabId = `task:${data.projectId}:${data.taskId}`;
    if (this.tabManager && this.tabManager.activeTabId === taskTabId) {
      this.showTaskResult(data.projectId, data.taskId);
    }

    // Refresh task list if modal is open
    if (!this.elements.tasksModal?.classList.contains('hidden')) {
      this.showTasksPanel(data.projectId);
    }

    this.renderProjectList();
  }

  handleTaskFailed(data) {
    this.appendSystemMessage(`Task failed: ${data.taskName} - ${data.error}`, 'error');

    // Update task status and clear cached history
    const task = this.scheduledTasks.find(t => t.projectId === data.projectId && t.id === data.taskId);
    if (task) {
      task.lastStatus = 'error';
    }
    this.taskHistory.delete(`${data.projectId}:${data.taskId}`);

    // Refresh result view if this task's tab is open
    const taskTabId = `task:${data.projectId}:${data.taskId}`;
    if (this.tabManager && this.tabManager.activeTabId === taskTabId) {
      this.showTaskResult(data.projectId, data.taskId);
    }

    this.renderProjectList();
  }

  getTaskCountForProject(projectId) {
    return this.scheduledTasks.filter(t => t.projectId === projectId).length;
  }

  showTasksPanel(projectId) {
    const project = this.projects.get(projectId);
    if (!project) return;

    this.currentTasksProjectId = projectId;
    this.elements.tasksProjectName.textContent = project.name;
    this.elements.tasksModal.classList.remove('hidden');
    this.elements.taskHistorySection.classList.add('hidden');

    this.renderTasksPanel(projectId);
  }

  hideTasksModal() {
    this.elements.tasksModal.classList.add('hidden');
    this.currentTasksProjectId = null;
  }

  renderTasksPanel(projectId) {
    const tasks = this.scheduledTasks.filter(t => t.projectId === projectId);

    if (tasks.length === 0) {
      this.elements.tasksList.innerHTML = `
        <div class="tasks-empty">
          No scheduled tasks. Create a <code>.tasks.json</code> file in the project root.
        </div>
      `;
      return;
    }

    this.elements.tasksList.innerHTML = tasks.map(task => `
      <div class="task-item" data-task-id="${task.id}">
        <div class="task-info">
          <div class="task-name">${this.escapeHtml(task.name)}</div>
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

    // Add event listeners
    this.elements.tasksList.querySelectorAll('.task-item').forEach(item => {
      const taskId = item.dataset.taskId;

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

  formatSchedule(schedule) {
    if (!schedule) return 'No schedule';

    switch (schedule.type) {
      case 'daily':
        return `Daily at ${schedule.time || '00:00'}`;
      case 'hourly':
        return `Hourly at :${String(schedule.minute || 0).padStart(2, '0')}`;
      case 'interval':
        return `Every ${schedule.minutes} minutes`;
      case 'weekly':
        return `${schedule.day} at ${schedule.time || '00:00'}`;
      case 'cron':
        return `Cron: ${schedule.expression}`;
      default:
        return 'Unknown schedule';
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

  async handleTaskToggle(projectId, taskId, enabled) {
    try {
      await fetch(`/api/tasks/${projectId}/${taskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders()
        },
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
        headers: this.getAuthHeaders()
      });
      this.appendSystemMessage('Task execution started...');
    } catch (err) {
      console.error('Failed to run task:', err);
      this.appendSystemMessage('Failed to start task', 'error');
    }
  }

  async showTaskHistory(projectId, taskId) {
    const history = await this.loadTaskHistory(projectId, taskId);
    this.renderTaskHistory(history);
    this.elements.taskHistorySection.classList.remove('hidden');
  }

  renderTaskHistory(history) {
    if (!history || history.length === 0) {
      this.elements.taskHistoryList.innerHTML = '<div class="task-history-empty">No execution history</div>';
      return;
    }

    this.elements.taskHistoryList.innerHTML = history.slice(0, 20).map(exec => `
      <div class="task-history-item task-status-${exec.status}">
        <div class="task-history-time">${new Date(exec.startedAt).toLocaleString()}</div>
        <div class="task-history-status">${exec.status}</div>
        ${exec.error ? `<div class="task-history-error">${this.escapeHtml(exec.error)}</div>` : ''}
        ${exec.response ? `<div class="task-history-response">${this.escapeHtml(exec.response.substring(0, 200))}${exec.response.length > 200 ? '...' : ''}</div>` : ''}
      </div>
    `).join('');
  }

  getTaskStatusInfo(task) {
    // Check for last execution status
    const historyKey = `${task.projectId}:${task.id}`;
    const history = this.taskHistory.get(historyKey);

    if (task.lastStatus === 'running') {
      return { className: 'status-running', label: 'Running' };
    }

    if (history && history.length > 0) {
      const latest = history[0];
      if (latest.status === 'success') {
        return { className: 'status-success', label: 'OK' };
      } else if (latest.status === 'error') {
        return { className: 'status-error', label: 'Failed' };
      } else if (latest.status === 'running') {
        return { className: 'status-running', label: 'Running' };
      }
    }

    if (task.lastStatus === 'success') {
      return { className: 'status-success', label: 'OK' };
    } else if (task.lastStatus === 'error') {
      return { className: 'status-error', label: 'Failed' };
    }

    return { className: 'status-pending', label: 'Pending' };
  }

  async openTaskResult(projectId, taskId, taskName) {
    // Load history if not cached
    const historyKey = `${projectId}:${taskId}`;
    if (!this.taskHistory.has(historyKey)) {
      await this.loadTaskHistory(projectId, taskId);
    }

    // Open the task tab
    this.tabManager.openTask(projectId, taskId, taskName);
  }

  showTaskResult(projectId, taskId) {
    const task = this.scheduledTasks.find(t => t.projectId === projectId && t.id === taskId);
    const historyKey = `${projectId}:${taskId}`;
    const history = this.taskHistory.get(historyKey) || [];

    // Set task name
    this.elements.taskResultName.textContent = task?.name || 'Task';

    if (history.length === 0) {
      this.elements.taskResultMeta.innerHTML = '';
      this.elements.taskResultBody.innerHTML = '<div class="task-result-empty">No executions yet</div>';
      return;
    }

    const latest = history[0];

    // Render metadata
    const statusClass = latest.status === 'success' ? 'status-success' :
                        latest.status === 'error' ? 'status-error' : 'status-running';
    const startTime = new Date(latest.startedAt).toLocaleString();
    const endTime = latest.completedAt ? new Date(latest.completedAt).toLocaleString() : 'In progress';

    this.elements.taskResultMeta.innerHTML = `
      <span class="task-meta-item">
        <span class="task-meta-status ${statusClass}">${latest.status}</span>
      </span>
      <span class="task-meta-item">Started: ${startTime}</span>
      ${latest.completedAt ? `<span class="task-meta-item">Completed: ${endTime}</span>` : ''}
    `;

    // Render body
    let bodyHtml = '';
    if (latest.error) {
      bodyHtml += `<div class="task-result-error">${this.escapeHtml(latest.error)}</div>`;
    }
    if (latest.response) {
      bodyHtml += this.escapeHtml(latest.response);
    }
    if (!latest.error && !latest.response) {
      bodyHtml = '<div class="task-result-empty">No output</div>';
    }

    this.elements.taskResultBody.innerHTML = bodyHtml;
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  window.client = new EveWorkspaceClient();
});
