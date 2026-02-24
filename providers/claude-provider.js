const { execFile } = require('child_process');
const LLMProvider = require('./llm-provider');
const ClaudeProcess = require('./claude-process');
const ClaudeArgsManager = require('./claude-args-manager');

class ClaudeProvider extends LLMProvider {
  constructor(session, config = {}) {
    super(session);
    this.claudeProcess = null;
    this.buffer = '';
    this.currentAssistantMessage = null;

    // Restore persisted state from session
    this.claudeSessionId = null;
    this.customArgs = [];
    this.restoreSessionState(session.providerState);

    this.config = {
      path: config.path || null,
      responseTimeout: config.responseTimeout || 120000,
      debug: config.debug || false
    };

    // Retry configuration
    this.retryCount = 0;
    this.maxRetries = 5;
    this.baseRetryDelay = 100;
    this.maxRetryDelay = 2000;
    this.fatalError = null;

    // Health monitoring
    this.lastActivityTime = null;
    this.responseTimeoutMs = this.config.responseTimeout;
    this.activityCheckInterval = null;
    this.activityCheckFrequency = 10000;

    // Delegates
    this._process = new ClaudeProcess(this);
    this._argsManager = new ClaudeArgsManager(this);

    if (this.config.debug) {
      console.log('[Claude] Initialized with config:', this.config);
    }
  }

  // --- Activity monitoring ---

  startActivityMonitor() {
    this.stopActivityMonitor();
    this.lastActivityTime = Date.now();

    this.activityCheckInterval = setInterval(() => {
      if (!this.session.processing || !this.claudeProcess) return;

      const elapsed = Date.now() - this.lastActivityTime;
      if (elapsed > this.responseTimeoutMs) {
        console.log(`[Claude] Response timeout after ${elapsed}ms, process may be hung`);
        this.session.ws?.send(JSON.stringify({
          type: 'warning',
          sessionId: this.session.sessionId,
          message: `No response from Claude CLI for ${Math.round(elapsed / 1000)} seconds. The process may be hung.`
        }));
      }
    }, this.activityCheckFrequency);
  }

  stopActivityMonitor() {
    if (this.activityCheckInterval) {
      clearInterval(this.activityCheckInterval);
      this.activityCheckInterval = null;
    }
  }

  recordActivity() {
    this.lastActivityTime = Date.now();
  }

  // --- File validation ---

  static MAX_FILE_SIZE = 10 * 1024 * 1024;
  static MAX_TOTAL_SIZE = 50 * 1024 * 1024;
  static SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  validateFiles(files) {
    if (!files || files.length === 0) return { valid: true, files };

    const errors = [];
    let totalSize = 0;
    const validFiles = [];

    for (const file of files) {
      let fileSize;
      if (file.type === 'image' && file.content.startsWith('data:')) {
        const base64Match = file.content.match(/^data:([^;]+);base64,(.+)$/);
        if (base64Match) {
          const mediaType = base64Match[1];
          const base64Data = base64Match[2];
          fileSize = Math.ceil(base64Data.length * 0.75);
          if (!ClaudeProvider.SUPPORTED_IMAGE_TYPES.includes(mediaType)) {
            errors.push(`Unsupported image type '${mediaType}' for ${file.name}. Supported: ${ClaudeProvider.SUPPORTED_IMAGE_TYPES.join(', ')}`);
            continue;
          }
        } else {
          errors.push(`Invalid image format for ${file.name}`);
          continue;
        }
      } else {
        fileSize = new TextEncoder().encode(file.content).length;
      }

      if (fileSize > ClaudeProvider.MAX_FILE_SIZE) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        const maxMB = (ClaudeProvider.MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
        errors.push(`File '${file.name}' is too large (${sizeMB}MB). Maximum: ${maxMB}MB`);
        continue;
      }

      totalSize += fileSize;
      validFiles.push(file);
    }

    if (totalSize > ClaudeProvider.MAX_TOTAL_SIZE) {
      const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
      const maxMB = (ClaudeProvider.MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0);
      return { valid: false, errors: [`Total attachment size (${totalMB}MB) exceeds maximum (${maxMB}MB). Remove some files.`] };
    }

    if (errors.length > 0) return { valid: false, errors };
    return { valid: true, files: validFiles };
  }

  // --- Process lifecycle (delegated) ---

  startProcess() {
    this._process.startProcess();
  }

  kill() {
    this._process.kill();
  }

  // --- Message sending ---

  sendMessage(text, files = []) {
    console.log('[Claude] sendMessage:', text.substring(0, 100));

    if (this.fatalError) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        sessionId: this.session.sessionId,
        message: this.fatalError
      }));
      return;
    }

    if (!this.claudeProcess) {
      if (this.retryCount >= this.maxRetries) {
        this.session.ws?.send(JSON.stringify({
          type: 'error',
          sessionId: this.session.sessionId,
          message: `Failed to start Claude CLI after ${this.maxRetries} attempts. Check server logs for details.`
        }));
        this.retryCount = 0;
        return;
      }

      this.startProcess();
      this.retryCount++;

      const delay = Math.min(this.baseRetryDelay * Math.pow(2, this.retryCount - 1), this.maxRetryDelay);
      console.log(`[Claude] Process not ready, retry ${this.retryCount}/${this.maxRetries} in ${delay}ms`);

      setTimeout(() => this.sendMessage(text, files), delay);
      return;
    }

    this.retryCount = 0;

    if (this.session.processing) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        sessionId: this.session.sessionId,
        message: 'Please wait for the current response to complete'
      }));
      return;
    }

    const validation = this.validateFiles(files);
    if (!validation.valid) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        sessionId: this.session.sessionId,
        message: validation.errors.join('\n')
      }));
      return;
    }
    const validatedFiles = validation.files || [];

    this.session.processing = true;
    this.startActivityMonitor();

    let content;
    if (validatedFiles.length > 0) {
      const contentBlocks = [];
      for (const f of validatedFiles) {
        if (f.type === 'image') {
          const base64Match = f.content.match(/^data:([^;]+);base64,(.+)$/);
          if (base64Match) {
            contentBlocks.push({
              type: 'image',
              source: { type: 'base64', media_type: base64Match[1], data: base64Match[2] }
            });
          }
        } else {
          contentBlocks.push({ type: 'text', text: `<file name="${f.name}">\n${f.content}\n</file>` });
        }
      }
      contentBlocks.push({ type: 'text', text });
      content = contentBlocks;
    } else {
      content = text;
    }

    const message = JSON.stringify({
      type: 'user',
      message: { role: 'user', content }
    });

    console.log('[STDIN]', message);

    try {
      const writeSuccess = this.claudeProcess.stdin.write(message + '\n');
      if (!writeSuccess) {
        this.claudeProcess.stdin.once('drain', () => {
          console.log('[Claude] stdin drained, write completed');
        });
      }
    } catch (err) {
      console.error('[Claude] stdin write error:', err.message);
      this.session.processing = false;
      this.stopActivityMonitor();
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        sessionId: this.session.sessionId,
        message: `Failed to send message to Claude CLI: ${err.message}`
      }));
    }
  }

  // --- Event handling ---

  processLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (e) {
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'raw_output',
          sessionId: this.session.sessionId,
          text: line
        }));
      }
      return;
    }
    try {
      this.handleEvent(event);
    } catch (e) {
      console.error('[Claude] handleEvent error:', e.message, 'event type:', event.type);
    }
  }

  handleEvent(event) {
    console.log('[Claude] handleEvent:', event.type);

    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
      this.claudeSessionId = event.session_id;
      console.log('[Claude] Session ID:', this.claudeSessionId);
      if (this.session.saveHistory) {
        this.session.providerState = this.getSessionState();
        this.session.saveHistory();
      }
    }

    if (event.type === 'assistant' && event.message) {
      this.currentAssistantMessage = {
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: event.message.content || []
      };
    }

    if (event.type === 'assistant' && event.delta && this.currentAssistantMessage) {
      if (event.delta.type === 'text_delta' && event.delta.text) {
        let textBlock = this.currentAssistantMessage.content.find(b => b.type === 'text');
        if (!textBlock) {
          textBlock = { type: 'text', text: '' };
          this.currentAssistantMessage.content.push(textBlock);
        }
        textBlock.text += event.delta.text;
      } else if (event.delta.type === 'tool_use') {
        this.currentAssistantMessage.content.push(event.delta);
      }
    }

    if (event.type === 'user' && typeof event.message?.content === 'string') {
      const content = event.message.content;
      const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
      if (match) {
        this.session.ws?.send(JSON.stringify({
          type: 'system_message',
          sessionId: this.session.sessionId,
          message: match[1].trim()
        }));
        this.session.processing = false;
        this.stopActivityMonitor();
        this.session.ws?.send(JSON.stringify({
          type: 'message_complete',
          sessionId: this.session.sessionId
        }));
        return;
      }
    }

    if (event.type === 'result' && event.usage) {
      const usage = event.usage;
      this.session.stats.inputTokens += usage.input_tokens || 0;
      this.session.stats.outputTokens += usage.output_tokens || 0;
      this.session.stats.cacheReadTokens += usage.cache_read_input_tokens || 0;
      this.session.stats.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
      this.session.stats.costUsd = event.total_cost_usd || this.session.stats.costUsd;

      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'stats_update',
          sessionId: this.session.sessionId,
          stats: this.session.stats
        }));
      }
    }

    if (event.type === 'result') {
      this.session.processing = false;
      this.stopActivityMonitor();

      if (event.result && !this.currentAssistantMessage) {
        this.session.ws?.send(JSON.stringify({
          type: 'system_message',
          sessionId: this.session.sessionId,
          message: event.result
        }));
      }

      if (this.currentAssistantMessage) {
        this.session.messages.push(this.currentAssistantMessage);
        this.currentAssistantMessage = null;
        if (this.session.saveHistory) this.session.saveHistory();
      }

      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'message_complete',
          sessionId: this.session.sessionId
        }));
      }
    }

    this.sendEvent(event);
  }

  // --- Metadata and state ---

  getMetadata() {
    return `Claude ${this.session.model} • ${this.session.directory}`;
  }

  getSessionState() {
    return {
      claudeSessionId: this.claudeSessionId,
      customArgs: this.customArgs?.length > 0 ? [...this.customArgs] : []
    };
  }

  restoreSessionState(state) {
    if (!state) return;
    this.claudeSessionId = state.claudeSessionId || null;
    this.customArgs = state.customArgs?.length > 0 ? [...state.customArgs] : [];
  }

  static clearSessionState(session) {
    delete session.providerState;
  }

  static getModels() {
    return [
      { value: 'haiku', label: 'Haiku (fast, cheap)', group: 'Claude' },
      { value: 'sonnet', label: 'Sonnet (balanced)', group: 'Claude' },
      { value: 'opus', label: 'Opus (powerful)', group: 'Claude' }
    ];
  }

  static getCommands() {
    const modelNames = ClaudeProvider.getModels().map(m => m.value).join(', ');
    return [
      { name: 'model', description: `Switch model (${modelNames})` },
      { name: 'compact', description: 'Compact conversation history' },
      { name: 'cost', description: 'Show usage/billing info' },
      { name: 'context', description: 'Show context window usage' },
      { name: 'args', description: 'Show current CLI args' },
      { name: 'args-edit', description: 'Add/remove CLI args (restarts process)' },
      { name: 'cli-help', description: 'Show Claude CLI --help output' },
      { name: 'transfer-cli', description: 'Transfer session to Claude CLI terminal' }
    ];
  }

  // --- Command handling ---

  handleCommand(command, args, sendSystemMessage, rawText) {
    const models = ClaudeProvider.getModels().map(m => m.value);

    if (command === 'model') {
      if (args.length === 0) {
        sendSystemMessage(`Current model: ${this.session.model}\nAvailable: ${models.join(', ')}`);
        return true;
      }
      const newModel = args[0].toLowerCase();
      if (models.includes(newModel)) {
        if (this.claudeProcess) {
          this.claudeProcess.kill();
          this.claudeProcess = null;
        }
        this.session.model = newModel;
        this.startProcess();
        sendSystemMessage(`Model changed to: ${newModel}`);
      } else {
        sendSystemMessage(`Invalid model "${newModel}". Available: ${models.join(', ')}`);
      }
      return true;
    }

    if (command === 'args') {
      let lines = [`--model ${this.session.model}`];
      if (this.customArgs.length > 0) {
        lines.push(this._argsManager.formatArgsForDisplay(this.customArgs));
      } else {
        lines.push('\nNo custom args. Use /args-edit to add flags.');
      }
      sendSystemMessage('Current CLI args:\n' + lines.join('\n'));
      return true;
    }

    if (command === 'args-edit') {
      this._argsManager.handleArgsEdit(rawText, sendSystemMessage);
      return true;
    }

    if (command === 'cli-help') {
      this.showCliHelp(sendSystemMessage);
      return true;
    }

    if (command === 'transfer-cli') {
      if (!this.claudeSessionId) {
        sendSystemMessage('No active Claude session to transfer. Send a message first to establish a session.');
        return true;
      }
      return {
        handled: true,
        transfer: {
          claudeSessionId: this.claudeSessionId,
          model: this.session.model,
          customArgs: [...this.customArgs]
        }
      };
    }

    return false;
  }

  // Delegated to ArgsManager for backward compatibility with tests
  parseQuotedArgs(str) { return this._argsManager.parseQuotedArgs(str); }
  formatArgsForDisplay(argsArray) { return this._argsManager.formatArgsForDisplay(argsArray); }
  removeCustomArg(flag) { return this._argsManager.removeCustomArg(flag); }

  showCliHelp(sendSystemMessage) {
    const claudePath = this.config.path ||
      process.env.CLAUDE_PATH ||
      (process.env.HOME ? `${process.env.HOME}/.local/bin/claude` : 'claude');

    execFile(claudePath, ['--help'], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        sendSystemMessage(`Failed to run claude --help: ${err.message}`);
        return;
      }
      sendSystemMessage(stdout || stderr || 'No output from claude --help.');
    });
  }
}

module.exports = ClaudeProvider;
