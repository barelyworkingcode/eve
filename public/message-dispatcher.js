/**
 * MessageDispatcher - handles server message routing and LLM event processing.
 * Extracted from EveWorkspaceClient to separate message dispatch from orchestration.
 */
class MessageDispatcher {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.client = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.pendingInteractiveTool = null;
    this.lastPlanFilePath = null;
    this._lastNonInteractiveToolName = null;
    // Background buffers: sessionId -> { contentBlocks: ContentBlock[] }
    this.backgroundBuffers = new Map();
    // Set of sessionIds that are currently streaming
    this.streamingSessions = new Set();

    this._sessionScopedTypes = new Set([
      'llm_event', 'message_complete', 'stats_update', 'raw_output',
      'stderr', 'process_exited', 'error', 'system_message', 'clear_messages',
    ]);

    this._handlers = {
      session_created:      (d) => this.handleSessionCreated(d),
      session_joined:       (d) => this.handleSessionJoined(d),
      session_renamed:      (d) => this.handleSessionRenamed(d),
      session_ended:        (d) => this.handleSessionEnded(d),
      llm_event:            (d) => this._handleLlmEventMessage(d),
      raw_output:           (d) => this.client.messageRenderer.appendRawOutput(d.text),
      stderr:               (d) => this.client.messageRenderer.appendSystemMessage(d.text, 'error'),
      process_exited:       (d) => this._handleProcessExited(d),
      error:                (d) => this._handleError(d),
      system_message:       (d) => this.client.messageRenderer.appendSystemMessage(d.message),
      clear_messages:       ()  => this.client.messageRenderer.clearMessages(),
      message_complete:     (d) => this._handleMessageComplete(d),
      stats_update:         (d) => this.client.updateStats(d.stats),
      tts_audio:            (d) => this._handleTtsAudio(d),
      tts_error:            (d) => this._handleTtsError(d),
      transcription_result: (d) => this.client.sttManager?.handleTranscriptionResult(d.text),
      transcription_error:  (d) => this.client.sttManager?.handleTranscriptionError(d.error),
      directory_listing:    (d) => this._handleDirectoryListing(d),
      file_content:         (d) => this.client.handleFileContent(d.projectId, d.path, d.content),
      plan_file_content:    (d) => this.client.handleFileContent(PLAN_PROJECT_ID, d.path, d.content),
      file_error:           (d) => this.client.fileBrowser.handleFileError(d.projectId, d.path, d.error),
      file_saved:           (d) => this.client.handleFileSaved(d.projectId, d.path),
      file_renamed:         (d) => this._handleFileEvent(d, 'handleFileRenamed', [d.projectId, d.oldPath, d.newPath], EVT.FILE_RENAMED),
      file_moved:           (d) => this._handleFileEvent(d, 'handleFileMoved', [d.projectId, d.oldPath, d.newPath], EVT.FILE_MOVED),
      file_deleted:         (d) => this._handleFileEvent(d, 'handleFileDeleted', [d.projectId, d.path], EVT.FILE_DELETED),
      directory_created:    (d) => this._handleFileEvent(d, 'handleDirectoryCreated', [d.projectId, d.path, d.name], EVT.DIRECTORY_CREATED),
      file_uploaded:        (d) => this._handleFileEvent(d, 'handleFileUploaded', [d.projectId, d.destDirectory, d.fileName], EVT.FILE_UPLOADED),
      file_changed:         (d) => this.client.handleFileChanged(d.projectId, d.path, d.content),
      terminal_created:     (d) => this.client.terminalManager.onTerminalCreated(d.terminalId, d.templateId, d.name, d.directory),
      terminal_joined:      (d) => this.client.terminalManager.onTerminalJoined(d),
      terminal_output:      (d) => this.client.terminalManager.onTerminalOutput(d.terminalId, d.data),
      terminal_exit:        (d) => this.client.terminalManager.onTerminalExit(d.terminalId, d.exitCode),
      terminal_closed:      (d) => this.client.terminalManager.onTerminalExit(d.terminalId, 0),
      terminal_list:        (d) => this.client.terminalManager.onTerminalList(d.terminals),
      terminal_templates:   (d) => this._handleTerminalTemplates(d),
      permission_request:   (d) => this.client.modalManager.showPermissionModal(d),
      warning:              (d) => this.client.messageRenderer.appendSystemMessage(d.message, 'warning'),
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
    if (data.sessionId && data.sessionId !== this.client.currentSessionId && this._sessionScopedTypes.has(data.type)) {
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

  _notifyVoiceError(message) {
    this.client.voiceChatManager?.handleError(message);
  }

  _handleLlmEventMessage(data) {
    this._trackStreaming(data.sessionId);
    this.handleLlmEvent(data.event);
  }

  _handleProcessExited(data) {
    this._untrackStreaming(data.sessionId);
    this.client.messageRenderer.hideThinkingIndicator();
    this.client.messageRenderer.appendSystemMessage('Provider process exited. Will restart on next message.');
    this.client.hideStopButton();
  }

  _handleError(data) {
    this._untrackStreaming(data.sessionId);
    this.client.messageRenderer.hideThinkingIndicator();
    this.client.messageRenderer.appendSystemMessage(data.message, 'error');
    this._notifyVoiceError(data.message);
    this.client.hideStopButton();
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
    const hadContent = !!this.client.messageRenderer.currentAssistantMessage;
    this.client.messageRenderer.hideThinkingIndicator();
    this.client.messageRenderer.finishAssistantMessage();
    this.client.hideStopButton();
    if (!hadContent && !data.error) {
      const msg = data.errorMessage || 'No response from model';
      this.client.messageRenderer.appendSystemMessage(msg, 'error');
      this._notifyVoiceError(msg);
    } else if (data.error) {
      this.client.messageRenderer.appendSystemMessage(data.error, 'error');
      this._notifyVoiceError(data.error);
    }
    this.client.voiceChatManager?.handleResponseComplete();
    // Client-side TTS for text sessions (voice sessions handled by voiceChatManager)
    if (this._clientTTSAccum && !this.client.voiceChatManager?.isVoiceSession) {
      this.client.ttsManager.speakText(this._clientTTSAccum);
    }
    this._clientTTSAccum = '';
  }

  _handleTtsAudio(data) {
    this.client.ttsManager?.enqueueAudio(data.data);
    this.client.voiceChatManager?.handleTTSStart();
  }

  _handleTtsError(data) {
    console.warn('[TTS] Error:', data.message);
    this._notifyVoiceError(`Speech failed: ${data.message}`);
    if (!this.client.voiceChatManager?.isVoiceSession) {
      this.client.messageRenderer.appendSystemMessage(`TTS error: ${data.message}`, 'error');
    }
  }

  _handleDirectoryListing(data) {
    this.client.fileBrowser.handleDirectoryListing(data.projectId, data.path, data.entries);
    if (this.client.bus) this.client.bus.emit(EVT.DIRECTORY_LISTING, data);
  }

  _handleFileEvent(data, fileBrowserMethod, args, busEvent) {
    this.client.fileBrowser[fileBrowserMethod](...args);
    if (this.client.bus) this.client.bus.emit(busEvent, data);
  }

  _handleTerminalTemplates(data) {
    this.client.terminalManager.onTemplates(data.templates);
    if (this.client.terminalManager._pendingPickerDirectory !== undefined) {
      const dir = this.client.terminalManager._pendingPickerDirectory;
      delete this.client.terminalManager._pendingPickerDirectory;
      this.client.terminalManager._showPickerUI(dir);
    }
    if (this.client.bus) this.client.bus.emit(EVT.TERMINAL_TEMPLATES, data);
  }

  handleSchedulerTaskEvent(data) {
    const taskManager = this.client.taskManager;
    if (!taskManager) return;

    // Capture old session ID before handleTaskEvent overwrites task.lastSessionId
    const task = taskManager.tasks.get(data.taskId);
    const oldTaskSessionId = task?.lastSessionId;

    taskManager.handleTaskEvent(data);
    this.client.sidebarRenderer.renderProjectList();

    if (data.type === 'task_started') {
      // Join immediately on start so the user sees output streaming live.
      if (taskManager.userTriggeredRuns.has(data.taskId) && data.sessionId) {
        // Close the old task session tab
        if (oldTaskSessionId) {
          this.client.tabManager.closeTab(oldTaskSessionId);
          this.client.sessions.delete(oldTaskSessionId);
          this.client.sessionHistories.delete(oldTaskSessionId);
        }
        this.client.joinSession(data.sessionId);
      }
    }

    if (data.type === 'task_completed') {
      if (taskManager.userTriggeredRuns.has(data.taskId)) {
        taskManager.userTriggeredRuns.delete(data.taskId);
      }
    }

    if (data.type === 'task_error') {
      taskManager.userTriggeredRuns.delete(data.taskId);
    }

    // Reload full task state from HTTP to sync on terminal events
    if (data.type === 'task_completed' || data.type === 'task_error') {
      taskManager.loadTasks(data.projectId).then(() => {
        this.client.sidebarRenderer.renderProjectList();
      });
    }
  }

  handleSchedulerTaskStatus(data) {
    const taskManager = this.client.taskManager;
    if (!taskManager) return;

    taskManager.handleTaskStatus(data);
    this.client.sidebarRenderer.renderProjectList();
  }

  // --- Background session buffering ---

  _handleBackgroundEvent(data) {
    const sid = data.sessionId;

    if (data.type === 'stats_update') {
      // Always update session stats object even for background sessions
      const session = this.client.sessions.get(sid);
      if (session && data.stats) {
        session.costUsd = data.stats.costUsd || 0;
      }
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
        let history = this.client.sessionHistories.get(sid);
        if (!history) {
          history = [];
          this.client.sessionHistories.set(sid, history);
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
      const history = this.client.sessionHistories.get(sessionId);
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
    this.client.state.addSession(session);
    this.client.currentSessionId = data.sessionId;
    this.client.sessionHistories.set(data.sessionId, []);
    this.client.showChatScreen();
    this.client.tabManager.openSession(data.sessionId);
    this.client.sidebarRenderer.renderProjectList();
    this.client.modalManager.hideSessionModal();
    this.client.modalManager.hidePlanApproval();

    if (data.sessionType === 'voice') {
      this.client.enableVoiceMode(data.voice);
    }
  }

  handleSessionJoined(data) {
    this.client.currentSessionId = data.sessionId;

    // Restore sessionType from localStorage if not provided by server
    const savedMeta = this.client.tabManager.getSessionMeta(data.sessionId);
    const sessionType = data.sessionType || savedMeta?.sessionType || null;

    const existingSession = this.client.sessions.get(data.sessionId);
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
      this.client.state.addSession(newSession);
    }

    if (data.headless && this.client.taskManager) {
      this.client.taskManager.taskSessionIds.add(data.sessionId);
    }

    const serverHistory = (data.history && data.history.length > 0) ? data.history : [];
    this.client.sessionHistories.set(data.sessionId, serverHistory);

    // Silent refresh: update stored history without touching the DOM.
    // Used by the deferred re-join after task completion.
    if (this._silentHistoryRefresh === data.sessionId) {
      this._silentHistoryRefresh = null;
      if (data.stats) this.client.updateStats(data.stats);
      return;
    }

    this.flushBackgroundBuffer(data.sessionId);
    this.client.showChatScreen();

    // Task completion: content is already live-streamed on screen — bind
    // the session tab without clearing/re-rendering the DOM.
    if (this._taskCompletionJoin === data.sessionId) {
      this._taskCompletionJoin = null;
      this.client.tabManager.openSession(data.sessionId, { skipRender: true });
    } else {
      this.client.messageRenderer.clearMessages();
      this.client.tabManager.openSession(data.sessionId);
      this.client.renderMessages();
    }

    this.client.sidebarRenderer.renderProjectList();
    this.client.modalManager.hidePlanApproval();
    if (data.stats) {
      this.client.updateStats(data.stats);
    }

    if (sessionType === 'voice') {
      this.client.enableVoiceMode();
    }
  }

  handleSessionRenamed(data) {
    const renamedSession = this.client.sessions.get(data.sessionId);
    if (renamedSession) renamedSession.name = data.name;
    if (this.client.sidebarRenderer.renamingSessionId !== data.sessionId) {
      this.client.sidebarRenderer.renderProjectList();
    }
    if (this.client.tabManager) {
      this.client.tabManager.updateTabLabel(data.sessionId, data.name || this.client.getSessionDisplayName(data.sessionId));
    }
  }

  handleSessionEnded(data) {
    this.client.state.removeSession(data.sessionId);
    this.client.tabManager.closeTab(data.sessionId);
    if (this.client.currentSessionId === data.sessionId) {
      this.client.currentSessionId = null;
      this.client.showWelcomeScreen();
    }
    this.client.sidebarRenderer.renderProjectList();
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
            this.client.messageRenderer.startAssistantMessage(block.text);
          } else if (block.type === 'tool_use') {
            if (block.name === 'Write' && block.input?.file_path && /\.claude\/plans\//.test(block.input.file_path)) {
              this.lastPlanFilePath = block.input.file_path;
            }
            if (!this.handleInteractiveTool(block.name, block.input)) {
              this.client.messageRenderer.appendToolUse(block.name, block.input);
            }
          }
        }
      }
    } else if (event.content_block) {
      if (event.content_block.type === 'text') {
        this.client.messageRenderer.updateAssistantMessage(event.content_block.text);
      } else if (event.content_block.type === 'tool_use') {
        if (this.isInteractiveTool(event.content_block.name)) {
          this.pendingInteractiveTool = { name: event.content_block.name, input: event.content_block.input || {} };
        } else {
          this._lastNonInteractiveToolName = event.content_block.name;
          this.client.messageRenderer.appendToolUse(event.content_block.name, event.content_block.input);
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
          this.client.messageRenderer.updateToolInput(event.content_block.input);
        }
      }
    } else if (event.delta) {
      if (event.delta.type === 'text_delta') {
        this.client.messageRenderer.appendToAssistantMessage(event.delta.text);
        this.client.voiceChatManager?.handleAssistantDelta(event.delta.text);
        // Accumulate for client-side TTS in text sessions (browser and native backends)
        if (this.client.ttsManager?.activeBackend?.onDevice && this.client.ttsManager?.enabled) {
          this._clientTTSAccum = (this._clientTTSAccum || '') + event.delta.text;
        }
      }
    }
  }

  handleResultEvent(event) {
    if (event.subtype === 'error') {
      this.client.messageRenderer.appendSystemMessage(`Tool error: ${event.error}`, 'error');
    } else if (event.subtype === 'tool_result') {
      this.client.messageRenderer.markToolComplete();
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
    this.client.messageRenderer.hideThinkingIndicator();
    this.client.hideStopButton();

    // Open the plan file in the editor if we tracked the path
    if (this.lastPlanFilePath) {
      this.client.wsClient.send({ type: 'read_plan_file', path: this.lastPlanFilePath });
      this.lastPlanFilePath = null;
    }

    this.client.modalManager.showPlanApproval((approved) => {
      if (approved) {
        this.client.messageRenderer.appendUserMessage('Yes, proceed with the plan.');
        this.client.wsClient.send({ type: 'user_input', text: 'Yes, proceed with the plan.', sessionId: this.client.currentSessionId });
        this.client.messageRenderer.showThinkingIndicator();
        this.client.showStopButton();
      } else {
        this.client.elements.userInput.placeholder = 'Describe what to change in the plan...';
        this.client.elements.userInput.focus();
      }
    });
  }

  handleAskUserQuestion(input) {
    this.client.messageRenderer.hideThinkingIndicator();
    this.client.hideStopButton();
    this.client.messageRenderer.finishAssistantMessage();

    const questions = input && input.questions;
    if (!questions || !Array.isArray(questions) || questions.length === 0) return;

    this.client.messageRenderer.renderQuestionBlock(questions, (responseText) => {
      this.client.messageRenderer.appendUserMessage(responseText);
      this.client.wsClient.send({ type: 'user_input', text: responseText, sessionId: this.client.currentSessionId });
      this.client.messageRenderer.showThinkingIndicator();
      this.client.showStopButton();
    });
  }

  handleSystemEvent(event) {
    if (event.subtype === 'permission_request') {
      this.client.modalManager.showPermissionPrompt(event.message || 'Permission requested');
    } else if (event.subtype === 'question') {
      this.client.modalManager.showInputPrompt(event.message || 'Assistant is asking a question');
    } else if (event.subtype === 'status') {
      if (event.message) {
        this.client.messageRenderer.updateThinkingIndicator(event.message);
      } else {
        this.client.messageRenderer.hideThinkingIndicator();
      }
    } else if (event.message) {
      this.client.messageRenderer.appendSystemMessage(event.message);
    }
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageDispatcher;
}
