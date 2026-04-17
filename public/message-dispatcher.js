/**
 * MessageDispatcher - handles server message routing and LLM event processing.
 * Extracted from EveWorkspaceClient to separate message dispatch from orchestration.
 */
class MessageDispatcher {
  /**
   * @param {Container} container - DI container.
   * Each dependency injected individually — no god-object reference.
   * `app` is retained only for UI orchestration methods (showChatScreen, etc.)
   * that haven't been extracted into their own services yet.
   */
  constructor(container) {
    this.log = container.get('logger').child('Dispatch');
    // Injected services — each can be mocked independently for testing
    this.renderer = container.get('messageRenderer');
    this.modalManager = container.get('modalManager');
    this.tabManager = container.get('tabManager');
    this.sidebar = container.get('sidebarRenderer');
    this.terminal = container.get('terminalManager');
    this.fileBrowser = container.get('fileBrowser');
    this.tts = container.get('ttsManager');
    this.stt = container.get('sttManager');
    this.voice = container.get('voiceChatManager');
    this.taskManager = container.get('taskManager');
    this.state = container.get('state');
    this.ws = container.get('ws');
    this.bus = container.get('bus');
    // App retained for UI orchestration only (showChatScreen, hideStopButton, etc.)
    this.app = container.get('app');

    this.pendingInteractiveTool = null;
    this.lastPlanFilePath = null;
    this._lastNonInteractiveToolName = null;
    this.backgroundBuffers = new Map();
    this.streamingSessions = new Set();
    this._lastTurnMetrics = null;
    this._localSubmitSession = null; // session ID of the last locally submitted message

    this._sessionScopedTypes = new Set([
      'llm_event', 'message_complete', 'stats_update', 'raw_output',
      'stderr', 'process_exited', 'error', 'system_message', 'clear_messages',
      'user_message',
    ]);

    this._handlers = {
      session_created:      (d) => this.handleSessionCreated(d),
      session_joined:       (d) => this.handleSessionJoined(d),
      session_renamed:      (d) => this.handleSessionRenamed(d),
      session_ended:        (d) => this.handleSessionEnded(d),
      user_message:         (d) => this._handleUserMessage(d),
      llm_event:            (d) => this._handleLlmEventMessage(d),
      raw_output:           (d) => this.renderer.appendRawOutput(d.text),
      stderr:               (d) => this.renderer.appendSystemMessage(d.text, 'error'),
      process_exited:       (d) => this._handleProcessExited(d),
      error:                (d) => this._handleError(d),
      system_message:       (d) => this.renderer.appendSystemMessage(d.message),
      clear_messages:       ()  => this.renderer.clearMessages(),
      message_complete:     (d) => this._handleMessageComplete(d),
      stats_update:         (d) => { this._captureTurnMetrics(d.stats); this.app.updateStats(d.stats); },
      tts_audio:            (d) => this._handleTtsAudio(d),
      tts_error:            (d) => this._handleTtsError(d),
      transcription_result: (d) => this.stt?.handleTranscriptionResult(d.text),
      transcription_error:  (d) => this.stt?.handleTranscriptionError(d.error),
      directory_listing:    (d) => this._handleDirectoryListing(d),
      file_content:         (d) => this.app.handleFileContent(d.projectId, d.path, d.content),
      plan_file_content:    (d) => this.app.handleFileContent(PLAN_PROJECT_ID, d.path, d.content),
      file_error:           (d) => this.fileBrowser.handleFileError(d.projectId, d.path, d.error),
      file_saved:           (d) => this.app.handleFileSaved(d.projectId, d.path),
      file_renamed:         (d) => this._handleFileEvent(d, 'handleFileRenamed', [d.projectId, d.oldPath, d.newPath], EVT.FILE_RENAMED),
      file_moved:           (d) => this._handleFileEvent(d, 'handleFileMoved', [d.projectId, d.oldPath, d.newPath], EVT.FILE_MOVED),
      file_deleted:         (d) => this._handleFileEvent(d, 'handleFileDeleted', [d.projectId, d.path], EVT.FILE_DELETED),
      directory_created:    (d) => this._handleFileEvent(d, 'handleDirectoryCreated', [d.projectId, d.path, d.name], EVT.DIRECTORY_CREATED),
      file_uploaded:        (d) => this._handleFileEvent(d, 'handleFileUploaded', [d.projectId, d.destDirectory, d.fileName], EVT.FILE_UPLOADED),
      file_changed:         (d) => this.app.handleFileChanged(d.projectId, d.path, d.content),
      terminal_created:     (d) => this.terminal.onTerminalCreated(d.terminalId, d.templateId, d.name, d.directory),
      terminal_joined:      (d) => this.terminal.onTerminalJoined(d),
      terminal_output:      (d) => this.terminal.onTerminalOutput(d.terminalId, d.data),
      terminal_exit:        (d) => this.terminal.onTerminalExit(d.terminalId, d.exitCode),
      terminal_closed:      (d) => this.terminal.onTerminalExit(d.terminalId, 0),
      terminal_list:        (d) => this.terminal.onTerminalList(d.terminals),
      terminal_templates:   (d) => this._handleTerminalTemplates(d),
      permission_request:   (d) => this.modalManager.showPermissionModal(d),
      warning:              (d) => this.renderer.appendSystemMessage(d.message, 'warning'),
      task_started:         (d) => this.handleSchedulerTaskEvent(d),
      task_completed:       (d) => this.handleSchedulerTaskEvent(d),
      task_error:           (d) => this.handleSchedulerTaskEvent(d),
      task_status:          (d) => this.handleSchedulerTaskStatus(d),
    };
  }

  dispatch(data) {
    // Route session-scoped events to the correct session.
    // If the event has a sessionId that doesn't match the current visible session,
    // buffer it for that session instead of rendering it.
    if (data.sessionId && data.sessionId !== this.state.currentSessionId && this._sessionScopedTypes.has(data.type)) {
      this._handleBackgroundEvent(data);
      return;
    }

    const handler = this._handlers[data.type];
    if (handler) handler(data);
  }

  // --- Dispatch helpers (extracted from inline switch cases) ---

  _trackStreaming(sessionId) {
    if (sessionId) this.streamingSessions.add(sessionId);
  }

  _untrackStreaming(sessionId) {
    if (sessionId) this.streamingSessions.delete(sessionId);
  }

  /** Reset all per-turn state. Called on user-initiated stop so stale
   *  data from the cancelled turn doesn't bleed into the next one. */
  resetTurnState(sessionId) {
    this._untrackStreaming(sessionId);
    this.pendingInteractiveTool = null;
    this._lastTurnMetrics = null;
    this._clientTTSAccum = '';
    this._lastNonInteractiveToolName = null;
  }

  _notifyVoiceError(message) {
    this.voice?.handleError(message);
  }

  _captureTurnMetrics(stats) {
    if (!stats) return;
    const ttft = stats.timeToFirstToken;
    const tps = stats.tokensPerSecond;
    if (ttft || tps) {
      this._lastTurnMetrics = { ttft, tps };
    }
  }

  /** Mark a session as locally submitted so its server echo is suppressed. */
  markLocalSubmit(sessionId) {
    this._localSubmitSession = sessionId;
  }

  _handleUserMessage(data) {
    // Sending window already rendered this optimistically — skip the echo.
    if (this._localSubmitSession === data.sessionId) {
      this._localSubmitSession = null;
      return;
    }
    // Passive window: render the user message and transition to generating state.
    this.renderer.appendUserMessage(data.text);
    this.renderer.showThinkingIndicator();
    this.app.showStopButton();
  }

  _handleLlmEventMessage(data) {
    this._trackStreaming(data.sessionId);
    this.handleLlmEvent(data.event);
  }

  _handleProcessExited(data) {
    this._untrackStreaming(data.sessionId);
    this.renderer.hideThinkingIndicator();
    this.renderer.appendSystemMessage('Provider process exited. Will restart on next message.');
    this.app.hideStopButton();
  }

  _handleError(data) {
    this._untrackStreaming(data.sessionId);
    this.renderer.hideThinkingIndicator();
    this.renderer.appendSystemMessage(data.message, 'error');
    this._notifyVoiceError(data.message);
    this.app.hideStopButton();
  }

  _handleMessageComplete(data) {
    this._untrackStreaming(data.sessionId);
    if (this.pendingInteractiveTool) {
      const tool = this.pendingInteractiveTool;
      this.pendingInteractiveTool = null;
      // If we accumulated raw JSON string, parse it now
      if (tool._rawInput) {
        try { Object.assign(tool.input, JSON.parse(tool._rawInput)); } catch {}
      }
      this.handleInteractiveTool(tool.name, tool.input);
      return;
    }
    const hadContent = !!this.renderer.currentAssistantMessage;
    this.renderer.hideThinkingIndicator();
    const metrics = this._lastTurnMetrics;
    this._lastTurnMetrics = null;
    this.renderer.finishAssistantMessage(metrics);
    this.app.hideStopButton();
    if (!hadContent && !data.error) {
      const msg = data.errorMessage || 'No response from model';
      this.renderer.appendSystemMessage(msg, 'error');
      this._notifyVoiceError(msg);
    } else if (data.error) {
      this.renderer.appendSystemMessage(data.error, 'error');
      this._notifyVoiceError(data.error);
    }
    this.voice?.handleResponseComplete();
    // Client-side TTS for text sessions (voice sessions handled by voiceChatManager)
    if (this._clientTTSAccum && !this.voice?.isVoiceSession) {
      this.tts.speakText(this._clientTTSAccum);
    }
    this._clientTTSAccum = '';
  }

  _handleTtsAudio(data) {
    this.tts?.enqueueAudio(data.data);
    this.voice?.handleTTSStart();
  }

  _handleTtsError(data) {
    this.log.warn('TTS error:', data.message);
    this._notifyVoiceError(`Speech failed: ${data.message}`);
    if (!this.voice?.isVoiceSession) {
      this.renderer.appendSystemMessage(`TTS error: ${data.message}`, 'error');
    }
  }

  _handleDirectoryListing(data) {
    this.fileBrowser.handleDirectoryListing(data.projectId, data.path, data.entries);
    if (this.bus) this.bus.emit(EVT.DIRECTORY_LISTING, data);
  }

  _handleFileEvent(data, fileBrowserMethod, args, busEvent) {
    this.fileBrowser[fileBrowserMethod](...args);
    if (this.bus) this.bus.emit(busEvent, data);
  }

  _handleTerminalTemplates(data) {
    this.terminal.onTemplates(data.templates);
    this.state.setTerminalTemplates(data.templates || []);
    if (this.terminal._pendingPickerDirectory !== undefined) {
      const dir = this.terminal._pendingPickerDirectory;
      delete this.terminal._pendingPickerDirectory;
      this.terminal._showPickerUI(dir);
    }
    if (this.bus) this.bus.emit(EVT.TERMINAL_TEMPLATES, data);
  }

  handleSchedulerTaskEvent(data) {
    const task = this.state.getTask(data.taskId);
    if (!task) return;

    const oldSessionId = task.lastSessionId;

    // Update task state via StateStore
    const updates = {};
    if (data.type === 'task_started') {
      updates.lastStatus = 'running';
      if (data.sessionId) updates.lastSessionId = data.sessionId;
    } else if (data.type === 'task_completed') {
      updates.lastStatus = data.status || 'success';
      if (data.sessionId) updates.lastSessionId = data.sessionId;
    } else if (data.type === 'task_error') {
      updates.lastStatus = 'error';
    }
    this.state.updateTask(data.taskId, updates);

    // Emit typed event for subscribers
    if (data.type === 'task_started') this.bus.emit(EVT.TASK_STARTED, data);
    else if (data.type === 'task_completed') this.bus.emit(EVT.TASK_COMPLETED, data);
    else if (data.type === 'task_error') this.bus.emit(EVT.TASK_ERROR, data);

    // Task session replacement: close old, join new
    if (data.type === 'task_started' && this.taskManager?.userTriggeredRuns.has(data.taskId) && data.sessionId) {
      if (oldSessionId) {
        this.tabManager.closeTab(oldSessionId);
        this.state.removeSession(oldSessionId);
      }
      this.app.joinSession(data.sessionId);
    }

    if (data.type === 'task_completed' || data.type === 'task_error') {
      this.taskManager?.userTriggeredRuns.delete(data.taskId);
      // Reload from server to get full updated task state
      this.taskManager?.loadTasks(data.projectId);
    }
  }

  handleSchedulerTaskStatus(data) {
    if (!Array.isArray(data.running)) return;
    for (const item of data.running) {
      this.state.updateTask(item.taskId, {
        lastStatus: 'running',
        ...(item.sessionId && { lastSessionId: item.sessionId }),
      });
    }
  }

  // --- Background session buffering ---

  _handleBackgroundEvent(data) {
    const sid = data.sessionId;

    if (data.type === 'stats_update') {
      // Always update session stats object even for background sessions
      const session = this.state.sessions.get(sid);
      if (session && data.stats) {
        session.costUsd = data.stats.costUsd || 0;
      }
      return;
    }

    if (data.type === 'user_message') {
      // Store user message in background session history
      let history = this.state.sessionHistories.get(sid);
      if (!history) {
        history = [];
        this.state.sessionHistories.set(sid, history);
      }
      history.push({ role: 'user', content: data.text });
      return;
    }

    if (data.type === 'llm_event') {
      this.streamingSessions.add(sid);
      const event = data.event;
      if (!event) return;

      let buf = this.backgroundBuffers.get(sid);
      if (!buf) {
        buf = { contentBlocks: [] };
        this.backgroundBuffers.set(sid, buf);
      }

      // Accumulate structured content blocks from streaming events
      if (event.type === 'assistant') {
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              buf.contentBlocks.push({ type: 'text', text: block.text });
            } else if (block.type === 'tool_use') {
              buf.contentBlocks.push({ type: 'tool_use', name: block.name, input: block.input });
            }
          }
        } else if (event.delta?.type === 'text_delta') {
          const last = buf.contentBlocks[buf.contentBlocks.length - 1];
          if (last && last.type === 'text') {
            last.text += event.delta.text;
          } else {
            buf.contentBlocks.push({ type: 'text', text: event.delta.text });
          }
        } else if (event.content_block?.type === 'text') {
          buf.contentBlocks.push({ type: 'text', text: event.content_block.text });
        } else if (event.content_block?.type === 'tool_use') {
          buf.contentBlocks.push({ type: 'tool_use', name: event.content_block.name, input: event.content_block.input || {} });
        }
      } else if (event.type === 'result' && event.subtype === 'tool_result') {
        // Mark the last tool_use block as completed
        const last = buf.contentBlocks[buf.contentBlocks.length - 1];
        if (last && last.type === 'tool_use') {
          last.completed = true;
        }
      }
      return;
    }

    if (data.type === 'message_complete') {
      this.streamingSessions.delete(sid);
      // Flush accumulated content blocks as a completed assistant message
      const buf = this.backgroundBuffers.get(sid);
      if (buf && buf.contentBlocks.length > 0) {
        let history = this.state.sessionHistories.get(sid);
        if (!history) {
          history = [];
          this.state.sessionHistories.set(sid, history);
        }
        history.push({ role: 'assistant', content: buf.contentBlocks });
        buf.contentBlocks = [];
      }
      return;
    }

    if (data.type === 'error' || data.type === 'process_exited') {
      this.streamingSessions.delete(sid);
      return;
    }

    // Other background events (stderr, etc.) -- ignore silently
  }

  /**
   * Flush any buffered background content for a session when switching to it.
   * Called by TabManager.switchToTab before renderMessages.
   */
  flushBackgroundBuffer(sessionId) {
    const buf = this.backgroundBuffers.get(sessionId);
    if (!buf) return;

    // If there are partial content blocks still streaming (no message_complete yet),
    // save them to history so they render on tab switch.
    if (buf.contentBlocks.length > 0) {
      const history = this.state.sessionHistories.get(sessionId);
      if (history) {
        history.push({ role: 'assistant', content: buf.contentBlocks });
      }
      buf.contentBlocks = [];
    }
    this.backgroundBuffers.delete(sessionId);
  }

  // --- Session event handlers ---

  handleSessionCreated(data) {
    const session = {
      id: data.sessionId,
      directory: data.directory,
      projectId: data.projectId || null,
      name: data.name || null,
      model: data.model || null,
      active: true,
      sessionType: data.sessionType || null,
    };
    this.state.addSession(session);
    this.state.currentSessionId = data.sessionId;
    this.state.sessionHistories.set(data.sessionId, []);
    this.app.showChatScreen();
    this.tabManager.openSession(data.sessionId);
    this.sidebar.renderProjectList();
    this.modalManager.hideSessionModal();
    this.modalManager.hidePlanApproval();

    if (data.sessionType === 'voice') {
      this.app.enableVoiceMode(data.voice);
    }
  }

  handleSessionJoined(data) {
    this.state.currentSessionId = data.sessionId;

    // Restore sessionType from localStorage if not provided by server
    const savedMeta = this.tabManager.getSessionMeta(data.sessionId);
    const sessionType = data.sessionType || savedMeta?.sessionType || null;

    const existingSession = this.state.sessions.get(data.sessionId);
    if (existingSession) {
      if (data.name !== undefined) {
        existingSession.name = data.name || existingSession.name;
      }
      if (data.model) {
        existingSession.model = data.model;
      }
      if (sessionType && !existingSession.sessionType) {
        existingSession.sessionType = sessionType;
      }
    } else {
      const newSession = {
        id: data.sessionId,
        directory: data.directory,
        projectId: data.projectId || null,
        name: data.name || null,
        model: data.model || null,
        active: true,
        sessionType,
      };
      this.state.addSession(newSession);
    }

    if (data.headless) {
      this.state.taskSessionIds.add(data.sessionId);
    }

    const serverHistory = (data.history && data.history.length > 0) ? data.history : [];
    this.state.sessionHistories.set(data.sessionId, serverHistory);

    // Silent refresh: update stored history without touching the DOM.
    // Used by the deferred re-join after task completion.
    if (this._silentHistoryRefresh === data.sessionId) {
      this._silentHistoryRefresh = null;
      if (data.stats) this.app.updateStats(data.stats);
      return;
    }

    this.flushBackgroundBuffer(data.sessionId);
    this.app.showChatScreen();

    // Task completion: content is already live-streamed on screen — bind
    // the session tab without clearing/re-rendering the DOM.
    if (this._taskCompletionJoin === data.sessionId) {
      this._taskCompletionJoin = null;
      this.tabManager.openSession(data.sessionId, { skipRender: true });
    } else {
      this.renderer.clearMessages();
      this.tabManager.openSession(data.sessionId);
      this.app.renderMessages();
    }

    this.sidebar.renderProjectList();
    this.modalManager.hidePlanApproval();
    if (data.stats) {
      this.app.updateStats(data.stats);
    }

    if (sessionType === 'voice') {
      this.app.enableVoiceMode();
    }
  }

  handleSessionRenamed(data) {
    const renamedSession = this.state.sessions.get(data.sessionId);
    if (renamedSession) renamedSession.name = data.name;
    if (this.sidebar.renamingSessionId !== data.sessionId) {
      this.sidebar.renderProjectList();
    }
    if (this.tabManager) {
      this.tabManager.updateTabLabel(data.sessionId, data.name || this.app.getSessionDisplayName(data.sessionId));
    }
  }

  handleSessionEnded(data) {
    this.state.removeSession(data.sessionId);
    this.tabManager.closeTab(data.sessionId);
    if (this.state.currentSessionId === data.sessionId) {
      this.state.currentSessionId = null;
      this.app.showWelcomeScreen();
    }
    this.sidebar.renderProjectList();
  }

  // --- LLM event handling ---

  handleLlmEvent(event) {
    switch (event.type) {
      case 'user':
        // Echoed back from relay -- already rendered client-side on submit
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
            this.renderer.startAssistantMessage(block.text);
          } else if (block.type === 'tool_use') {
            if (block.name === 'Write' && block.input?.file_path && /\.claude\/plans\//.test(block.input.file_path)) {
              this.lastPlanFilePath = block.input.file_path;
            }
            if (!this.handleInteractiveTool(block.name, block.input)) {
              this.renderer.appendToolUse(block.name, block.input);
            }
          }
        }
      }
    } else if (event.content_block) {
      if (event.content_block.type === 'text') {
        this.renderer.updateAssistantMessage(event.content_block.text);
      } else if (event.content_block.type === 'tool_use') {
        if (this.isInteractiveTool(event.content_block.name)) {
          this.pendingInteractiveTool = { name: event.content_block.name, input: event.content_block.input || {} };
        } else {
          this._lastNonInteractiveToolName = event.content_block.name;
          this.renderer.appendToolUse(event.content_block.name, event.content_block.input);
        }
      } else if (event.content_block.type === 'tool_use_input') {
        if (this.pendingInteractiveTool) {
          if (typeof event.content_block.input === 'string') {
            try {
              Object.assign(this.pendingInteractiveTool.input, JSON.parse(event.content_block.input));
            } catch {
              // partial JSON chunk, accumulate as string
              this.pendingInteractiveTool._rawInput = (this.pendingInteractiveTool._rawInput || '') + event.content_block.input;
            }
          } else if (event.content_block.input && typeof event.content_block.input === 'object') {
            Object.assign(this.pendingInteractiveTool.input, event.content_block.input);
          }
        } else {
          // Track plan file path from streaming Write tool input
          if (this._lastNonInteractiveToolName === 'Write') {
            const input = event.content_block.input;
            const filePath = typeof input === 'object' ? input?.file_path : null;
            if (filePath && /\.claude\/plans\//.test(filePath)) {
              this.lastPlanFilePath = filePath;
            }
          }
          this.renderer.updateToolInput(event.content_block.input);
        }
      }
    } else if (event.delta) {
      if (event.delta.type === 'text_delta') {
        this.renderer.appendToAssistantMessage(event.delta.text);
        this.voice?.handleAssistantDelta(event.delta.text);
        // Accumulate for client-side TTS in text sessions (browser and native backends)
        if (this.tts?.activeBackend?.onDevice && this.tts?.enabled) {
          this._clientTTSAccum = (this._clientTTSAccum || '') + event.delta.text;
        }
      }
    }
  }

  handleResultEvent(event) {
    if (event.subtype === 'error') {
      this.renderer.appendSystemMessage(`Tool error: ${event.error}`, 'error');
    } else if (event.subtype === 'tool_progress') {
      this.renderer.updateToolProgress(event.tool_name, event.message);
    } else if (event.subtype === 'tool_result') {
      if (event.content) this.renderer.appendToolResult(event.content);
      this.renderer.markToolComplete();
    }
  }

  // --- Interactive tool handling ---

  isInteractiveTool(name) {
    return name === 'ExitPlanMode' || name === 'AskUserQuestion';
  }

  handleInteractiveTool(name, input) {
    if (name === 'ExitPlanMode') {
      this.handleExitPlanMode();
      return true;
    }
    if (name === 'AskUserQuestion') {
      this.handleAskUserQuestion(input);
      return true;
    }
    return false;
  }

  handleExitPlanMode() {
    this.renderer.hideThinkingIndicator();
    this.app.hideStopButton();

    // Open the plan file in the editor if we tracked the path
    if (this.lastPlanFilePath) {
      this.ws.send({ type: 'read_plan_file', path: this.lastPlanFilePath });
      this.lastPlanFilePath = null;
    }

    this.modalManager.showPlanApproval((approved) => {
      if (approved) {
        this.renderer.appendUserMessage('Yes, proceed with the plan.');
        this.markLocalSubmit(this.state.currentSessionId);
        this.ws.send({ type: 'user_input', text: 'Yes, proceed with the plan.', sessionId: this.state.currentSessionId });
        this.renderer.showThinkingIndicator();
        this.app.showStopButton();
      } else {
        this.app.elements.userInput.placeholder = 'Describe what to change in the plan...';
        this.app.elements.userInput.focus();
      }
    });
  }

  handleAskUserQuestion(input) {
    this.renderer.hideThinkingIndicator();
    this.app.hideStopButton();
    this.renderer.finishAssistantMessage();

    const questions = input && input.questions;
    if (!questions || !Array.isArray(questions) || questions.length === 0) return;

    this.renderer.renderQuestionBlock(questions, (responseText) => {
      this.renderer.appendUserMessage(responseText);
      this.markLocalSubmit(this.state.currentSessionId);
      this.ws.send({ type: 'user_input', text: responseText, sessionId: this.state.currentSessionId });
      this.renderer.showThinkingIndicator();
      this.app.showStopButton();
    });
  }

  handleSystemEvent(event) {
    if (event.subtype === 'permission_request') {
      this.modalManager.showPermissionPrompt(event.message || 'Permission requested');
    } else if (event.subtype === 'question') {
      this.modalManager.showInputPrompt(event.message || 'Assistant is asking a question');
    } else if (event.subtype === 'status') {
      if (event.message) {
        this.renderer.updateThinkingIndicator(event.message);
      } else {
        this.renderer.hideThinkingIndicator();
      }
    } else if (event.message) {
      this.renderer.appendSystemMessage(event.message);
    }
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageDispatcher;
}
