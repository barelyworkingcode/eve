const { spawn } = require('child_process');
const LLMProvider = require('./llm-provider');

class ClaudeProvider extends LLMProvider {
  constructor(session) {
    super(session);
    this.claudeProcess = null;
    this.buffer = '';
    this.currentAssistantMessage = null;
  }

  startProcess() {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--model', this.session.model
    ];

    const claudePath = process.env.CLAUDE_PATH ||
      (process.env.HOME ? `${process.env.HOME}/.local/bin/claude` : 'claude');

    console.log('[SPAWN]', claudePath, args.join(' '));

    this.claudeProcess = spawn(claudePath, args, {
      cwd: this.session.directory,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.claudeProcess.stdout.on('data', (data) => {
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

    this.claudeProcess.stderr.on('data', (data) => {
      console.log('[STDERR]', data.toString());
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
      this.session.processing = false;

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
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'error',
          sessionId: this.session.sessionId,
          message: err.message
        }));
      }
    });
  }

  sendMessage(text, files = []) {
    console.log('[Claude] sendMessage:', text.substring(0, 100));

    if (!this.claudeProcess) {
      this.startProcess();
      setTimeout(() => this.sendMessage(text, files), 500);
      return;
    }

    if (this.session.processing) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        message: 'Please wait for the current response to complete'
      }));
      return;
    }

    this.session.processing = true;

    let content;
    if (files && files.length > 0) {
      const contentBlocks = [];
      for (const f of files) {
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
    this.claudeProcess.stdin.write(message + '\n');
  }

  handleEvent(event) {
    console.log('[Claude] handleEvent:', event.type);

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

      if (event.modelUsage) {
        const modelKey = Object.keys(event.modelUsage)[0];
        if (modelKey) {
          this.session.stats.contextWindow = event.modelUsage[modelKey].contextWindow || 200000;
        }
      }

      this.session.stats.costUsd = event.total_cost_usd || this.session.stats.costUsd;

      const totalTokens = this.session.stats.inputTokens + this.session.stats.outputTokens +
                          this.session.stats.cacheReadTokens + this.session.stats.cacheCreationTokens;
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
}

module.exports = ClaudeProvider;
