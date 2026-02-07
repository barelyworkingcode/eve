const { spawn, execFile } = require('child_process');
const LLMProvider = require('./llm-provider');

class ClaudeProvider extends LLMProvider {
  constructor(session, config = {}) {
    super(session);
    this.claudeProcess = null;
    this.buffer = '';
    this.currentAssistantMessage = null;
    this.claudeSessionId = null;
    this.customArgs = [];

    // Provider configuration (from settings.json or defaults)
    this.config = {
      path: config.path || null, // null means use env var or default
      responseTimeout: config.responseTimeout || 120000,
      debug: config.debug || false
    };

    // Retry configuration
    this.retryCount = 0;
    this.maxRetries = 5;
    this.baseRetryDelay = 100; // ms
    this.maxRetryDelay = 2000; // ms
    this.fatalError = null; // Set when process fails to spawn (e.g., CLI not found)

    // Health monitoring
    this.lastActivityTime = null;
    this.responseTimeoutMs = this.config.responseTimeout;
    this.activityCheckInterval = null;
    this.activityCheckFrequency = 10000; // Check every 10 seconds

    if (this.config.debug) {
      console.log('[Claude] Initialized with config:', this.config);
    }
  }

  startActivityMonitor() {
    this.stopActivityMonitor(); // Clear any existing monitor
    this.lastActivityTime = Date.now();

    this.activityCheckInterval = setInterval(() => {
      if (!this.session.processing || !this.claudeProcess) {
        return; // Only monitor during active processing
      }

      const elapsed = Date.now() - this.lastActivityTime;
      if (elapsed > this.responseTimeoutMs) {
        console.log(`[Claude] Response timeout after ${elapsed}ms, process may be hung`);
        this.session.ws?.send(JSON.stringify({
          type: 'warning',
          sessionId: this.session.sessionId,
          message: `No response from Claude CLI for ${Math.round(elapsed / 1000)} seconds. The process may be hung.`
        }));
        // Don't auto-kill - user might be doing complex operations
        // Just warn and let user decide
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

  // File validation configuration
  static MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
  static MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total
  static SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

  // Args managed internally by startProcess() -- cannot be set via /args-edit
  static PROTECTED_ARGS = new Set([
    '--print', '--output-format', '--input-format', '--verbose', '--resume', '-p', '-r'
  ]);

  validateFiles(files) {
    if (!files || files.length === 0) {
      return { valid: true, files };
    }

    const errors = [];
    let totalSize = 0;
    const validFiles = [];

    for (const file of files) {
      // Calculate file size
      let fileSize;
      if (file.type === 'image' && file.content.startsWith('data:')) {
        // Base64 data URL - extract and calculate size
        const base64Match = file.content.match(/^data:([^;]+);base64,(.+)$/);
        if (base64Match) {
          const mediaType = base64Match[1];
          const base64Data = base64Match[2];
          fileSize = Math.ceil(base64Data.length * 0.75); // Base64 is ~33% larger than binary

          // Validate image type
          if (!ClaudeProvider.SUPPORTED_IMAGE_TYPES.includes(mediaType)) {
            errors.push(`Unsupported image type '${mediaType}' for ${file.name}. Supported: ${ClaudeProvider.SUPPORTED_IMAGE_TYPES.join(', ')}`);
            continue;
          }
        } else {
          errors.push(`Invalid image format for ${file.name}`);
          continue;
        }
      } else {
        // Text file - use string length as byte approximation
        fileSize = new TextEncoder().encode(file.content).length;
      }

      // Check individual file size
      if (fileSize > ClaudeProvider.MAX_FILE_SIZE) {
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        const maxMB = (ClaudeProvider.MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
        errors.push(`File '${file.name}' is too large (${sizeMB}MB). Maximum: ${maxMB}MB`);
        continue;
      }

      totalSize += fileSize;
      validFiles.push(file);
    }

    // Check total size
    if (totalSize > ClaudeProvider.MAX_TOTAL_SIZE) {
      const totalMB = (totalSize / (1024 * 1024)).toFixed(1);
      const maxMB = (ClaudeProvider.MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0);
      return {
        valid: false,
        errors: [`Total attachment size (${totalMB}MB) exceeds maximum (${maxMB}MB). Remove some files.`]
      };
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    return { valid: true, files: validFiles };
  }

  startProcess() {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', this.session.model
    ];

    // Append user-configured custom args
    if (this.customArgs.length > 0) {
      args.push(...this.customArgs);
    }

    // Resume existing session if we have an ID
    if (this.claudeSessionId) {
      args.push('--resume', this.claudeSessionId);
    }

    // Priority: config path > env var > default locations
    const claudePath = this.config.path ||
      process.env.CLAUDE_PATH ||
      (process.env.HOME ? `${process.env.HOME}/.local/bin/claude` : 'claude');

    if (this.config.debug) {
      console.log('[Claude] Using path:', claudePath);
    }
    const resumeFlag = this.claudeSessionId ? ` --resume ${this.claudeSessionId.substring(0, 8)}...` : '';
    console.log('[SPAWN]', claudePath, args.slice(0, 7).join(' ') + resumeFlag);

    this.claudeProcess = spawn(claudePath, args, {
      cwd: this.session.directory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.claudeProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      console.log('[STDOUT]', chunk);
      this.buffer += chunk;
      this.recordActivity(); // Track activity for health monitoring

      const lines = this.buffer.split('\n');
      this.buffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          try {
            const event = JSON.parse(line);
            this.handleEvent(event);
          } catch (e) {
            if (this.session.ws && this.session.ws.readyState === 1) {
              this.session.ws.send(JSON.stringify({
                type: 'raw_output',
                sessionId: this.session.sessionId,
                text: line
              }));
            }
          }
        }
      }
    });

    this.claudeProcess.stderr.on('data', (data) => {
      console.log('[STDERR]', data.toString());
      this.recordActivity(); // Track activity for health monitoring
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'stderr',
          sessionId: this.session.sessionId,
          text: data.toString()
        }));
      }
    });

    this.claudeProcess.on('close', (code) => {
      console.log('[EXIT]', 'Provider process exited with code:', code);
      this.claudeProcess = null;
      this.stopActivityMonitor();

      // Save partial message if process crashed mid-response
      if (this.currentAssistantMessage && this.session.processing) {
        const textBlock = this.currentAssistantMessage.content.find(b => b.type === 'text');
        if (textBlock && textBlock.text) {
          // Mark message as incomplete and save it
          this.currentAssistantMessage.incomplete = true;
          this.session.messages.push(this.currentAssistantMessage);
          if (this.session.saveHistory) {
            this.session.saveHistory();
          }
          console.log('[Claude] Saved partial response:', textBlock.text.substring(0, 100));

          // Notify user
          if (this.session.ws && this.session.ws.readyState === 1) {
            this.session.ws.send(JSON.stringify({
              type: 'warning',
              sessionId: this.session.sessionId,
              message: 'Response was interrupted. Partial content has been saved.'
            }));
          }
        }
        this.currentAssistantMessage = null;
      }

      this.session.processing = false;

      // Reset retry count on clean exit (allows restart)
      if (code === 0) {
        this.retryCount = 0;
      }

      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'process_exited',
          sessionId: this.session.sessionId,
          code
        }));
      }
    });

    this.claudeProcess.on('error', (err) => {
      console.error('[ERROR]', err);
      this.claudeProcess = null;
      this.session.processing = false;

      // Mark fatal errors that shouldn't be retried (e.g., CLI not found)
      if (err.code === 'ENOENT') {
        this.fatalError = `Claude CLI not found. Ensure 'claude' is installed and in PATH, or set CLAUDE_PATH environment variable.`;
      } else if (err.code === 'EACCES') {
        this.fatalError = `Permission denied executing Claude CLI. Check file permissions.`;
      }

      const errorMessage = this.fatalError || err.message;
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'error',
          sessionId: this.session.sessionId,
          message: errorMessage
        }));
      }
    });
  }

  sendMessage(text, files = []) {
    console.log('[Claude] sendMessage:', text.substring(0, 100));

    // Check for fatal error - don't retry if CLI is not available
    if (this.fatalError) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        sessionId: this.session.sessionId,
        message: this.fatalError
      }));
      return;
    }

    // Start process if needed with exponential backoff retry
    if (!this.claudeProcess) {
      if (this.retryCount >= this.maxRetries) {
        this.session.ws?.send(JSON.stringify({
          type: 'error',
          sessionId: this.session.sessionId,
          message: `Failed to start Claude CLI after ${this.maxRetries} attempts. Check server logs for details.`
        }));
        this.retryCount = 0; // Reset for future attempts
        return;
      }

      this.startProcess();
      this.retryCount++;

      // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms (capped at 2000ms)
      const delay = Math.min(this.baseRetryDelay * Math.pow(2, this.retryCount - 1), this.maxRetryDelay);
      console.log(`[Claude] Process not ready, retry ${this.retryCount}/${this.maxRetries} in ${delay}ms`);

      setTimeout(() => this.sendMessage(text, files), delay);
      return;
    }

    // Reset retry count on successful process availability
    this.retryCount = 0;

    if (this.session.processing) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        sessionId: this.session.sessionId,
        message: 'Please wait for the current response to complete'
      }));
      return;
    }

    // Validate files before processing
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
    if (validatedFiles && validatedFiles.length > 0) {
      const contentBlocks = [];
      for (const f of validatedFiles) {
        if (f.type === 'image') {
          const base64Match = f.content.match(/^data:([^;]+);base64,(.+)$/);
          if (base64Match) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: base64Match[1],
                data: base64Match[2]
              }
            });
          }
        } else {
          contentBlocks.push({
            type: 'text',
            text: `<file name="${f.name}">
${f.content}
</file>`
          });
        }
      }
      contentBlocks.push({
        type: 'text',
        text: text
      });
      content = contentBlocks;
    } else {
      content = text;
    }

    const message = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: content
      }
    });

    console.log('[STDIN]', message);

    // Write with error handling
    try {
      const writeSuccess = this.claudeProcess.stdin.write(message + '\n');
      if (!writeSuccess) {
        // Handle backpressure - wait for drain event
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

  handleEvent(event) {
    console.log('[Claude] handleEvent:', event.type);

    // Capture session ID from init event
    if (event.type === 'init' && event.session_id) {
      this.claudeSessionId = event.session_id;
      console.log('[Claude] Session ID:', this.claudeSessionId);

      // Persist to session store
      if (this.session.saveHistory) {
        this.session.claudeSessionId = this.claudeSessionId;
        this.session.saveHistory();
      }
    }

    // Start tracking assistant message
    if (event.type === 'assistant' && event.message) {
      this.currentAssistantMessage = {
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: event.message.content || []
      };
    }

    // Accumulate assistant message content deltas
    if (event.type === 'assistant' && event.delta && this.currentAssistantMessage) {
      if (event.delta.type === 'text_delta' && event.delta.text) {
        // Find or create text block
        let textBlock = this.currentAssistantMessage.content.find(b => b.type === 'text');
        if (!textBlock) {
          textBlock = { type: 'text', text: '' };
          this.currentAssistantMessage.content.push(textBlock);
        }
        textBlock.text += event.delta.text;
      } else if (event.delta.type === 'tool_use') {
        // Add tool use block
        this.currentAssistantMessage.content.push(event.delta);
      }
    }

    if (event.type === 'user' && event.message?.content) {
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

      // CLI sometimes returns quick responses directly in result (e.g., invalid commands)
      if (event.result && !this.currentAssistantMessage) {
        this.session.ws?.send(JSON.stringify({
          type: 'system_message',
          sessionId: this.session.sessionId,
          message: event.result
        }));
      }

      // Save assistant message to history
      if (this.currentAssistantMessage) {
        this.session.messages.push(this.currentAssistantMessage);
        this.currentAssistantMessage = null;
        if (this.session.saveHistory) {
          this.session.saveHistory();
        }
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

  kill() {
    this.stopActivityMonitor();
    if (this.claudeProcess) {
      this.claudeProcess.kill();
    }
  }

  getMetadata() {
    return `Claude ${this.session.model} • ${this.session.directory}`;
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
      { name: 'cli-help', description: 'Show Claude CLI --help output' }
    ];
  }

  handleCommand(command, args, sendSystemMessage, rawText) {
    const models = ClaudeProvider.getModels().map(m => m.value);

    if (command === 'model') {
      if (args.length === 0) {
        sendSystemMessage(`Current model: ${this.session.model}\nAvailable: ${models.join(', ')}`);
        return true;
      }

      const newModel = args[0].toLowerCase();
      if (models.includes(newModel)) {
        // Kill current process
        if (this.claudeProcess) {
          this.claudeProcess.kill();
          this.claudeProcess = null;
        }

        // Update session model
        this.session.model = newModel;

        // Restart process with new model
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
        lines.push(this.formatArgsForDisplay(this.customArgs));
      } else {
        lines.push('\nNo custom args. Use /args-edit to add flags.');
      }
      sendSystemMessage('Current CLI args:\n' + lines.join('\n'));
      return true;
    }

    if (command === 'args-edit') {
      this.handleArgsEdit(rawText, sendSystemMessage);
      return true;
    }

    if (command === 'cli-help') {
      this.showCliHelp(sendSystemMessage);
      return true;
    }

    // Let compact/cost/context pass through to the CLI
    return false;
  }

  // --- /args-edit implementation ---

  handleArgsEdit(rawText, sendSystemMessage) {
    // Extract everything after "/args-edit"
    const afterCommand = rawText.replace(/^\/args-edit\s*/, '');

    if (!afterCommand) {
      sendSystemMessage(
        'Usage:\n' +
        '  /args-edit --flag [value]   Add or update a CLI flag\n' +
        '  /args-edit --remove --flag  Remove a flag\n' +
        '  /args-edit --clear          Remove all custom args'
      );
      return;
    }

    const parsed = this.parseQuotedArgs(afterCommand);

    // --clear: remove all custom args
    if (parsed[0] === '--clear') {
      if (this.customArgs.length === 0) {
        sendSystemMessage('No custom args to clear.');
        return;
      }
      this.customArgs = [];
      this.persistCustomArgs();
      this.restartProcess(sendSystemMessage, 'All custom args cleared.');
      return;
    }

    // --remove --flag: remove a specific flag
    if (parsed[0] === '--remove') {
      if (parsed.length < 2) {
        sendSystemMessage('Usage: /args-edit --remove --flag');
        return;
      }
      const flag = parsed[1];
      const removed = this.removeCustomArg(flag);
      if (!removed) {
        sendSystemMessage(`Flag "${flag}" not found in custom args.`);
        return;
      }
      this.persistCustomArgs();
      this.restartProcess(sendSystemMessage, `Removed ${flag}.`);
      return;
    }

    // Add/update: --flag [value...]
    const flag = parsed[0];
    if (!flag.startsWith('-')) {
      sendSystemMessage(`Expected a flag starting with "-", got "${flag}".`);
      return;
    }

    // Block protected args
    if (ClaudeProvider.PROTECTED_ARGS.has(flag)) {
      sendSystemMessage(`"${flag}" is managed internally and cannot be changed via /args-edit.`);
      return;
    }

    // Intercept --model: update session.model instead of customArgs
    if (flag === '--model') {
      if (parsed.length < 2) {
        sendSystemMessage('Usage: /args-edit --model <model-name>');
        return;
      }
      const models = ClaudeProvider.getModels().map(m => m.value);
      const newModel = parsed[1].toLowerCase();
      if (!models.includes(newModel)) {
        sendSystemMessage(`Invalid model "${newModel}". Available: ${models.join(', ')}`);
        return;
      }
      this.session.model = newModel;
      this.restartProcess(sendSystemMessage, `Model changed to: ${newModel}`);
      return;
    }

    const values = parsed.slice(1);

    // Remove existing entry for this flag before adding
    this.removeCustomArg(flag);
    this.customArgs.push(flag, ...values);
    this.persistCustomArgs();

    const display = values.length > 0 ? `${flag} ${values.join(' ')}` : flag;
    this.restartProcess(sendSystemMessage, `Added ${display}.`);
  }

  // --- Helper methods ---

  parseQuotedArgs(str) {
    const result = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < str.length; i++) {
      const ch = str[i];

      if (ch === "'" && !inDouble) {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle) {
        inDouble = !inDouble;
      } else if (/\s/.test(ch) && !inSingle && !inDouble) {
        if (current.length > 0) {
          result.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current.length > 0) {
      result.push(current);
    }
    return result;
  }

  formatArgsForDisplay(argsArray) {
    const lines = [];
    let i = 0;
    while (i < argsArray.length) {
      let entry = argsArray[i];
      i++;
      // Collect following non-flag values
      while (i < argsArray.length && !argsArray[i].startsWith('-')) {
        entry += ' ' + argsArray[i];
        i++;
      }
      lines.push(entry);
    }
    return lines.join('\n');
  }

  removeCustomArg(flag) {
    const idx = this.customArgs.indexOf(flag);
    if (idx === -1) return false;

    // Remove flag and any following non-flag values
    let end = idx + 1;
    while (end < this.customArgs.length && !this.customArgs[end].startsWith('-')) {
      end++;
    }
    this.customArgs.splice(idx, end - idx);
    return true;
  }

  persistCustomArgs() {
    this.session.customArgs = this.customArgs;
    if (this.session.saveHistory) {
      this.session.saveHistory();
    }
  }

  restartProcess(sendSystemMessage, message) {
    if (this.claudeProcess) {
      this.claudeProcess.kill();
      this.claudeProcess = null;
    }
    this.startProcess();
    sendSystemMessage(message + ' Process restarted.');
  }

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
