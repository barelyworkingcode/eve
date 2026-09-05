// Bumped in lockstep with relayLLM's event protocol; must match the server's v.
const EVENT_PROTOCOL_VERSION = 2;

// A resubscribe join_session (see markResubscribeJoin) normally gets answered
// within one round trip. Treating a wildly late reply as a resubscribe would
// risk swallowing a later, genuine user-initiated join of the same session.
const RESUBSCRIBE_JOIN_TTL_MS = 15000;

class MessageDispatcher {
  constructor(container) {
    this.container = container;
    this.log = container.get('logger').child('Dispatch');
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
    this.permissions = container.get('permissions');
    this.state = container.get('state');
    this.ws = container.get('ws');
    this.bus = container.get('bus');
    this.app = container.get('app');

    this.pendingInteractiveTool = null;
    this.lastPlanFilePath = null;
    this._lastNonInteractiveToolName = null;
    this.backgroundBuffers = new Map();
    this.streamingSessions = new Set();
    this._lastTurnMetrics = null;
    this._localSubmitSession = null;
    this._openBlockKindByIndex = {};
    this._streamingToolInputBuffer = '';
    this._sidechainStack = [];
    this._clientTTSAccum = '';
    this._ttsSessionId = null;
    // sessionId -> markedAt (ms). Populated by app.js#resubscribeAfterReconnect()
    // right before each join_session it sends after an upstream relay
    // reconnect, so handleSessionJoined can tell that reply apart from a
    // genuine, user-facing join and avoid stealing the active tab.
    this._resubscribeJoins = new Map();

    this._sessionScopedTypes = new Set([
      'llm_event', 'message_complete', 'stats_update', 'raw_output',
      'stderr', 'process_exited', 'error', 'system_message', 'clear_messages',
      'user_message',
    ]);

    this._handlers = {
      session_created:      (d) => this.handleSessionCreated(d),
      session_joined:       (d) => this.handleSessionJoined(d),
      session_renamed:      (d) => this.handleSessionRenamed(d),
      session_folder_changed: (d) => this.handleSessionFolderChanged(d),
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
      dir_changed:          (d) => { if (this.bus) this.bus.emit(EVT.DIR_CHANGED, d); },
      terminal_created:     (d) => this.terminal.onTerminalCreated(d.terminalId, d.templateId, d.name, d.directory),
      terminal_joined:      (d) => this.terminal.onTerminalJoined(d),
      terminal_output:      (d) => this.terminal.onTerminalOutput(d.terminalId, d.data),
      terminal_exit:        (d) => this.terminal.onTerminalExit(d.terminalId, d.exitCode),
      terminal_closed:      (d) => this.terminal.onTerminalExit(d.terminalId, 0),
      terminal_list:        (d) => this.terminal.onTerminalList(d.terminals),
      terminal_templates:   (d) => this._handleTerminalTemplates(d),
      permission_request:   (d) => this.modalManager.showPermissionModal(d),
      mode_changed:         (d) => this._applyPermissionMode(d.mode || 'default'),
      relay_status:         (d) => this._handleRelayStatus(d),
      warning:              (d) => this.renderer.appendSystemMessage(d.message, 'warning'),
      ui_command:           (d) => this._handleUiCommand(d),
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
    if (data.sessionId && data.sessionId !== this.state.currentSessionId && this._sessionScopedTypes.has(data.type)) {
      this._handleBackgroundEvent(data);
      return;
    }

    const handler = this._handlers[data.type];
    if (handler) handler(data);
  }

  // actor/projectId are stamped server-side by eve-control MCP and trusted here.
  _handleUiCommand(data) {
    const cmd = data && data.command;
    if (!cmd || !cmd.action) return;
    const tm = this.tabManager;
    if (!tm) return;
    const identity = { actor: data.actor, projectId: data.projectId };
    switch (cmd.action) {
      case 'open_tab':
        if (cmd.tab_kind === 'image') {
          tm.openImageTab(cmd.tab_ref, cmd.image_url, cmd.title, { actor: identity.actor, projectId: identity.projectId });
        }
        break;
      case 'refresh_tab':
        tm.refreshImageTab(cmd.tab_ref, identity, cmd.image_url);
        break;
      case 'close_tab':
        tm.closeImageTab(cmd.tab_ref, identity);
        break;
      default:
        break;
    }
  }

  // The upstream relayLLM leg self-heals (relay-client.js); recovery gets a
  // fresh connection with empty join_session/terminal_reconnect state even
  // though the browser socket never dropped, so open panes need re-joining
  // exactly like a browser reconnect does.
  _handleRelayStatus(data) {
    if (data.connected) {
      this.bus.emit(EVT.TOAST_DISMISS, { id: 'relay-status' });
      this.bus.emit(EVT.TOAST_SHOW, {
        id: 'relay-status-restored',
        message: 'Reconnected to relay.',
        type: 'info',
        duration: 3000,
      });
      this.app.resubscribeAfterReconnect({ silent: true });
    } else {
      this.bus.emit(EVT.TOAST_SHOW, {
        id: 'relay-status',
        message: 'Lost connection to relay — chat and terminals are paused. Reconnecting…',
        type: 'warning',
        persistent: true,
      });
    }
  }

  _trackStreaming(sessionId) {
    if (sessionId) this.streamingSessions.add(sessionId);
  }

  _untrackStreaming(sessionId) {
    if (sessionId) this.streamingSessions.delete(sessionId);
  }

  resetTurnState(sessionId) {
    this._untrackStreaming(sessionId);
    this.pendingInteractiveTool = null;
    this._lastTurnMetrics = null;
    // Only release the TTS binding for the session being reset, so resetting
    // one session's turn doesn't drop another session's in-flight speech.
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

  markLocalSubmit(sessionId) {
    this._localSubmitSession = sessionId;
  }

  _handleUserMessage(data) {
    // The message was already rendered optimistically on local submit.
    if (this._localSubmitSession === data.sessionId) {
      this._localSubmitSession = null;
      return;
    }
    this.renderer.appendUserMessage(data.text);
    this.renderer.showThinkingIndicator();
    this.app.showStopButton();
  }

  _handleLlmEventMessage(data) {
    this._trackStreaming(data.sessionId);
    if (!this._checkEventVersion(data.event)) return;
    this.handleLlmEvent(data.event);
  }

  _checkEventVersion(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.v === EVENT_PROTOCOL_VERSION) return true;
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
    // Drop orphaned sidechain frames so their sub-renderer DOM references
    // don't leak into the next turn.
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
    // An Agent call with no matching tool_result would otherwise leak its
    // frame into the next turn.
    this._sidechainStack = [];
    if (this.pendingInteractiveTool) {
      const tool = this.pendingInteractiveTool;
      this.pendingInteractiveTool = null;
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
    this._flushClientTTS(data.sessionId || this.state.currentSessionId);
  }

  // Binds to the first session seen while TTS is enabled and ignores other
  // concurrent sessions, so multiple streaming tabs don't talk over each
  // other. No-op for the server TTS backend, which streams audio frames
  // independently of the active session.
  _accumulateClientTTS(sessionId, text) {
    if (!text) return;
    if (!this.tts?.activeBackend?.onDevice || !this.tts?.enabled) return;
    if (!sessionId && !this._ttsSessionId) return;
    if (this._ttsSessionId === null && sessionId) {
      this._ttsSessionId = sessionId;
    } else if (sessionId && sessionId !== this._ttsSessionId) {
      return;
    }
    if (this._ttsSessionId !== null) {
      this._clientTTSAccum += text;
    }
  }

  _flushClientTTS(sessionId) {
    if (this._ttsSessionId !== null && sessionId !== this._ttsSessionId) return;
    if (this._clientTTSAccum && this.tts?.enabled && !this.voice?.isVoiceSession) {
      this.tts.speakText(this._clientTTSAccum);
    }
    this._clientTTSAccum = '';
    this._ttsSessionId = null;
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
      const projectId = this.terminal._pendingPickerProjectId || '';
      delete this.terminal._pendingPickerDirectory;
      delete this.terminal._pendingPickerProjectId;
      this.terminal._showPickerUI(dir, projectId);
    }
    if (this.bus) this.bus.emit(EVT.TERMINAL_TEMPLATES, data);
  }

  handleSchedulerTaskEvent(data) {
    const task = this.state.getTask(data.taskId);
    if (!task) return;

    const view = data.view;
    // Must snapshot before state.applyTaskViewUpdate mutates task.view below.
    const oldRef = task.view?.runId || null;

    let lastStatus = null;
    if (data.type === 'task_started') lastStatus = 'running';
    else if (data.type === 'task_completed') lastStatus = data.status || 'success';
    else if (data.type === 'task_error') lastStatus = data.status || 'error';
    this.state.applyTaskViewUpdate(data.taskId, view, lastStatus ? { lastStatus } : {});

    if (data.type === 'task_started') this.bus.emit(EVT.TASK_STARTED, data);
    else if (data.type === 'task_completed') this.bus.emit(EVT.TASK_COMPLETED, data);
    else if (data.type === 'task_error') this.bus.emit(EVT.TASK_ERROR, data);

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

  _handleBackgroundEvent(data) {
    const sid = data.sessionId;

    if (data.type === 'stats_update') {
      const session = this.state.sessions.get(sid);
      if (session && data.stats) {
        session.costUsd = data.stats.costUsd || 0;
      }
      return;
    }

    if (data.type === 'user_message') {
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
          // Final input arrives via content_block_stop; nothing to do here.
        } else if (event.content_block?.type === 'text') {
        } else if (event.content_block?.type === 'thinking') {
          this._appendBufText(buf, '<think>\n');
          buf._thinkingOpen = true;
        } else if (event.content_block?.type === 'tool_use') {
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
      this._flushClientTTS(sid);
      const buf = this.backgroundBuffers.get(sid);
      if (buf) {
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
  }

  // Mirrors the foreground _sidechainStack guard, for background tabs.
  _trackBackgroundSidechain(buf, block) {
    if (!this._isSubagentDispatch(block)) return;
    (buf._ttsSidechainIds ||= new Set()).add(block.id);
  }

  _inBackgroundSidechain(buf) {
    return buf._ttsSidechainIds?.size > 0;
  }

  _appendBufText(buf, text) {
    if (!text) return;
    const last = buf.contentBlocks[buf.contentBlocks.length - 1];
    if (last && last.type === 'text') {
      last.text += text;
    } else {
      buf.contentBlocks.push({ type: 'text', text });
    }
  }

  flushBackgroundBuffer(sessionId) {
    const buf = this.backgroundBuffers.get(sessionId);
    if (!buf) return;

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

  // Marked by app.js#resubscribeAfterReconnect() right before it sends each
  // join_session so the reply below can be told apart from a genuine,
  // user-facing join.
  markResubscribeJoin(sessionId) {
    this._resubscribeJoins.set(sessionId, Date.now());
  }

  // A genuine, user-initiated join (sidebar click, task viewer) always
  // supersedes an outstanding resubscribe expectation for the same session —
  // its reply must switch/repaint the tab like any other explicit join, even
  // if it happens to land while a resubscribe for the same id is in flight.
  clearResubscribeJoin(sessionId) {
    this._resubscribeJoins.delete(sessionId);
  }

  _consumeResubscribeJoin(sessionId) {
    const markedAt = this._resubscribeJoins.get(sessionId);
    if (markedAt === undefined) return false;
    this._resubscribeJoins.delete(sessionId);
    return (Date.now() - markedAt) < RESUBSCRIBE_JOIN_TTL_MS;
  }

  handleSessionJoined(data) {
    // A relay reconnect re-joins every open session tab to refresh upstream
    // subscription state the new connection lost, but the user never dropped
    // their own socket — they may be sitting on an unrelated tab typing.
    // Checked before currentSessionId is touched (unlike _silentHistoryRefresh
    // below, which clobbers it first and only avoids the render): a
    // resubscribe reply must never steal focus, only silently refresh state.
    const isResubscribeJoin = this._consumeResubscribeJoin(data.sessionId);

    // Redundant with the per-event v gate, but surfaces the mismatch on
    // join rather than waiting for the first llm_event.
    const serverMajor = parseInt(data.protocolVersion, 10);
    if (Number.isFinite(serverMajor) && serverMajor !== EVENT_PROTOCOL_VERSION) {
      this._versionMismatchSurfaced = true;
      const msg = `Server is on protocol v${data.protocolVersion}; this client expects v${EVENT_PROTOCOL_VERSION}. Refusing to render until versions match.`;
      console.error('[message-dispatcher] protocol version mismatch on session_joined', { expected: EVENT_PROTOCOL_VERSION, got: data.protocolVersion });
      this.renderer.appendSystemMessage(msg, 'error');
    }

    if (!isResubscribeJoin) {
      this.state.currentSessionId = data.sessionId;
    }

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

    if (isResubscribeJoin) {
      this.flushBackgroundBuffer(data.sessionId);
      if (data.stats) this.app.updateStats(data.stats);
      // Only the tab already on screen gets repainted, to pick up anything
      // that streamed during the outage — never a tab switch.
      if (data.sessionId === this.state.currentSessionId) {
        this.app.renderMessages();
      }
      return;
    }

    // Used by the deferred re-join after task completion.
    if (this._silentHistoryRefresh === data.sessionId) {
      this._silentHistoryRefresh = null;
      if (data.stats) this.app.updateStats(data.stats);
      return;
    }

    this.flushBackgroundBuffer(data.sessionId);
    this.app.showChatScreen();

    // Content is already live-streamed on screen; avoid clearing/re-rendering it.
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
    // updateSession emits SESSION_UPDATED; the sidebar panel listens for that,
    // not SESSION_RENAMED.
    if (this.state.sessions.has(data.sessionId)) {
      this.state.updateSession(data.sessionId, { name: data.name });
    }
    if (this.sidebar?.renamingSessionId !== data.sessionId) {
      this.sidebar?.renderProjectList?.();
    }
    if (this.tabManager) {
      this.tabManager.updateTabLabel(data.sessionId, data.name || this.app.getSessionDisplayName(data.sessionId));
    }
  }

  handleSessionFolderChanged(data) {
    if (this.state.sessions.has(data.sessionId)) {
      this.state.updateSession(data.sessionId, { folder: data.folder || '' });
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

  handleLlmEvent(event) {
    switch (event.type) {
      case 'user':
        // Claude CLI also emits user-typed events carrying tool_result blocks
        // in message.content, distinct from the user's own submitted text.
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

  _handleTitleEvent(event) {
    const sid = event.sessionId || this.state.currentSessionId;
    if (!sid) return;
    const title = event.customTitle || event.aiTitle;
    if (!title) return;
    const session = this.state.sessions.get(sid);
    if (!session) return;
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
    this.permissions.syncMode(mode);
  }

  handleAssistantEvent(event) {
    // Must check content_block_stop before content_block: a tool_use stop
    // event carries both, and checking content_block first double-renders it.
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

  _activeRenderer() {
    return this._sidechainStack.length > 0
      ? this._sidechainStack[this._sidechainStack.length - 1].renderer
      : this.renderer;
  }

  // Saves the parent's block-tracking state so the sub-agent's own stream
  // indices don't collide with the parent's still-open blocks.
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

  _popSidechain(toolUseId) {
    const idx = this._sidechainStack.findIndex(f => f.toolUseId === toolUseId);
    if (idx < 0) return null;
    const frame = this._sidechainStack[idx];
    // Defensive: also drop anything orphaned above the matched frame, though
    // parallel sub-agents aren't interleaved in practice.
    this._sidechainStack.splice(idx);
    if (this._sidechainStack.length === 0) {
      this._openBlockKindByIndex = frame.savedBlockKindByIndex || {};
    }
    return frame;
  }

  // Returns true if toolUseId closed a sidechain; caller must not also
  // render the tool_result via the normal path — the agent block IS it.
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
    // Canonical message_start has empty content; Claude CLI rarely sends a
    // full pre-built content array instead.
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

  // A tool named Agent/Task only counts as a sub-agent dispatch if it also
  // carries subagent_type — chat-base providers can reuse those names without it.
  _tryStartSidechain(block) {
    if (!this._isSubagentDispatch(block)) return false;
    const description = block.input?.description || '';
    this._pushSidechain(block.id, block.input.subagent_type, description);
    return true;
  }

  // Shared by the foreground renderer and the background buffer to keep
  // sub-agent text out of TTS.
  _isSubagentDispatch(block) {
    if (!block || !block.id) return false;
    if (block.name !== 'Agent' && block.name !== 'Task') return false;
    return !!block.input?.subagent_type;
  }

  _handleContentBlockStart(event) {
    const cb = event.content_block;
    const idx = event.index;
    if (!cb) return;

    if (typeof idx === 'number') {
      this._openBlockKindByIndex[idx] = cb.type;
    }

    const renderer = this._activeRenderer();

    if (cb.type === 'text') {
    } else if (cb.type === 'thinking') {
      // Wraps in <think> tags to reuse the renderer's foldable-section parser
      // rather than a dedicated thinking-block renderer.
      renderer.appendToAssistantMessage('<think>\n');
    } else if (cb.type === 'redacted_thinking') {
      // Atomic block, no thinking_delta follows: emit the full wrapper here.
      // _handleContentBlockStop only closes kind='thinking', not this.
      renderer.appendToAssistantMessage(REDACTED_THINKING_PLACEHOLDER);
    } else if (cb.type === 'tool_use') {
      this._streamingToolInputBuffer = '';
      if (cb.name === 'Write' && cb.input?.file_path && /\.claude\/plans\//.test(cb.input.file_path)) {
        this.lastPlanFilePath = cb.input.file_path;
      }
      if (this._tryStartSidechain(cb)) return;
      if (this.isInteractiveTool(cb.name)) {
        this.pendingInteractiveTool = { name: cb.name, input: cb.input || {} };
      } else {
        this._lastNonInteractiveToolName = cb.name;
        renderer.appendToolUse(cb.name, cb.input || {}, cb.id);
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
      // Never follow sub-agent deltas, only the main thread.
      if (this._sidechainStack.length === 0) {
        this.voice?.handleAssistantDelta(d.text);
        this._accumulateClientTTS(this.state.currentSessionId, d.text);
      }
    } else if (d.type === 'thinking_delta') {
      renderer.appendToAssistantMessage(d.thinking || '');
    } else if (d.type === 'input_json_delta') {
      // The fully-resolved input arrives via content_block_stop, so this
      // only needs to feed the live tool-input preview, not accumulate.
      this._handleStreamingToolInput(d.partial_json || '');
    }
  }

  _handleContentBlockStop(event) {
    const idx = event.index;
    const kind = (typeof idx === 'number') ? this._openBlockKindByIndex[idx] : undefined;
    const renderer = this._activeRenderer();

    if (kind === 'thinking') {
      renderer.appendToAssistantMessage('\n</think>\n\n');
    } else if (kind === 'tool_use' || (event.content_block && event.content_block.type === 'tool_use')) {
      // content_block_stop only updates the displayed input; the matching
      // tool_result event (not this) marks the tool complete.
      const finalInput = event.content_block?.input;
      if (finalInput !== undefined && finalInput !== null) {
        renderer.updateToolInput(finalInput);
      }
      this._streamingToolInputBuffer = '';
    }
    if (typeof idx === 'number') delete this._openBlockKindByIndex[idx];
  }

  // Some upstream providers emit word-sized deltas; parsing every fragment
  // instead of buffering until valid JSON would flash the tool-input summary
  // through each partial fragment instead of settling on a clean one.
  _handleStreamingToolInput(input) {
    let parsed = null;
    if (typeof input === 'string') {
      this._streamingToolInputBuffer += input;
      // Only attempt to parse once a closing brace lands, to keep a
      // multi-hundred-delta Edit/Write call off the UI thread.
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
      // message_complete re-parses accumulated _rawInput for interactive
      // tools, so mirror the raw string here too.
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

    if (this.lastPlanFilePath) {
      this.ws.send({ type: 'read_plan_file', path: this.lastPlanFilePath });
      this.lastPlanFilePath = null;
    }

    this.modalManager.showPlanApproval((approved) => {
      if (approved) {
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

  // Claude Code retries automatically up to maxRetries; surface the retry
  // context so users don't just see a stalled spinner.
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

  // event.content carries a URL the user can open to control this session
  // from the Claude.ai web app.
  _renderBridgeStatus(event) {
    const text = event.content || 'Remote control active';
    this.renderer.appendSystemMessage(text);
  }

  _renderStopHookSummary(event) {
    const errors = Array.isArray(event.hookErrors) ? event.hookErrors : [];
    if (errors.length === 0) return;
    const detail = errors.map(e => (typeof e === 'string' ? e : (e?.message || JSON.stringify(e)))).join('; ');
    this.renderer.appendSystemMessage(`Stop hook error: ${detail}`, 'warning');
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = MessageDispatcher;
}
