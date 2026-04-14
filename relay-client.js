const WebSocket = require('ws');

const DEFAULT_TTS_VOICE = 'af_heart';

/**
 * RelayClient - one instance per browser WS connection.
 * Manages a WebSocket connection to relayLLM and forwards events to the browser.
 */
const { NullLogger } = require('./logger');

class RelayClient {
  /**
   * @param {RelayTransport} relayTransport — singleton owning transport + auth
   * @param {WebSocket} browserWs — the per-connection browser socket
   * @param {TTSService} ttsService
   * @param {Logger} log
   */
  constructor(relayTransport, browserWs, ttsService, log) {
    this.log = log || new NullLogger();
    this.relayTransport = relayTransport;
    this.browserWs = browserWs;
    this.ws = null;
    this.alwaysAllow = false;
    this.suppressNextJoin = false;
    this.sessionDirectory = null; // cached for slash command use
    this.currentSessionId = null;

    this.ttsService = ttsService || null;
    this.voiceMode = false;
    this.voicePreset = DEFAULT_TTS_VOICE;
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = this.relayTransport.createWebSocket('/ws');

      this.ws.on('open', () => {
        this.log.info('Connected to relayLLM');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleRelayMessage(msg);
        } catch (err) {
          this.log.error('Failed to parse relay message:', err.message);
        }
      });

      this.ws.on('close', () => {
        this.log.info('Disconnected from relayLLM');
        this.ws = null;
      });

      this.ws.on('error', (err) => {
        this.log.error('WebSocket error:', err.message);
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  _handleRelayMessage(msg) {
    // Auto-respond to permission requests when alwaysAllow is set
    if (msg.type === 'permission_request' && this.alwaysAllow) {
      this._send({
        type: 'permission_response',
        permissionId: msg.permissionId,
        approved: true,
        reason: 'auto-allowed'
      });
      return;
    }

    // When Eve creates a session via HTTP POST, it sends session_created to the
    // browser directly, then joins via relay WS. The relay responds with
    // session_joined which would duplicate the notification, so we suppress it.
    // The flag is set by ws-handler.js handleCreateSession().
    if (msg.type === 'session_joined' && this.suppressNextJoin === msg.sessionId) {
      this.suppressNextJoin = false;
      if (msg.directory) {
        this.sessionDirectory = msg.directory;
      }
      return;
    }

    // Cache directory from session_joined for slash commands
    if (msg.type === 'session_joined' && msg.directory) {
      this.sessionDirectory = msg.directory;
      this.currentSessionId = msg.sessionId;
    }

    if (this.voiceMode && this.ttsService) {
      this._handleTTSAccumulation(msg);
    }

    // Forward everything else to browser
    this._sendToBrowser(msg);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _send(msg) {
    this.send(msg);
  }

  _sendToBrowser(msg) {
    if (this.browserWs && this.browserWs.readyState === WebSocket.OPEN) {
      this.browserWs.send(JSON.stringify(msg));
    }
  }

  setAlwaysAllow(value) {
    this.alwaysAllow = value;
  }

  setSuppressNextJoin(value) {
    this.suppressNextJoin = value;
  }

  joinSession(sessionId) {
    this.currentSessionId = sessionId;
    this._send({ type: 'join_session', sessionId });
  }

  sendMessage(text, files, sessionId) {
    this.log.debug(`→ relay (${text.length} chars, ${files.length} files)`);
    this._send({ type: 'send_message', text, files, sessionId });
  }

  leaveSession(sessionId) {
    this._send({ type: 'leave_session', sessionId });
    // Reset voice mode so TTS doesn't carry over to the next session
    this.voiceMode = false;
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
  }

  endSession(sessionId) {
    this._send({ type: 'end_session', sessionId });
  }

  deleteSession(sessionId) {
    this._send({ type: 'delete_session', sessionId });
  }

  renameSession(sessionId, name) {
    this._send({ type: 'rename_session', sessionId, name });
  }

  clearSession(sessionId) {
    this._send({ type: 'clear_session', sessionId });
  }

  stopGeneration(sessionId) {
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
    this._send({ type: 'stop_generation', sessionId });
  }

  sendPermissionResponse(permissionId, approved, reason) {
    this._send({ type: 'permission_response', permissionId, approved, reason });
  }

  setVoiceMode(enabled, voice) {
    this.voiceMode = enabled;
    if (voice) this.voicePreset = voice;
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
  }

  _handleTTSAccumulation(msg) {
    if (msg.type === 'llm_event' && msg.event?.type === 'assistant') {
      const event = msg.event;

      if (event.delta?.type === 'text_delta' && event.delta.text) {
        this.ttsTextAccumulator += event.delta.text;
      }

      // Full message content (some providers send complete blocks instead of deltas)
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text' && block.text) {
            this.ttsTextAccumulator += block.text;
          }
        }
      }

      if (event.content_block?.type === 'text' && event.content_block.text) {
        this.ttsTextAccumulator += event.content_block.text;
      }
    }

    if (msg.type === 'message_complete') {
      const text = this.ttsTextAccumulator.trim();
      this.ttsTextAccumulator = '';
      if (text) this._sendToTTS(text);
    }
  }

  async _sendToTTS(text) {
    const cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_~`#>]/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    if (!cleaned) return;

    this.log.debug('TTS synthesizing:', cleaned);
    this.ttsPending++;
    try {
      const result = await this.ttsService.synthesize(cleaned, this.voicePreset);
      this._sendToBrowser({
        type: 'tts_audio',
        data: result.audio_base64,
        sessionId: this.currentSessionId,
      });
    } catch (err) {
      this.log.error('TTS error:', err.message);
      this._sendToBrowser({
        type: 'tts_error',
        message: err.message,
        sessionId: this.currentSessionId,
      });
    } finally {
      this.ttsPending--;
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = RelayClient;
