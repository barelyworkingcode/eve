const WebSocket = require('ws');

const DEFAULT_TTS_VOICE = 'af_heart';
const TTS_MIN_FIRST_CHUNK = 20;
const TTS_MIN_CHUNK = 40;
const TTS_ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'jr', 'sr',
  'vs', 'etc', 'approx', 'dept', 'est', 'govt',
  'eg', 'ie', 'al',       // e.g., i.e., et al.
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

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
    this.suppressNextJoin = false;
    this.sessionDirectory = null; // cached for slash command use
    this.currentSessionId = null;

    // Hidden module-invocation sessions intercepted before normal dispatch.
    // sessionId -> handler(msg). Module sessions must never reach the browser
    // as regular llm_event/message_complete — the dispatcher would treat them
    // as background events for an unknown session and start a buffer.
    this.moduleSessions = new Map();

    this.ttsService = ttsService || null;
    this.voiceMode = false;
    this.voicePreset = DEFAULT_TTS_VOICE;
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
    this._ttsChain = Promise.resolve();
    this._ttsChunkSeq = 0;
    this._ttsGeneration = 0;
    this._ttsFirstChunk = true;
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
    // Hidden module-invocation sessions are intercepted FIRST. Their events
    // must never reach the browser as `llm_event`/`message_complete` — the
    // dispatcher routes by sessionId and would otherwise buffer them as a
    // background session. The handler (registered by ModuleInvoker) wraps the
    // event into a `module_ai_event` and forwards that instead.
    const sid = msg.sessionId;
    if (sid && this.moduleSessions.has(sid)) {
      try {
        this.moduleSessions.get(sid)(msg);
      } catch (err) {
        this.log.error('Module session handler threw:', err.message);
      }
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
    } else if (msg.type === 'message_complete' && this.ttsService) {
      this.log.debug(`TTS skipped message_complete: voiceMode=${this.voiceMode}`);
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

  sendToBrowser(msg) {
    if (this.browserWs && this.browserWs.readyState === WebSocket.OPEN) {
      this.browserWs.send(JSON.stringify(msg));
    }
  }
  _sendToBrowser(msg) { this.sendToBrowser(msg); }

  setSuppressNextJoin(value) {
    this.suppressNextJoin = value;
  }

  /**
   * Register a handler that will receive ALL relay messages for `sessionId`
   * instead of forwarding them to the browser. Used by ModuleInvoker to
   * accumulate streaming text + tool events from a hidden ephemeral session
   * without leaking them into the user's visible chat history. Last writer
   * wins if called twice for the same id — the invoker is responsible for
   * unregistering on terminal events.
   */
  registerModuleSession(sessionId, handler) {
    if (!sessionId || typeof handler !== 'function') return;
    this.moduleSessions.set(sessionId, handler);
  }

  unregisterModuleSession(sessionId) {
    this.moduleSessions.delete(sessionId);
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
    this._resetTTSState();
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
    this._resetTTSState();
    this._send({ type: 'stop_generation', sessionId });
  }

  sendPermissionResponse(permissionId, approved, reason) {
    this._send({ type: 'permission_response', permissionId, approved, reason });
  }

  setPermissionMode(sessionId, mode) {
    this._send({ type: 'set_permission_mode', sessionId, mode });
  }

  setVoiceMode(enabled, voice) {
    this.voiceMode = enabled;
    if (voice) this.voicePreset = voice;
    this._resetTTSState();
  }

  _resetTTSState() {
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
    this._ttsChain = Promise.resolve();
    this._ttsChunkSeq = 0;
    this._ttsGeneration++;
    this._ttsFirstChunk = true;
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

      this._flushCompleteSentences();
    }

    if (msg.type === 'message_complete') {
      const remainder = this.ttsTextAccumulator.trim();
      this.ttsTextAccumulator = '';
      if (remainder) this._sendTTSChunk(remainder);

      // Signal client after all queued chunks finish synthesizing.
      // Must be inside the chain — _sendTTSChunk is async so chunks
      // may not have been sent yet at this point.
      const gen = this._ttsGeneration;
      this.log.debug(`TTS message_complete: gen=${gen}, chunks=${this._ttsChunkSeq}, remainder=${remainder.length}`);
      this._ttsChain = this._ttsChain.then(() => {
        if (gen !== this._ttsGeneration) return;
        this._sendToBrowser({
          type: 'tts_done',
          sessionId: this.currentSessionId,
        });
      }).catch(err => {
        this.log.error('TTS chain error before tts_done:', err.message);
      });
      this._ttsFirstChunk = true;
    }
  }

  /**
   * Extract complete sentences from the accumulator and send each to TTS.
   * Sentences below the minimum chunk size are kept for merging with the next.
   */
  _flushCompleteSentences() {
    let result;
    while ((result = this._extractNextSentence(this.ttsTextAccumulator)) && result.sentence) {
      const minLen = this._ttsFirstChunk ? TTS_MIN_FIRST_CHUNK : TTS_MIN_CHUNK;
      if (result.sentence.length < minLen) break;
      this.ttsTextAccumulator = result.remainder;
      this._sendTTSChunk(result.sentence);
      this._ttsFirstChunk = false;
    }
  }

  /**
   * Find the first sentence boundary in text.
   * Returns { sentence, remainder } or { sentence: null, remainder: text }.
   * Skips abbreviations (Mr., Dr., e.g.), decimal numbers (3.14),
   * and boundaries inside code blocks or think tags. Operates on raw text —
   * cleaning (strip markdown, code blocks) is deferred to _sendTTSChunk.
   */
  _extractNextSentence(text) {
    // Don't split inside an unclosed code block or think tag
    if (text.includes('```') && (text.match(/```/g) || []).length % 2 !== 0) {
      return { sentence: null, remainder: text };
    }
    if (text.includes('<think>')) {
      const opens = (text.match(/<think>/g) || []).length;
      const closes = (text.match(/<\/think>/g) || []).length;
      if (opens > closes) return { sentence: null, remainder: text };
    }

    const hasBlocks = text.includes('```') || text.includes('<think>');
    const pattern = /([.!?]+)(\s+|$)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const endIdx = match.index + match[0].length;
      const punct = match[1];
      const before = text.slice(0, match.index);

      // Skip boundaries inside code blocks or think tags
      if (hasBlocks) {
        const fenceCount = (before.match(/```/g) || []).length;
        if (fenceCount % 2 !== 0) continue;
        const thinkOpens = (before.match(/<think>/g) || []).length;
        const thinkCloses = (before.match(/<\/think>/g) || []).length;
        if (thinkOpens > thinkCloses) continue;
      }

      // Skip decimal numbers (3.14) and abbreviations (Mr., Dr., e.g.)
      if (punct === '.') {
        const charBefore = match.index > 0 ? text[match.index - 1] : '';
        const charAfter = text[endIdx] || '';
        if (/\d/.test(charBefore) && /\d/.test(charAfter)) continue;
        const wordMatch = before.match(/(\w+)$/);
        if (wordMatch && TTS_ABBREVIATIONS.has(wordMatch[1].toLowerCase())) continue;
      }

      const sentence = text.slice(0, endIdx).trim();
      const remainder = text.slice(endIdx);
      return { sentence, remainder };
    }

    return { sentence: null, remainder: text };
  }

  /**
   * Clean text and chain it onto the TTS synthesis pipeline.
   * Chunks are synthesized and sent to browser in order.
   * Captures the current generation so stale chunks from a cancelled
   * response are discarded even if synthesis completes.
   */
  _sendTTSChunk(text) {
    const cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_~`#>]/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    if (!cleaned) return;

    const seq = this._ttsChunkSeq++;
    const gen = this._ttsGeneration;
    this._ttsChain = this._ttsChain.then(() => {
      if (gen !== this._ttsGeneration) return;
      return this._synthesizeAndSend(cleaned, seq);
    }).catch(err => {
      this.log.error(`TTS chain error at chunk ${seq}:`, err.message);
    });
  }

  async _synthesizeAndSend(text, seq) {
    this.log.debug(`TTS chunk ${seq} (${text.length} chars)`);
    this.ttsPending++;
    try {
      const result = await this.ttsService.synthesize(text, this.voicePreset);
      this._sendToBrowser({
        type: 'tts_audio',
        data: result.audio_base64,
        sessionId: this.currentSessionId,
      });
    } catch (err) {
      this.log.error(`TTS chunk ${seq} failed:`, err.message);
    } finally {
      this.ttsPending--;
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.moduleSessions.clear();
  }
}

module.exports = RelayClient;
