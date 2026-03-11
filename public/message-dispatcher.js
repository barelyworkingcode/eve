/**
 * MessageDispatcher - handles server message routing and LLM event processing.
 * Extracted from EveWorkspaceClient to separate message dispatch from orchestration.
 */
class MessageDispatcher {
  constructor(client) {
    this.client = client;
  }

  dispatch(data) {
    switch (data.type) {
      case 'session_created':
        this.handleSessionCreated(data);
        break;

      case 'session_joined':
        this.handleSessionJoined(data);
        break;

      case 'session_renamed':
        this.handleSessionRenamed(data);
        break;

      case 'llm_event':
        this.handleLlmEvent(data.event);
        break;

      case 'raw_output':
        this.client.messageRenderer.appendRawOutput(data.text);
        break;

      case 'stderr':
        this.client.messageRenderer.appendSystemMessage(data.text, 'error');
        break;

      case 'session_ended':
        this.handleSessionEnded(data);
        break;

      case 'process_exited':
        this.client.messageRenderer.hideThinkingIndicator();
        this.client.messageRenderer.appendSystemMessage('Provider process exited. Will restart on next message.');
        this.client.hideStopButton();
        break;

      case 'error':
        this.client.messageRenderer.hideThinkingIndicator();
        this.client.messageRenderer.appendSystemMessage(data.message, 'error');
        this.client.hideStopButton();
        break;

      case 'system_message':
        this.client.messageRenderer.appendSystemMessage(data.message);
        break;

      case 'clear_messages':
        this.client.messageRenderer.clearMessages();
        break;

      case 'message_complete':
        this.client.messageRenderer.hideThinkingIndicator();
        this.client.messageRenderer.finishAssistantMessage();
        this.client.hideStopButton();
        break;

      case 'stats_update':
        this.client.updateStats(data.stats);
        break;

      case 'directory_listing':
        this.client.fileBrowser.handleDirectoryListing(data.projectId, data.path, data.entries);
        break;

      case 'file_content':
        this.client.handleFileContent(data.projectId, data.path, data.content);
        break;

      case 'file_error':
        this.client.fileBrowser.handleFileError(data.projectId, data.path, data.error);
        break;

      case 'file_saved':
        this.client.handleFileSaved(data.projectId, data.path);
        break;

      case 'file_renamed':
        this.client.fileBrowser.handleFileRenamed(data.projectId, data.oldPath, data.newPath);
        break;

      case 'file_moved':
        this.client.fileBrowser.handleFileMoved(data.projectId, data.oldPath, data.newPath);
        break;

      case 'file_deleted':
        this.client.fileBrowser.handleFileDeleted(data.projectId, data.path);
        break;

      case 'directory_created':
        this.client.fileBrowser.handleDirectoryCreated(data.projectId, data.path, data.name);
        break;

      case 'file_uploaded':
        this.client.fileBrowser.handleFileUploaded(data.projectId, data.destDirectory, data.fileName);
        break;

      case 'terminal_request':
        this.client.terminalManager.createTerminal(data.directory, data.command, data.args, data.sessionId);
        break;

      case 'terminal_created':
        this.client.terminalManager.onTerminalCreated(data.terminalId, data.directory, data.command);
        break;

      case 'terminal_output':
        this.client.terminalManager.onTerminalOutput(data.terminalId, data.data);
        break;

      case 'terminal_exit':
        this.client.terminalManager.onTerminalExit(data.terminalId, data.exitCode);
        break;

      case 'terminal_list':
        this.client.terminalManager.onTerminalList(data.terminals);
        break;

      case 'permission_request':
        this.client.modalManager.showPermissionModal(data);
        break;

      case 'plan_mode_exit':
        this.client.modalManager.showPlanApproval((approved) => {
          if (approved) {
            this.client.messageRenderer.appendUserMessage('Yes, proceed with the plan.');
            this.client.wsClient.send({ type: 'user_input', text: 'Yes, proceed with the plan.' });
            this.client.messageRenderer.showThinkingIndicator();
          } else {
            this.client.elements.userInput.placeholder = 'Describe what to change in the plan...';
            this.client.elements.userInput.focus();
          }
        });
        break;

      case 'warning':
        this.client.messageRenderer.appendSystemMessage(data.message, 'warning');
        break;
    }
  }

  // --- Session event handlers ---

  handleSessionCreated(data) {
    this.client.sessions.set(data.sessionId, {
      id: data.sessionId,
      directory: data.directory,
      projectId: data.projectId || null,
      name: data.name || null,
      model: data.model || null,
      active: true
    });
    this.client.currentSessionId = data.sessionId;
    localStorage.setItem('eve_currentSession', data.sessionId);
    this.client.sessionHistories.set(data.sessionId, []);
    this.client.showChatScreen();
    this.client.tabManager.openSession(data.sessionId);
    this.client.sidebarRenderer.renderProjectList();
    this.client.modalManager.hideSessionModal();
    this.client.modalManager.hidePlanApproval();
  }

  handleSessionJoined(data) {
    this.client.currentSessionId = data.sessionId;
    localStorage.setItem('eve_currentSession', data.sessionId);
    const existingSession = this.client.sessions.get(data.sessionId);
    if (existingSession) {
      if (data.name !== undefined) {
        existingSession.name = data.name || existingSession.name;
      }
      if (data.model) {
        existingSession.model = data.model;
      }
    }
    if (data.history && data.history.length > 0) {
      this.client.sessionHistories.set(data.sessionId, data.history);
    } else {
      this.client.sessionHistories.set(data.sessionId, []);
    }
    this.client.messageRenderer.clearMessages();
    this.client.showChatScreen();
    this.client.tabManager.openSession(data.sessionId);
    this.client.sidebarRenderer.renderProjectList();
    this.client.modalManager.hidePlanApproval();
    if (data.stats) {
      this.client.updateStats(data.stats);
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
    this.client.sessions.delete(data.sessionId);
    this.client.sessionHistories.delete(data.sessionId);
    this.client.tabManager.closeTab(data.sessionId);
    if (this.client.currentSessionId === data.sessionId) {
      this.client.currentSessionId = null;
      localStorage.removeItem('eve_currentSession');
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
            this.client.messageRenderer.appendToolUse(block.name, block.input);
          }
        }
      }
    } else if (event.content_block) {
      if (event.content_block.type === 'text') {
        this.client.messageRenderer.updateAssistantMessage(event.content_block.text);
      } else if (event.content_block.type === 'tool_use') {
        this.client.messageRenderer.appendToolUse(event.content_block.name, event.content_block.input);
      } else if (event.content_block.type === 'tool_use_input') {
        this.client.messageRenderer.updateToolInput(event.content_block.input);
      }
    } else if (event.delta) {
      if (event.delta.type === 'text_delta') {
        this.client.messageRenderer.appendToAssistantMessage(event.delta.text);
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
