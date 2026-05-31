/**
 * MessageDispatcher - handles server message routing and LLM event processing.
 * Extracted from EveWorkspaceClient to separate message dispatch from orchestration.
 */

// Protocol version this client speaks. Bumped in lockstep with relayLLM's
// docs/event-protocol.md. Every canonical llm_event payload carries a v field;
// _checkEventVersion refuses to render anything else.
const EVENT_PROTOCOL_VERSION = 2;

class MessageDispatcher {
  /**
   * @param {Container} container - DI container.
   * Each dependency injected individually — no god-object reference.
   * `app` is retained only for UI orchestration methods (showChatScreen, etc.)
   * that haven't been extracted into their own services yet.
   */
  constructor(container) {
    this.container = container;
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
    // Per-turn block tracking for the canonical event protocol (see
    // relayLLM/docs/event-protocol.md). Keyed by content-block index so we
    // know how to close each block when its content_block_stop arrives.
    this._openBlockKindByIndex = {};
    // Accumulator for input_json_delta fragments. See _handleStreamingToolInput.
    this._streamingToolInputBuffer = '';
    // LIFO stack of open Agent (sub-agent) calls. Each frame holds the
    // parent's tool_use_id, a child MessageRenderer that targets the parent
    // block's body, the timestamp the call started, a tool-call counter,
    // plus the saved parent's _openBlockKindByIndex so child stream indices
    // don't collide.
    this._sidechainStack = [];
    // On-device TTS follows a single turn across tab switches. _ttsSessionId
    // is the session whose response we're currently speaking (bound on its
    // first main-thread text, cleared when that turn completes or is stopped).
    // _clientTTSAccum holds that turn's text. Server-backend TTS is unaffected
    // (its audio frames aren't session-scoped). See _accumulateClientTTS.
    this._clientTTSAccum = '';
    this._ttsSessionId = null;

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
      tts_done:             ()  => this._handleTtsDone(),
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
      mode_changed:         (d) => this._applyPermissionMode(d.mode || 'default'),
      warning:              (d) => this.renderer.appendSystemMessage(d.message, 'warning'),
      task_started:         (d) => this.handleSchedulerTaskEvent(d),
      task_completed:       (d) => this.handleSchedulerTaskEvent(d),
      task_error:           (d) => this.handleSchedulerTaskEvent(d),
      task_status:          (d) => this.handleSchedulerTaskStatus(d),
      module_file_response: (d) => this.bus.emit(EVT.MODULE_FILE_RESPONSE, d),
      module_ai_started:    (d) => this.bus.emit(EVT.MODULE_AI_STARTED, d),
      module_ai_event:      (d) => this.bus.emit(EVT.MODULE_AI_EVENT, d),
      module_ai_completed:  (d) => this.bus.emit(EVT.MODULE_AI_COMPLETED, d),
      module_ai_failed:     (d) => this.bus.emit(EVT.MODULE_AI_FAILED, d),
      search_results:       (d) => this.bus.emit(EVT.SEARCH_RESULTS, d),
      search_error:         (d) => this.bus.emit(EVT.SEARCH_ERROR, d),
      search_ai_started:    (d) => this.bus.emit(EVT.SEARCH_AI_STARTED, d),
      search_ai_event:      (d) => this.bus.emit(EVT.SEARCH_AI_EVENT, d),
      search_ai_completed:  (d) => this.bus.emit(EVT.SEARCH_AI_COMPLETED, d),
      search_ai_failed:     (d) => this.bus.emit(EVT.SEARCH_AI_FAILED, d),
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
    // Release the TTS binding only when resetting the turn we're following, so
    // stopping one session doesn't drop another's in-flight speech.
    if (this._ttsSessionId === null || this._ttsSessionId === sessionId) {
      this._clientTTSAccum = '';
      this._ttsSessionId = null;
    }
    this._lastNonInteractiveToolName = null;
    this._openBlockKindByIndex = {};
    this._sidechainStack = [];
    this._streamingToolInputBuffer = '';
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
    if (!this._checkEventVersion(data.event)) return;
    this.handleLlmEvent(data.event);
  }

  // Returns true if the event is safe to render. Surfaces a single in-UI
  // banner on first mismatch and drops subsequent events silently — repeated
  // banners on every event would be unusable.
  _checkEventVersion(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.v === EVENT_PROTOCOL_VERSION) return true;
    // Don't spam the UI for every event; surface a single banner per session
    // and drop the rest until reconnect.
    if (!this._versionMismatchSurfaced) {
      this._versionMismatchSurfaced = true;
      const got = event.v === undefined ? '(missing)' : event.v;
      const msg = `Server is emitting protocol v${got}; this client expects v${EVENT_PROTOCOL_VERSION}. Refusing to render until versions match.`;
      console.error('[message-dispatcher] protocol version mismatch', { expected: EVENT_PROTOCOL_VERSION, got, event });
      this.renderer.appendSystemMessage(msg, 'error');
    }
    return false;
  }

  _handleProcessExited(data) {
    // Provider crashed mid-turn — drop any orphaned sidechain frames so the
    // sub-renderer's DOM references don't leak into the next turn.
    this.resetTurnState(data.sessionId);
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
    this.app.clearSessionStarting();
  }

  _handleMessageComplete(data) {
    this._untrackStreaming(data.sessionId);
    this._openBlockKindByIndex = {};
    this._streamingToolInputBuffer = '';
    // Drop any sidechain still open at message_complete (orphaned Agent call
    // without a tool_result) — would otherwise leak its frame across turns.
    this._sidechainStack = [];
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
    // Client-side TTS for text sessions (voice sessions handled by voiceChatManager).
    // Speaks the session we've been following, which may differ from the visible
    // one if the user switched tabs mid-response.
    this._flushClientTTS(data.sessionId || this.state.currentSessionId);
  }

  /**
   * Accumulate on-device TTS text for the turn we're following. Binds to the
   * first session to stream main-thread text while TTS is enabled and ignores
   * other concurrent sessions, so switching tabs mid-response doesn't drop the
   * speech (the bound session keeps accumulating in the background path) and
   * multiple streaming tabs don't talk over each other. No-op for the server
   * backend, which streams audio frames independently of the active session.
   */
  _accumulateClientTTS(sessionId, text) {
    if (!text) return;
    if (!this.tts?.activeBackend?.onDevice || !this.tts?.enabled) return;
    // Only accumulate if we have a valid sessionId or we're already bound
    if (!sessionId && !this._ttsSessionId) return;
    // Bind to the first sessionId we see; if already bound, require matching sessionId
    if (this._ttsSessionId === null && sessionId) {
      this._ttsSessionId = sessionId;
    } else if (sessionId && sessionId !== this._ttsSessionId) {
      return;
    }
    // Accumulate if bound (either just-bound or previously-bound)
    if (this._ttsSessionId !== null) {
      this._clientTTSAccum += text;
    }
  }

  /**
   * Speak the accumulated on-device TTS for a completed turn and release the
   * binding. Fires regardless of which tab is visible, so a response that
   * finishes after the user switches away is still spoken. Ignores completions
   * for sessions we aren't following.
   */
  _flushClientTTS(sessionId) {
    if (this._ttsSessionId !== null && sessionId !== this._ttsSessionId) return;
    if (this._clientTTSAccum && this.tts?.enabled && !this.voice?.isVoiceSession) {
      this.tts.speakText(this._clientTTSAccum);
    }
    this._clientTTSAccum = '';
    this._ttsSessionId = null;
  }

  _handleTtsAudio(data) {
    this.tts?.enqueueServerAudio(data.data);
  }

  _handleTtsDone() {
    this.tts?.markTTSDone();
  }

  _handleTtsError(data) {
    this.log.warn('TTS error:', data.message);
    this._notifyVoiceError(`Speech failed: ${data.message}`);
    if (!this.voice?.isVoiceSession) {
      this.renderer.appendSystemMessage(`TTS error: ${data.message}`, 'error');
    }
    this.bus.emit(EVT.TTS_PLAYBACK_ENDED);
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

    const view = data.view;
    // Snapshot the previous run ref before state mutates — needed for the
    // "close old, open new" handoff on user-triggered runs.
    const oldRef = task.view?.runId || null;

    let lastStatus = null;
    if (data.type === 'task_started') lastStatus = 'running';
    else if (data.type === 'task_completed') lastStatus = data.status || 'success';
    else if (data.type === 'task_error') lastStatus = data.status || 'error';
    this.state.applyTaskViewUpdate(data.taskId, view, lastStatus ? { lastStatus } : {});

    if (data.type === 'task_started') this.bus.emit(EVT.TASK_STARTED, data);
    else if (data.type === 'task_completed') this.bus.emit(EVT.TASK_COMPLETED, data);
    else if (data.type === 'task_error') this.bus.emit(EVT.TASK_ERROR, data);

    // User clicked Run → auto-open the new run, replacing any previous one.
    if (data.type === 'task_started' && this.taskManager?.userTriggeredRuns.has(data.taskId) && view?.runId) {
      if (oldRef && oldRef !== view.runId) {
        if (view.kind === 'readonly') {
          this.terminal?.closeTerminal(oldRef);
        } else {
          this.tabManager.closeTab(oldRef);
          this.state.removeSession(oldRef);
        }
      }
      if (view.kind === 'readonly') {
        // Pre-register so a subsequent click-to-view hits WS attach rather
        // than disk replay before terminal_list catches up.
        const project = this.state.getProject(task.projectId);
        this.terminal?.registerKnownTerminal({
          id: view.runId,
          templateId: task.templateId,
          name: task.name,
          directory: task.directory || project?.path || '',
          state: 'running',
        });
      }
      this.container?.get('taskViewer')?.openLiveRun(task, view);
    }

    if (data.type === 'task_completed' || data.type === 'task_error') {
      this.taskManager?.userTriggeredRuns.delete(data.taskId);
      this.taskManager?.loadTasks(data.projectId);
    }
  }

  handleSchedulerTaskStatus(data) {
    if (!Array.isArray(data.running)) return;
    for (const item of data.running) {
      this.state.applyTaskViewUpdate(item.taskId, item.view, { lastStatus: 'running' });
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

      // Re-fold canonical events into {role, content:[blocks]} so renderHistory
      // can replay them when the user switches to this tab.
      if (event.type === 'assistant') {
        if (event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              buf.contentBlocks.push({ type: 'text', text: block.text });
              if (!this._inBackgroundSidechain(buf)) this._accumulateClientTTS(sid, block.text);
            } else if (block.type === 'tool_use') {
              buf.contentBlocks.push({ type: 'tool_use', name: block.name, input: block.input });
              this._trackBackgroundSidechain(buf, block);
            }
          }
        } else if (event.content_block_stop) {
          // Tool_use stop carries the resolved final input; update the last tool block.
          if (event.content_block?.type === 'tool_use') {
            for (let i = buf.contentBlocks.length - 1; i >= 0; i--) {
              if (buf.contentBlocks[i].type === 'tool_use') {
                buf.contentBlocks[i].input = event.content_block.input;
                break;
              }
            }
          }
        } else if (event.delta?.type === 'text_delta') {
          this._appendBufText(buf, event.delta.text);
          if (!this._inBackgroundSidechain(buf)) this._accumulateClientTTS(sid, event.delta.text);
        } else if (event.delta?.type === 'thinking_delta') {
          this._appendBufText(buf, event.delta.thinking || '');
        } else if (event.delta?.type === 'input_json_delta') {
          // Skip — partial JSON for tool args; the tool_use block already
          // exists and the final input arrives via content_block_stop.
        } else if (event.content_block?.type === 'text') {
          // Bare start; content arrives via text_delta.
        } else if (event.content_block?.type === 'thinking') {
          this._appendBufText(buf, '<think>\n');
          buf._thinkingOpen = true;
        } else if (event.content_block?.type === 'tool_use') {
          // If a thinking block was open, close it first.
          if (buf._thinkingOpen) {
            this._appendBufText(buf, '\n</think>\n\n');
            buf._thinkingOpen = false;
          }
          const toolBlock = { type: 'tool_use', id: event.content_block.id, name: event.content_block.name, input: event.content_block.input || {} };
          buf.contentBlocks.push(toolBlock);
          this._trackBackgroundSidechain(buf, toolBlock);
        }
      } else if (event.type === 'result' && event.subtype === 'tool_result') {
        const id = event.tool_use_id;
        if (!id) return;
        buf._ttsSidechainIds?.delete(id);
        for (let i = buf.contentBlocks.length - 1; i >= 0; i--) {
          if (buf.contentBlocks[i].type === 'tool_use' && buf.contentBlocks[i].id === id) {
            buf.contentBlocks[i].completed = true;
            break;
          }
        }
      }
      return;
    }

    if (data.type === 'message_complete') {
      this.streamingSessions.delete(sid);
      // Speak the response if this is the turn on-device TTS is following
      // (user switched away from this tab while it was streaming).
      this._flushClientTTS(sid);
      // Flush accumulated content blocks as a completed assistant message
      const buf = this.backgroundBuffers.get(sid);
      if (buf) {
        // Close any unclosed thinking wrapper before flushing.
        if (buf._thinkingOpen) {
          this._appendBufText(buf, '\n</think>\n\n');
          buf._thinkingOpen = false;
        }
        if (buf.contentBlocks.length > 0) {
          let history = this.state.sessionHistories.get(sid);
          if (!history) {
            history = [];
            this.state.sessionHistories.set(sid, history);
          }
          history.push({ role: 'assistant', content: buf.contentBlocks });
          buf.contentBlocks = [];
        }
      }
      return;
    }

    if (data.type === 'error' || data.type === 'process_exited') {
      this.streamingSessions.delete(sid);
      return;
    }

    // Other background events (stderr, etc.) -- ignore silently
  }

  /** Open a sub-agent scope on a background buffer if the tool_use is an
   *  Agent/Task dispatch, so its streamed text is kept out of TTS (mirrors the
   *  foreground _sidechainStack guard). Closed in the tool_result branch. */
  _trackBackgroundSidechain(buf, block) {
    if (!this._isSubagentDispatch(block)) return;
    (buf._ttsSidechainIds ||= new Set()).add(block.id);
  }

  /** True while a background buffer is inside an open sub-agent scope. */
  _inBackgroundSidechain(buf) {
    return buf._ttsSidechainIds?.size > 0;
  }

  /** Append text to the last text block in a background buffer, or open a
   *  new text block if the most recent block is something else. */
  _appendBufText(buf, text) {
    if (!text) return;
    const last = buf.contentBlocks[buf.contentBlocks.length - 1];
    if (last && last.type === 'text') {
      last.text += text;
    } else {
      buf.contentBlocks.push({ type: 'text', text });
    }
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
    if (buf._thinkingOpen) {
      this._appendBufText(buf, '\n</think>\n\n');
      buf._thinkingOpen = false;
    }
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
    this.app.clearSessionStarting();
    this.sidebar.renderProjectList();
    this.modalManager.hideSessionModal();
    this.modalManager.hidePlanApproval();

    if (data.sessionType === 'voice') {
      this.app.enableVoiceMode(data.voice);
    }
  }

  handleSessionJoined(data) {
    // Server announces its protocol version in protocolVersion. If we
    // disagree on majors, refuse to render — the per-event v gate would
    // catch it on first llm_event, but surfacing on join is better UX.
    const serverMajor = parseInt(data.protocolVersion, 10);
    if (Number.isFinite(serverMajor) && serverMajor !== EVENT_PROTOCOL_VERSION) {
      this._versionMismatchSurfaced = true;
      const msg = `Server is on protocol v${data.protocolVersion}; this client expects v${EVENT_PROTOCOL_VERSION}. Refusing to render until versions match.`;
      console.error('[message-dispatcher] protocol version mismatch on session_joined', { expected: EVENT_PROTOCOL_VERSION, got: data.protocolVersion });
      this.renderer.appendSystemMessage(msg, 'error');
    }
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
      this.state.taskRunIds.add(data.sessionId);
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
    // Drop any "Allow All" bypass for this session so a future session
    // re-created under the same browser tab doesn't inherit it.
    this.modalManager?.clearSessionBypass?.(data.sessionId);
    this.sidebar.renderProjectList();
  }

  // --- LLM event handling ---

  handleLlmEvent(event) {
    switch (event.type) {
      case 'user':
        // Plain user echoes are already rendered client-side on submit, but
        // Claude CLI also emits user-typed events whose message.content is an
        // array of tool_result blocks. Render those into the matching tool
        // block so the user sees what each tool returned.
        this._handleUserToolResults(event);
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
      case 'permission-mode':
        this._handlePermissionModeEvent(event);
        break;
      case 'ai-title':
      case 'custom-title':
        this._handleTitleEvent(event);
        break;
    }
  }

  /**
   * Apply a session title from Claude. ai-title comes from the model's
   * automatic summarization; custom-title is user-set (e.g. via /rename).
   * Custom titles win over AI titles when both arrive — Eve's existing
   * session.name field stores whichever was applied last.
   */
  _handleTitleEvent(event) {
    const sid = event.sessionId || this.state.currentSessionId;
    if (!sid) return;
    const title = event.customTitle || event.aiTitle;
    if (!title) return;
    const session = this.state.sessions.get(sid);
    if (!session) return;
    // Don't override an existing custom title with an AI-generated one.
    if (event.type === 'ai-title' && session.titleSource === 'custom') return;
    const nextSource = (event.type === 'custom-title') ? 'custom' : 'ai';
    if (session.name === title && session.titleSource === nextSource) return;
    session.name = title;
    session.titleSource = nextSource;
    this.tabManager?.updateTabLabel(sid, title);
    this.sidebar?.renderProjectList();
  }

  /**
   * Render tool_result blocks carried inside a Claude user-message event.
   * Claude CLI emits these as {type:"user", message:{content:[
   *   {type:"tool_result", tool_use_id, content: string | [{type:"text"|"image", ...}]}
   * ]}}. Each result is paired back to its tool_use block by id.
   */
  _handleUserToolResults(event) {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      // Sub-agent dispatches close via a tool_result on the parent's Agent
      // tool_use_id. Intercept those: finalize the agent block instead of
      // rendering the result inline (the agent block IS the visualization).
      if (this._maybeCloseSidechain(block.tool_use_id, block.content)) continue;

      const renderer = this._activeRenderer();
      renderer.appendToolResult(block.content, block.tool_use_id);
      if (block.tool_use_id) {
        renderer.markToolCompleteById(block.tool_use_id);
      } else {
        renderer.markToolComplete();
      }
    }
  }

  _handlePermissionModeEvent(event) {
    this._applyPermissionMode(event.permissionMode || 'default');
  }

  _applyPermissionMode(mode) {
    this.renderer.setPermissionModeBanner(mode);
    const btn = document.getElementById('planModeBtn');
    if (btn) btn.classList.toggle('active', mode === 'plan');
  }

  handleAssistantEvent(event) {
    // The order of these checks matters: a content_block_stop event for a
    // tool_use carries BOTH content_block_stop:true AND a content_block
    // (echoing the resolved final input). Check stop before content_block to
    // avoid double-rendering the tool block. See docs/event-protocol.md.
    if (event.message) {
      this._handleAssistantMessageStart(event.message);
    } else if (event.content_block_stop) {
      this._handleContentBlockStop(event);
    } else if (event.content_block) {
      this._handleContentBlockStart(event);
    } else if (event.delta) {
      this._handleContentBlockDelta(event);
    }
  }

  /**
   * Returns the renderer that should receive streaming content right now.
   * If a sub-agent (Agent/Task) call is in progress, routes to the nested
   * sub-renderer at the top of the sidechain stack so its events render
   * inside the parent Agent block. Otherwise returns the main renderer.
   */
  _activeRenderer() {
    return this._sidechainStack.length > 0
      ? this._sidechainStack[this._sidechainStack.length - 1].renderer
      : this.renderer;
  }

  /**
   * Push a new sidechain frame when the parent calls Agent/Task. Saves the
   * parent's per-turn block-tracking state so the sub-agent's stream indices
   * don't collide. The sub-renderer targets the parent Agent block's body.
   */
  _pushSidechain(toolUseId, persona, description) {
    const { bodyEl } = this.renderer.appendAgentBlock(toolUseId, persona, description);
    const subRenderer = new MessageRenderer(this.container, { targetEl: bodyEl });
    this._sidechainStack.push({
      toolUseId,
      renderer: subRenderer,
      persona,
      startedAt: Date.now(),
      toolCount: 0,
      savedBlockKindByIndex: this._openBlockKindByIndex,
    });
    this._openBlockKindByIndex = {};
  }

  /**
   * Pop the top sidechain frame matching toolUseId. Restores the parent's
   * saved per-turn state. Returns the popped frame so callers can compute
   * duration / tool count for finalize.
   */
  _popSidechain(toolUseId) {
    const idx = this._sidechainStack.findIndex(f => f.toolUseId === toolUseId);
    if (idx < 0) return null;
    const frame = this._sidechainStack[idx];
    // Defensive: pop everything above the matched frame too. Anthropic
    // doesn't interleave parallel sub-agents in practice, but if anything
    // above this frame was orphaned we drop it cleanly.
    this._sidechainStack.splice(idx);
    // If this was the bottom frame, restore parent state. Otherwise leave
    // current state alone (we're still inside an outer sidechain).
    if (this._sidechainStack.length === 0) {
      this._openBlockKindByIndex = frame.savedBlockKindByIndex || {};
    }
    return frame;
  }

  /**
   * If the given tool_use_id closes an open sidechain, finalize the matching
   * Agent block (auto-collapse with summary) and return true. The caller
   * should NOT render this tool_result via the normal path because the agent
   * block IS the visualization.
   */
  _maybeCloseSidechain(toolUseId, content) {
    if (!toolUseId) return false;
    const idx = this._sidechainStack.findIndex(f => f.toolUseId === toolUseId);
    if (idx < 0) return false;
    const frame = this._sidechainStack[idx];
    const durationMs = Date.now() - frame.startedAt;
    this._popSidechain(toolUseId);
    this.renderer.finalizeAgentBlock(toolUseId, content, durationMs, frame.toolCount);
    return true;
  }

  _handleAssistantMessageStart(message) {
    // Canonical message_start has empty content. Claude CLI may send a full
    // pre-built content array (rare). Render any text/tool blocks present.
    if (!message.content) return;
    const renderer = this._activeRenderer();
    for (const block of message.content) {
      if (block.type === 'text') {
        renderer.startAssistantMessage(block.text);
      } else if (block.type === 'redacted_thinking') {
        renderer.appendToAssistantMessage(REDACTED_THINKING_PLACEHOLDER);
      } else if (block.type === 'tool_use') {
        if (block.name === 'Write' && block.input?.file_path && /\.claude\/plans\//.test(block.input.file_path)) {
          this.lastPlanFilePath = block.input.file_path;
        }
        if (this._tryStartSidechain(block)) continue;
        if (!this.handleInteractiveTool(block.name, block.input)) {
          renderer.appendToolUse(block.name, block.input, block.id);
        }
      }
    }
  }

  /**
   * If this tool_use is a Claude Agent/Task sub-agent dispatch, push a new
   * sidechain frame and return true. Subsequent stream events route through
   * the new sub-renderer until the matching tool_result closes the frame.
   *
   * Heuristic: a tool named "Agent" or "Task" with subagent_type in its input
   * is a sub-agent dispatch. Tools with the same name but no subagent_type
   * fall through to normal tool rendering (defensive — chat-base providers
   * don't have sub-agents).
   */
  _tryStartSidechain(block) {
    if (!this._isSubagentDispatch(block)) return false;
    const description = block.input?.description || '';
    this._pushSidechain(block.id, block.input.subagent_type, description);
    return true;
  }

  /** True if a tool_use block is an Agent/Task sub-agent dispatch (see
   *  _tryStartSidechain). Pure — used by both the foreground renderer and the
   *  background buffer to keep sub-agent text out of TTS. */
  _isSubagentDispatch(block) {
    if (!block || !block.id) return false;
    if (block.name !== 'Agent' && block.name !== 'Task') return false;
    return !!block.input?.subagent_type;
  }

  _handleContentBlockStart(event) {
    const cb = event.content_block;
    const idx = event.index;
    if (!cb) return;

    // Track the block kind so the corresponding stop knows what to close.
    if (typeof idx === 'number') {
      this._openBlockKindByIndex[idx] = cb.type;
    }

    const renderer = this._activeRenderer();

    if (cb.type === 'text') {
      // Bare start; content arrives via text_delta. The renderer opens the
      // block implicitly on the first delta.
    } else if (cb.type === 'thinking') {
      // Reuse the existing <think>...</think> renderer by wrapping the block
      // in tags. The renderer parses these into foldable thinking sections.
      renderer.appendToAssistantMessage('<think>\n');
    } else if (cb.type === 'redacted_thinking') {
      // Atomic block — no thinking_delta events follow, so emit the full
      // <think>...</think> wrapper here. _handleContentBlockStop is a no-op
      // for kind='redacted_thinking' (only 'thinking' triggers a close).
      renderer.appendToAssistantMessage(REDACTED_THINKING_PLACEHOLDER);
    } else if (cb.type === 'tool_use') {
      this._streamingToolInputBuffer = '';
      if (cb.name === 'Write' && cb.input?.file_path && /\.claude\/plans\//.test(cb.input.file_path)) {
        this.lastPlanFilePath = cb.input.file_path;
      }
      // Claude Agent/Task with subagent_type spawns a sub-agent. Push a
      // sidechain frame so subsequent stream events render nested.
      if (this._tryStartSidechain(cb)) return;
      if (this.isInteractiveTool(cb.name)) {
        this.pendingInteractiveTool = { name: cb.name, input: cb.input || {} };
      } else {
        this._lastNonInteractiveToolName = cb.name;
        renderer.appendToolUse(cb.name, cb.input || {}, cb.id);
        // Bump the active sidechain's tool counter for the finalize summary.
        const top = this._sidechainStack[this._sidechainStack.length - 1];
        if (top) top.toolCount++;
      }
    }
  }

  _handleContentBlockDelta(event) {
    const d = event.delta;
    if (!d) return;
    const renderer = this._activeRenderer();
    if (d.type === 'text_delta') {
      renderer.appendToAssistantMessage(d.text);
      // Voice + TTS only follow the main thread, never sub-agent deltas.
      if (this._sidechainStack.length === 0) {
        this.voice?.handleAssistantDelta(d.text);
        this._accumulateClientTTS(this.state.currentSessionId, d.text);
      }
    } else if (d.type === 'thinking_delta') {
      // Append to the assistant message inside the open <think> wrapper.
      renderer.appendToAssistantMessage(d.thinking || '');
    } else if (d.type === 'input_json_delta') {
      // Forward partial JSON so interactive tools (ExitPlanMode /
      // AskUserQuestion) and the renderer's streaming tool-input summary
      // pick up the args. The fully-resolved input arrives via
      // content_block_stop; we don't need to accumulate here.
      this._handleStreamingToolInput(d.partial_json || '');
    }
  }

  _handleContentBlockStop(event) {
    const idx = event.index;
    const kind = (typeof idx === 'number') ? this._openBlockKindByIndex[idx] : undefined;
    const renderer = this._activeRenderer();

    if (kind === 'thinking') {
      // Close out the <think> wrapper for the renderer's tag parser.
      renderer.appendToAssistantMessage('\n</think>\n\n');
    } else if (kind === 'tool_use' || (event.content_block && event.content_block.type === 'tool_use')) {
      // The stop event echoes the resolved final input. Update the rendered
      // tool block so users see the complete arguments even if they missed
      // streaming deltas. Tool completion (spinner removal) happens on the
      // matching tool_result event.
      const finalInput = event.content_block?.input;
      if (finalInput !== undefined && finalInput !== null) {
        renderer.updateToolInput(finalInput);
      }
      this._streamingToolInputBuffer = '';
    }
    if (typeof idx === 'number') delete this._openBlockKindByIndex[idx];
  }

  /**
   * Handle one fragment of streaming tool input from an input_json_delta
   * event. Strings are accumulated and parsed incrementally; we only forward
   * a parsed object to the renderer once the buffer is valid JSON. Otherwise
   * upstreams that emit word-sized deltas (pi.dev streaming from Anthropic)
   * cause the displayed tool-input summary to flash through every fragment
   * instead of settling on a clean summary.
   */
  _handleStreamingToolInput(input) {
    let parsed = null;
    if (typeof input === 'string') {
      this._streamingToolInputBuffer += input;
      // Tool inputs are always objects, so JSON.parse can only succeed once
      // a closing brace lands. Skipping the parse on every other fragment
      // keeps a multi-hundred-delta Edit/Write call off the UI thread.
      if (this._streamingToolInputBuffer.endsWith('}')) {
        try {
          parsed = JSON.parse(this._streamingToolInputBuffer);
        } catch {
          // Outer object not yet closed — that '}' was nested. Keep going.
        }
      }
    } else if (input && typeof input === 'object') {
      parsed = input;
    }

    if (this.pendingInteractiveTool) {
      // Interactive tools fire at message_complete from accumulated _rawInput;
      // mirror the raw string so that path still works.
      if (typeof input === 'string') {
        this.pendingInteractiveTool._rawInput =
          (this.pendingInteractiveTool._rawInput || '') + input;
      }
      if (parsed && typeof parsed === 'object') {
        Object.assign(this.pendingInteractiveTool.input, parsed);
      }
      return;
    }
    if (!parsed) return;
    if (this._lastNonInteractiveToolName === 'Write') {
      const filePath = parsed?.file_path;
      if (filePath && /\.claude\/plans\//.test(filePath)) {
        this.lastPlanFilePath = filePath;
      }
    }
    this._activeRenderer().updateToolInput(parsed);
  }

  handleResultEvent(event) {
    if (event.subtype === 'error') {
      // Tool errors are session-level — always surface on the main thread.
      this.renderer.appendSystemMessage(`Tool error: ${event.error}`, 'error');
    } else if (event.subtype === 'tool_progress') {
      this._activeRenderer().updateToolProgress(event.tool_name, event.message);
    } else if (event.subtype === 'tool_result') {
      if (this._maybeCloseSidechain(event.tool_use_id, event.content)) return;
      const renderer = this._activeRenderer();
      if (event.content) renderer.appendToolResult(event.content, event.tool_use_id);
      if (event.tool_use_id) {
        renderer.markToolCompleteById(event.tool_use_id);
      }
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
        // Switch the session out of plan mode so Claude can actually run
        // edit tools. The mode_changed event will update the banner.
        this.ws.send({ type: 'set_permission_mode', sessionId: this.state.currentSessionId, mode: 'default' });
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
    } else if (event.subtype === 'init') {
      // Canonical turn-init context (model, tools, mcp servers, cwd). The UI
      // already shows model/cwd from session metadata, so this is informational
      // for now — capture it on the session for future use.
      const session = this.state.sessions.get(this.state.currentSessionId);
      if (session) {
        session.lastTurnContext = {
          model: event.model,
          cwd: event.cwd,
          tools: event.tools,
          mcpServers: event.mcp_servers,
        };
      }
    } else if (event.subtype === 'api_error') {
      this._renderApiError(event);
    } else if (event.subtype === 'bridge_status') {
      this._renderBridgeStatus(event);
    } else if (event.subtype === 'stop_hook_summary') {
      this._renderStopHookSummary(event);
    } else if (event.message) {
      this.renderer.appendSystemMessage(event.message);
    }
  }

  /**
   * Render an api_error system event. Claude Code retries automatically up to
   * maxRetries; we surface the error with retry context so users see what's
   * happening instead of just a stalled spinner.
   */
  _renderApiError(event) {
    const code = event.cause?.code || event.error?.cause?.code || event.error?.type;
    const path = event.cause?.path || event.error?.cause?.path;
    const reason = code ? code : 'API error';
    const where = path ? ` (${path})` : '';
    const attempt = (event.retryAttempt && event.maxRetries)
      ? ` — retry ${event.retryAttempt}/${event.maxRetries}`
      : '';
    const isFinal = event.retryAttempt && event.maxRetries && event.retryAttempt >= event.maxRetries;
    const severity = isFinal ? 'error' : 'warning';
    this.renderer.appendSystemMessage(`API error: ${reason}${where}${attempt}`, severity);
  }

  /**
   * Render the Claude.ai remote-control bridge status. The event carries a
   * URL the user can open to control this session from the web app.
   */
  _renderBridgeStatus(event) {
    const text = event.content || 'Remote control active';
    this.renderer.appendSystemMessage(text);
  }

  /**
   * If the user's Stop hooks errored, surface the failures so they don't
   * silently break workflows. Successful (or no-op) hook summaries are not
   * rendered — they're noisy and not actionable.
   */
  _renderStopHookSummary(event) {
    const errors = Array.isArray(event.hookErrors) ? event.hookErrors : [];
    if (errors.length === 0) return;
    const detail = errors.map(e => (typeof e === 'string' ? e : (e?.message || JSON.stringify(e)))).join('; ');
    this.renderer.appendSystemMessage(`Stop hook error: ${detail}`, 'warning');
  }
}

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageDispatcher;
}
