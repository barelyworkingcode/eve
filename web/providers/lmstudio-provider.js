const http = require('http');
const fs = require('fs');
const path = require('path');
const LLMProvider = require('./llm-provider');

class LMStudioProvider extends LLMProvider {
  constructor(session) {
    super(session);
    this.conversationHistory = [];
    this.loadConfig();
  }

  loadConfig() {
    const configPath = path.join(__dirname, '..', 'data', 'lmstudio-config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      this.baseUrl = config.baseUrl || 'http://localhost:1234/v1';
      this.models = config.models || [];

      const url = new URL(this.baseUrl);
      this.hostname = url.hostname;
      this.port = url.port || 1234;
      this.basePath = url.pathname;
    } catch (err) {
      console.error('[LMStudio] Failed to load config:', err.message);
      this.baseUrl = 'http://localhost:1234/v1';
      this.hostname = 'localhost';
      this.port = 1234;
      this.basePath = '/v1';
      this.models = [];
    }
  }

  startProcess() {
    // No persistent process needed - LM Studio is already running
  }

  sendMessage(text, files = []) {
    console.log('[LMStudio] sendMessage:', text.substring(0, 100));

    if (this.session.processing) {
      this.session.ws?.send(JSON.stringify({
        type: 'error',
        message: 'Please wait for the current response to complete'
      }));
      return;
    }

    this.session.processing = true;

    // Build message content with files if present
    let content = text;
    if (files && files.length > 0) {
      for (const f of files) {
        if (f.type !== 'image') {
          content = `<file name="${f.name}">\n${f.content}\n</file>\n\n${content}`;
        }
      }
    }

    // Add message to history
    this.conversationHistory.push({
      role: 'user',
      content: content
    });

    // Build request payload
    const payload = JSON.stringify({
      model: this.session.model,
      messages: this.conversationHistory,
      stream: true,
      temperature: 0.7
    });

    const options = {
      hostname: this.hostname,
      port: this.port,
      path: `${this.basePath}/chat/completions`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    console.log('[LMStudio] POST', `${this.hostname}:${this.port}${options.path}`);
    console.log('[LMStudio] Model:', this.session.model);
    console.log('[LMStudio] Messages:', this.conversationHistory.length);

    const req = http.request(options, (res) => {
      let buffer = '';
      let assistantMessage = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim() === '' || line.trim() === 'data: [DONE]') {
            continue;
          }

          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));

              if (data.choices && data.choices[0]) {
                const delta = data.choices[0].delta;

                if (delta.content) {
                  assistantMessage += delta.content;

                  // Send content delta event
                  this.sendEvent({
                    type: 'assistant',
                    delta: {
                      type: 'text_delta',
                      text: delta.content
                    }
                  });
                }

                // Check for finish
                if (data.choices[0].finish_reason) {
                  // Add assistant response to history
                  this.conversationHistory.push({
                    role: 'assistant',
                    content: assistantMessage
                  });

                  // Update stats if available
                  if (data.usage) {
                    this.session.stats.inputTokens += data.usage.prompt_tokens || 0;
                    this.session.stats.outputTokens += data.usage.completion_tokens || 0;

                    const totalTokens = this.session.stats.inputTokens + this.session.stats.outputTokens;
                    const modelConfig = this.models.find(m => m.id === this.session.model);
                    const contextWindow = modelConfig?.contextWindow || 32768;
                    this.session.stats.contextWindow = contextWindow;
                    const contextPercent = Math.round((totalTokens / contextWindow) * 100);

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

                  // Send completion event
                  this.session.processing = false;
                  this.sendEvent({
                    type: 'result'
                  });

                  if (this.session.ws && this.session.ws.readyState === 1) {
                    this.session.ws.send(JSON.stringify({
                      type: 'message_complete',
                      sessionId: this.session.sessionId
                    }));
                  }
                }
              }
            } catch (e) {
              console.error('[LMStudio] Parse error:', e.message);
            }
          }
        }
      });

      res.on('end', () => {
        if (!this.session.processing) {
          return; // Already handled
        }

        this.session.processing = false;
        if (this.session.ws && this.session.ws.readyState === 1) {
          this.session.ws.send(JSON.stringify({
            type: 'message_complete',
            sessionId: this.session.sessionId
          }));
        }
      });
    });

    req.on('error', (err) => {
      console.error('[LMStudio] Request error:', err.message);
      this.session.processing = false;
      if (this.session.ws && this.session.ws.readyState === 1) {
        this.session.ws.send(JSON.stringify({
          type: 'error',
          sessionId: this.session.sessionId,
          message: `LM Studio connection error: ${err.message}`
        }));
      }
    });

    req.write(payload);
    req.end();
  }

  handleEvent(event) {
    console.log('[LMStudio] handleEvent:', event.type || event);
    // Events are handled directly in sendMessage for HTTP streaming
  }

  kill() {
    // No process to kill - just clear history
    this.conversationHistory = [];
  }

  getMetadata() {
    return `LM Studio ${this.session.model} • ${this.session.directory}`;
  }

  static getModels() {
    const configPath = path.join(__dirname, '..', 'data', 'lmstudio-config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return (config.models || []).map(m => ({
        value: m.id,
        label: m.label,
        group: 'LM Studio'
      }));
    } catch (err) {
      console.error('[LMStudio] Failed to load models from config:', err.message);
      return [];
    }
  }
}

module.exports = LMStudioProvider;
