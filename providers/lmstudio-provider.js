const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const LLMProvider = require('./llm-provider');

let _dataDir = path.join(__dirname, '..', 'data');

class LMStudioProvider extends LLMProvider {
  constructor(session) {
    super(session);
    this.responseId = null;
    this.currentAssistantMessage = null;
    this.currentToolCall = null;
    this.integrations = [];
    this.temperature = 0.7;
    this.contextLength = null;
    this.loadConfig();
    this.restoreSessionState(session.providerState);
  }

  static setDataDir(dir) {
    _dataDir = dir;
  }

  loadConfig() {
    const configPath = path.join(_dataDir, 'lmstudio-config.json');
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      let baseUrl = config.baseUrl || 'http://localhost:1234';
      // Strip trailing /v1 for backward compat with old configs
      baseUrl = baseUrl.replace(/\/v1\/?$/, '');
      this.baseUrl = baseUrl;
      this.token = config.token || null;
      this.integrations = config.integrations || [];
      this.contextLength = config.contextLength || null;
      // Lower temperature improves tool calling reliability
      this.temperature = config.temperature ?? (this.integrations.length > 0 ? 0.1 : 0.7);

      const url = new URL(this.baseUrl);
      this.hostname = url.hostname;
      this.port = url.port || (url.protocol === 'https:' ? 443 : 1234);
      this.basePath = url.pathname.replace(/\/$/, '');
      this.protocol = url.protocol;
    } catch (err) {
      console.error('[LMStudio] Failed to load config:', err.message);
      this.baseUrl = 'http://localhost:1234';
      this.token = null;
      this.integrations = [];
      this.contextLength = null;
      this.hostname = 'localhost';
      this.port = 1234;
      this.basePath = '';
      this.protocol = 'http:';
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

    // Build input with files if present
    let input = text;
    if (files && files.length > 0) {
      for (const f of files) {
        if (f.type !== 'image') {
          input = `<file name="${f.name}">\n${f.content}\n</file>\n\n${input}`;
        }
      }
    }

    this._doRequest(input);
  }

  _doRequest(input, isRetry = false) {
    // Build request payload
    const body = {
      model: this.session.model,
      input,
      stream: true,
      store: true,
      temperature: this.temperature
    };

    if (this.responseId) {
      body.previous_response_id = this.responseId;
    }
    if (this.integrations.length > 0) {
      body.integrations = this.integrations;
    }
    if (this.contextLength) {
      body.context_length = this.contextLength;
    }

    const payload = JSON.stringify(body);

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const options = {
      hostname: this.hostname,
      port: this.port,
      path: `${this.basePath}/api/v1/chat`,
      method: 'POST',
      headers
    };

    const transport = this.protocol === 'https:' ? https : http;

    console.log('[LMStudio] POST', `${this.hostname}:${this.port}${options.path}`);
    console.log('[LMStudio] Model:', this.session.model);
    if (this.responseId) {
      console.log('[LMStudio] Continuing conversation:', this.responseId);
    }

    const req = transport.request(options, (res) => {
      // Handle stale responseId recovery
      if ((res.statusCode === 400 || res.statusCode === 404) && this.responseId && !isRetry) {
        console.warn('[LMStudio] Stale responseId, retrying without it');
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => {
          console.warn('[LMStudio] Error response:', body.substring(0, 200));
          this.responseId = null;
          this._doRequest(input, true);
        });
        return;
      }

      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => {
          console.error('[LMStudio] HTTP error:', res.statusCode, body.substring(0, 200));
          this.session.processing = false;
          if (this.session.ws && this.session.ws.readyState === 1) {
            this.session.ws.send(JSON.stringify({
              type: 'error',
              sessionId: this.session.sessionId,
              message: `LM Studio error (${res.statusCode}): ${body.substring(0, 200)}`
            }));
          }
        });
        return;
      }

      let buffer = '';
      let currentEvent = null;
      let assistantText = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.substring(7).trim();
            continue;
          }

          if (line.startsWith('data: ')) {
            const rawData = line.substring(6);
            if (rawData === '[DONE]') {
              continue;
            }

            try {
              const data = JSON.parse(rawData);
              assistantText = this._handleSSE(currentEvent, data, assistantText);
            } catch (e) {
              console.error('[LMStudio] Parse error:', e.message);
            }
            currentEvent = null;
            continue;
          }
        }
      });

      res.on('end', () => {
        if (!this.session.processing) {
          return; // Already handled via chat.end
        }

        // Fallback: if stream ended without chat.end, finalize
        this._finalizeMessage(assistantText);
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

  _emitToolUse() {
    if (!this.currentToolCall || this.currentToolCall.emitted) return;
    this.currentToolCall.emitted = true;
    this.sendEvent({
      type: 'assistant',
      content_block: {
        type: 'tool_use',
        name: this.currentToolCall.name || 'unknown_tool',
        input: this.currentToolCall.arguments || {}
      }
    });
  }

  _handleSSE(eventType, data, assistantText) {
    switch (eventType) {
      case 'chat.start':
        // Initialize tracking for new response
        this.currentToolCall = null;
        break;

      case 'message.delta': {
        const text = data.content || '';
        if (!text) break;

        assistantText += text;

        if (!this.currentAssistantMessage) {
          this.currentAssistantMessage = {
            timestamp: new Date().toISOString(),
            role: 'assistant',
            content: [{ type: 'text', text: '' }]
          };
        }

        this.currentAssistantMessage.content[0].text += text;

        this.sendEvent({
          type: 'assistant',
          delta: {
            type: 'text_delta',
            text
          }
        });
        break;
      }

      case 'reasoning.start':
        this.sendEvent({
          type: 'assistant',
          delta: { type: 'text_delta', text: '<think>' }
        });
        break;

      case 'reasoning.delta': {
        const text = data.content || '';
        if (text) {
          this.sendEvent({
            type: 'assistant',
            delta: { type: 'text_delta', text }
          });
        }
        break;
      }

      case 'reasoning.end':
        this.sendEvent({
          type: 'assistant',
          delta: { type: 'text_delta', text: '</think>' }
        });
        break;

      case 'tool_call.start': {
        // Buffer tool call info; emit tool_use only once we have name + arguments
        this.currentToolCall = { name: null, emitted: false };
        break;
      }

      case 'tool_call.name': {
        const name = data.tool_name || data.name || data.tool || '';
        if (name && this.currentToolCall) {
          this.currentToolCall.name = name;
          this._emitToolUse();
        }
        break;
      }

      case 'tool_call.arguments': {
        if (this.currentToolCall) {
          this.currentToolCall.arguments = data.arguments || {};
          if (this.currentToolCall.emitted) {
            // Tool block already visible; update input display
            this.sendEvent({
              type: 'assistant',
              content_block: {
                type: 'tool_use_input',
                input: this.currentToolCall.arguments
              }
            });
          } else {
            // Name event was skipped; create block with full info
            this._emitToolUse();
          }
        }
        break;
      }

      case 'tool_call.success': {
        if (this.currentToolCall) {
          if (!this.currentToolCall.emitted) {
            this._emitToolUse();
          }
          this.sendEvent({
            type: 'result',
            subtype: 'tool_result',
            tool: this.currentToolCall.name || 'unknown_tool'
          });
        }
        this.currentToolCall = null;
        break;
      }

      case 'tool_call.failure': {
        if (this.currentToolCall && !this.currentToolCall.emitted) {
          this._emitToolUse();
        }
        const errorMsg = data.reason || data.error || data.message || 'Tool call failed';
        this.sendEvent({
          type: 'result',
          subtype: 'error',
          error: errorMsg
        });
        this.currentToolCall = null;
        break;
      }

      case 'chat.end': {
        const result = data;

        // Store response_id for conversation continuity
        if (result.response_id) {
          this.responseId = result.response_id;
          console.log('[LMStudio] Response ID:', this.responseId);
        }

        // Update stats
        if (result.stats) {
          this.session.stats.inputTokens += result.stats.input_tokens || 0;
          this.session.stats.outputTokens += result.stats.total_output_tokens || 0;

          if (this.session.ws && this.session.ws.readyState === 1) {
            this.session.ws.send(JSON.stringify({
              type: 'stats_update',
              sessionId: this.session.sessionId,
              stats: this.session.stats
            }));
          }
        }

        this._finalizeMessage(assistantText);
        break;
      }

      case 'prompt_processing.start':
      case 'prompt_processing.progress':
      case 'prompt_processing.end':
      case 'message.start':
      case 'message.end':
        // Known events with no client-side action needed
        break;

      default:
        if (eventType) {
          console.log('[LMStudio] Unhandled SSE event:', eventType);
        }
        break;
    }

    return assistantText;
  }

  _finalizeMessage(assistantText) {
    // Save assistant message to session history
    if (this.currentAssistantMessage) {
      this.session.messages.push(this.currentAssistantMessage);
      this.currentAssistantMessage = null;
    }

    // Persist provider state
    this.session.providerState = this.getSessionState();
    if (this.session.saveHistory) {
      this.session.saveHistory();
    }

    // Send completion events
    this.session.processing = false;
    this.sendEvent({ type: 'result' });

    if (this.session.ws && this.session.ws.readyState === 1) {
      this.session.ws.send(JSON.stringify({
        type: 'message_complete',
        sessionId: this.session.sessionId
      }));
    }
  }

  handleEvent(event) {
    console.log('[LMStudio] handleEvent:', event.type || event);
    // Events are handled directly in sendMessage via SSE stream
  }

  kill() {
    this.responseId = null;
    this.currentToolCall = null;
  }

  getMetadata() {
    return `LM Studio ${this.session.model} • ${this.session.directory}`;
  }

  getSessionState() {
    return {
      responseId: this.responseId
    };
  }

  restoreSessionState(state) {
    if (!state) return;
    this.responseId = state.responseId || null;
  }

  static clearSessionState(session) {
    delete session.providerState;
  }

  static getModels() {
    const configPath = path.join(_dataDir, 'lmstudio-config.json');
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

  static getCommands() {
    const models = LMStudioProvider.getModels();
    const modelNames = models.length > 0 ? models.map(m => m.value).join(', ') : '(none configured)';
    return [
      { name: 'model', description: `Switch model (${modelNames})` }
    ];
  }

  handleCommand(command, args, sendSystemMessage, rawText) {
    const models = LMStudioProvider.getModels().map(m => m.value);

    if (command === 'model') {
      if (args.length === 0) {
        const available = models.length > 0 ? models.join(', ') : '(none configured)';
        sendSystemMessage(`Current model: ${this.session.model}\nAvailable: ${available}`);
        return true;
      }

      const newModel = args[0];
      if (models.includes(newModel)) {
        this.session.model = newModel;
        this.responseId = null;
        sendSystemMessage(`Model changed to: ${newModel}`);
      } else {
        const available = models.length > 0 ? models.join(', ') : '(none configured)';
        sendSystemMessage(`Invalid model "${newModel}". Available: ${available}`);
      }
      return true;
    }

    return false;
  }
}

module.exports = LMStudioProvider;
