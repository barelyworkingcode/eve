const { spawn } = require('child_process');
const LLMProvider = require('./llm-provider');

class GeminiProvider extends LLMProvider {
  constructor(session, config = {}) {
    super(session);
    this.geminiProcess = null;
    this.buffer = '';
    this.geminiSessionId = null;
    this.currentAssistantMessage = null;

    // Provider configuration (from settings.json or defaults)
    this.config = {
      path: config.path || null, // null means use env var or default
      responseTimeout: config.responseTimeout || 120000,
      debug: config.debug || false
    };

    if (this.config.debug) {
      console.log('[Gemini] Initialized with config:', this.config);
    }
  }

  startProcess() {
    // Not used - gemini spawns a new process per message in sendMessage()
  }

  sendMessage(text, files = []) {
    console.log('[Gemini] sendMessage:', text.substring(0, 100));

    if (this.session.processing) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        message: 'Please wait for the current response to complete'
      }));
      return;
    }

    this.session.processing = true;

    // For gemini, we'll send files inline with the text
    let content = text;
    if (files && files.length > 0) {
      for (const f of files) {
        if (f.type !== 'image') {
          content = `<file name="${f.name}">\n${f.content}\n</file>\n\n${content}`;
        }
      }
    }

    // Gemini processes one message at a time, spawning a new process each time
    const args = [
      '-o', 'stream-json',
      '-p', ''  // Use stdin for message content
    ];

    // Resume previous session if we have one
    if (this.geminiSessionId) {
      args.push('--resume', this.geminiSessionId);
    }

    // Only add model if not using auto
    if (this.session.model && !this.session.model.startsWith('auto-')) {
      args.push('-m', this.session.model);
    }

    // Priority: config path > env var > default
    const geminiPath = this.config.path || process.env.GEMINI_PATH || 'gemini';

    if (this.config.debug) {
      console.log('[Gemini] Using path:', geminiPath);
    }
    const resumeFlag = this.geminiSessionId ? ` --resume ${this.geminiSessionId.substring(0, 8)}...` : '';
    console.log('[SPAWN]', geminiPath, '-o stream-json -p' + resumeFlag);
    console.log('[STDIN]', content.substring(0, 100) + (content.length > 100 ? '...' : ''));

    this.geminiProcess = spawn(geminiPath, args, {
      cwd: this.session.directory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Write content to stdin (add newline if not present)
    const contentWithNewline = content.endsWith('\n') ? content : content + '\n';
    this.geminiProcess.stdin.write(contentWithNewline);
    this.geminiProcess.stdin.end();

    this.geminiProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      console.log('[STDOUT]', chunk);
      this.buffer += chunk;

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

    this.geminiProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      // Filter out noisy stderr messages
      if (!msg.includes('DeprecationWarning') && !msg.includes('Loaded cached') && !msg.includes('Hook registry')) {
        console.log('[STDERR]', msg);
        if (this.session.ws && this.session.ws.readyState === 1) {
          this.session.ws.send(JSON.stringify({
            type: 'stderr',
            sessionId: this.session.sessionId,
            text: msg
          }));
        }
      }
    });

    this.geminiProcess.on('close', (code) => {
      console.log('[EXIT]', 'Provider process exited with code:', code);

      // Process any remaining buffered output
      if (this.buffer.trim()) {
        try {
          const event = JSON.parse(this.buffer);
          this.handleEvent(event);
        } catch (e) {
          console.log('[BUFFER]', 'Remaining:', this.buffer);
        }
        this.buffer = '';
      }

      this.geminiProcess = null;

      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'process_exited',
          sessionId: this.session.sessionId,
          code
        }));
      }
    });

    this.geminiProcess.on('error', (err) => {
      console.error('[ERROR]', err);
      this.geminiProcess = null;
      this.session.processing = false;
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'error',
          sessionId: this.session.sessionId,
          message: err.message
        }));
      }
    });
  }

  normalizeEvent(event) {
    // Transform Gemini events to common Claude-like format
    if (event.type === 'message' && event.role === 'assistant' && event.delta) {
      // Gemini streaming: {type: 'message', role: 'assistant', content: 'text', delta: true}
      // -> Claude format: {type: 'assistant', delta: {type: 'text_delta', text: 'text'}}
      return {
        type: 'assistant',
        delta: {
          type: 'text_delta',
          text: event.content || ''
        }
      };
    }

    // Pass through other events unchanged (like 'result', 'init')
    return event;
  }

  handleEvent(event) {
    console.log('[Gemini] handleEvent:', event.type);

    // Start tracking assistant message (normalized format from normalizeEvent)
    if (event.type === 'assistant' && !this.currentAssistantMessage) {
      this.currentAssistantMessage = {
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: [{ type: 'text', text: '' }]
      };
    }

    // Accumulate assistant message content deltas
    if (event.type === 'assistant' && event.delta && this.currentAssistantMessage) {
      if (event.delta.type === 'text_delta' && event.delta.text) {
        let textBlock = this.currentAssistantMessage.content.find(b => b.type === 'text');
        if (!textBlock) {
          textBlock = { type: 'text', text: '' };
          this.currentAssistantMessage.content.push(textBlock);
        }
        textBlock.text += event.delta.text;
      }
    }

    // Capture session ID from init event
    if (event.type === 'init' && event.session_id) {
      this.geminiSessionId = event.session_id;
      console.log('[SESSION]', 'Gemini session ID:', this.geminiSessionId);
    }

    // Track stats from result event
    if (event.type === 'result' && event.stats) {
      const stats = event.stats;
      this.session.stats.inputTokens += stats.input_tokens || 0;
      this.session.stats.outputTokens += stats.output_tokens || 0;

      // Gemini doesn't provide detailed cost, estimate or set to 0
      // Rough estimate: flash is ~$0.075 per 1M input, $0.30 per 1M output
      const inputCost = (stats.input_tokens || 0) * 0.075 / 1000000;
      const outputCost = (stats.output_tokens || 0) * 0.30 / 1000000;
      this.session.stats.costUsd += inputCost + outputCost;

      const totalTokens = this.session.stats.inputTokens + this.session.stats.outputTokens;
      const contextPercent = Math.round((totalTokens / this.session.stats.contextWindow) * 100);

      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'stats_update',
          sessionId: this.session.sessionId,
          stats: {
            ...this.session.stats,
            contextPercent,
            totalTokens
          }
        }));
      }
    }

    if (event.type === 'result') {
      this.session.processing = false;

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
    if (this.geminiProcess) {
      this.geminiProcess.kill();
    }
  }

  getMetadata() {
    return `Gemini ${this.session.model} • ${this.session.directory}`;
  }

  static getModels() {
    return [
      { value: 'auto-gemini-2.5', label: 'Auto Gemini 2.5 (recommended)', group: 'Gemini' },
      { value: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite (cheap)', group: 'Gemini' },
      { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', group: 'Gemini' }
    ];
  }

  static getCommands() {
    const modelNames = GeminiProvider.getModels().map(m => m.value).join(', ');
    return [
      { name: 'model', description: `Switch model (${modelNames})` }
    ];
  }

  handleCommand(command, args, sendSystemMessage) {
    const models = GeminiProvider.getModels().map(m => m.value);

    if (command === 'model') {
      if (args.length === 0) {
        sendSystemMessage(`Current model: ${this.session.model}\nAvailable: ${models.join(', ')}`);
        return true;
      }

      const newModel = args[0].toLowerCase();
      if (models.includes(newModel)) {
        // Kill current process if running
        if (this.geminiProcess) {
          this.geminiProcess.kill();
          this.geminiProcess = null;
        }

        // Update session model (Gemini spawns new process per message)
        this.session.model = newModel;
        sendSystemMessage(`Model changed to: ${newModel}`);
      } else {
        sendSystemMessage(`Invalid model "${newModel}". Available: ${models.join(', ')}`);
      }
      return true;
    }

    return false;
  }
}

module.exports = GeminiProvider;
