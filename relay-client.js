const WebSocket = require('ws');
const {
  TTS_MIN_FIRST_CHUNK,
  TTS_MIN_CHUNK,
  extractNextSentence,
  cleanChunkText,
} = require('./tts-chunker');
const { Director } = require('./tts-director');

const DEFAULT_TTS_VOICE = 'af_heart';

const { NullLogger } = require('./logger');

class RelayClient {
  constructor(relayTransport, browserWs, ttsService, log) {
    this.log = log || new NullLogger();
    this.relayTransport = relayTransport;
    this.browserWs = browserWs;
    this.ws = null;
    this.schedulerWs = null;
    this._closed = false;
    this._schedulerReconnectDelay = 2000;
    this._upstreamReconnectDelay = 2000;
    this._upstreamDown = false;
    this.suppressNextJoin = false;
    this.sessionDirectory = null;
    this.currentSessionId = null;

    this.moduleSessions = new Map();

    // Buffered and flushed as one `__batch` frame on a timer to cut frame
    // count (radio wakeups on mobile); see _shouldFlushImmediately for bypass.
    this._batchBuf = [];
    this._batchTimer = null;
    this.BATCH_MS = 24;

    this.ttsService = ttsService || null;
    this.voiceMode = false;
    this.voicePreset = DEFAULT_TTS_VOICE;
    this.voiceSpeed = 1.0;
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
    this._ttsChain = Promise.resolve();
    this._ttsChunkSeq = 0;
    this._ttsGeneration = 0;
    this._ttsFirstChunk = true;
    // Delivery state persists across a turn; reset per turn in _resetTTSState / on complete.
    this.director = new Director();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this._connectUpstream(resolve, reject);

      // Independent of the relayLLM connection above; never blocks/rejects this
      // connect() promise — task events are nice-to-have, not core session traffic.
      this._connectScheduler();
    });
  }

  // onOpen/onError settle the promise from the original connect() call and are
  // only ever passed on the first invocation; every reconnect calls this with
  // no arguments, so it can never re-resolve or re-reject that promise.
  _connectUpstream(onOpen, onError) {
    if (this._closed) return;

    // Mirrors _connectScheduler's guard: harmless insurance for a reconnect
    // attempt, which runs from a bare setTimeout callback where a synchronous
    // throw would be an uncaught exception, not just a rejected promise.
    let ws;
    try {
      ws = this.relayTransport.createWebSocket('/ws');
    } catch (err) {
      this.log.debug('Upstream WS create failed:', err.message);
      if (onError) onError(err);
      this._scheduleUpstreamReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.log.info('Connected to relayLLM');
      this._upstreamReconnectDelay = 2000;
      if (this._upstreamDown) {
        this._upstreamDown = false;
        this._sendToBrowser({ type: 'relay_status', connected: true });
      }
      if (onOpen) onOpen();
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleRelayMessage(msg);
      } catch (err) {
        this.log.error('Failed to parse relay message:', err.message);
      }
    });

    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      if (this._closed) return;
      this.log.info('Disconnected from relayLLM');
      if (!this._upstreamDown) {
        this._upstreamDown = true;
        this._sendToBrowser({ type: 'relay_status', connected: false });
      }
      this._scheduleUpstreamReconnect();
    });

    ws.on('error', (err) => {
      this.log.error('WebSocket error:', err.message);
      if (onError && ws.readyState === WebSocket.CONNECTING) {
        onError(err);
      }
    });
  }

  // The frontend socket path (RELAY_FRONTEND_SOCKET) is injected once, at
  // spawn, and is only valid for the relay process that spawned Eve. Retrying
  // it recovers relay's own pong-timeout drops and a relayLLM restart behind
  // relay, since the path is unaffected by either. It cannot recover relay
  // itself restarting — that changes the path — but relay respawns Eve with a
  // fresh one when it does, so retrying forever against a now-dead path here
  // is harmless rather than wrong.
  _scheduleUpstreamReconnect() {
    if (this._closed) return;
    const delay = this._upstreamReconnectDelay;
    this._upstreamReconnectDelay = Math.min(delay * 2, 30000);
    setTimeout(() => this._connectUpstream(), delay);
  }

  _connectScheduler() {
    if (this._closed) return;
    let sws;
    try {
      sws = this.relayTransport.createWebSocket('/ws/tasks');
    } catch (err) {
      this.log.debug('Scheduler WS create failed:', err.message);
      this._scheduleSchedulerReconnect();
      return;
    }
    this.schedulerWs = sws;

    sws.on('open', () => {
      this.log.info('Connected to relayScheduler');
      this._schedulerReconnectDelay = 2000;
    });

    sws.on('message', (data) => {
      try {
        this._sendToBrowser(JSON.parse(data.toString()));
      } catch (err) {
        this.log.error('Failed to parse scheduler message:', err.message);
      }
    });

    sws.on('close', () => {
      if (this.schedulerWs === sws) this.schedulerWs = null;
      this._scheduleSchedulerReconnect();
    });

    // Debug-level only: scheduler-down 404s the upgrade on every retry;
    // 'close' (which drives the reconnect) fires after 'error'.
    sws.on('error', (err) => {
      this.log.debug('Scheduler WS error:', err.message);
    });
  }

  _scheduleSchedulerReconnect() {
    if (this._closed) return;
    const delay = this._schedulerReconnectDelay;
    this._schedulerReconnectDelay = Math.min(delay * 2, 30000);
    setTimeout(() => this._connectScheduler(), delay);
  }

  _handleRelayMessage(msg) {
    // Module-invocation sessions are intercepted first: forwarding them as
    // llm_event/message_complete would let the browser dispatcher buffer them
    // as an unknown background session. Handler (from ModuleInvoker) wraps
    // into module_ai_event instead.
    const sid = msg.sessionId;
    if (sid && this.moduleSessions.has(sid)) {
      try {
        this.moduleSessions.get(sid)(msg);
      } catch (err) {
        this.log.error('Module session handler threw:', err.message);
      }
      return;
    }

    // HTTP-created sessions already got session_created directly from Eve;
    // suppress the WS session_joined echo to avoid a duplicate. Flag set by
    // ws-handler.js handleCreateSession().
    if (msg.type === 'session_joined' && this.suppressNextJoin === msg.sessionId) {
      this.suppressNextJoin = false;
      if (msg.directory) {
        this.sessionDirectory = msg.directory;
      }
      return;
    }

    if (msg.type === 'session_joined' && msg.directory) {
      this.sessionDirectory = msg.directory;
      this.currentSessionId = msg.sessionId;
    }

    if (this.voiceMode && this.ttsService) {
      this._handleTTSAccumulation(msg);
    } else if (msg.type === 'message_complete' && this.ttsService) {
      this.log.debug(`TTS skipped message_complete: voiceMode=${this.voiceMode}`);
    }

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
    if (this._shouldFlushImmediately(msg)) {
      this._flushBatch();
      this._rawSend(msg);
      return;
    }
    this._batchBuf.push(msg);
    if (!this._batchTimer) {
      this._batchTimer = setTimeout(() => this._flushBatch(), this.BATCH_MS);
    }
  }
  _sendToBrowser(msg) { this.sendToBrowser(msg); }

  _rawSend(msg) {
    if (this.browserWs && this.browserWs.readyState === WebSocket.OPEN) {
      this.browserWs.send(JSON.stringify(msg));
    }
  }

  // Client-side message-dispatcher unwraps __batch frames and dispatches in order.
  _flushBatch() {
    if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; }
    if (this._batchBuf.length === 0) return;
    const buf = this._batchBuf;
    this._batchBuf = [];
    if (buf.length === 1) {
      this._rawSend(buf[0]);
    } else {
      this._rawSend({ type: '__batch', msgs: buf });
    }
  }

  // Bypass batching only for order-critical frames: tts_done must follow all
  // queued audio, session lifecycle must not lag.
  _shouldFlushImmediately(msg) {
    switch (msg.type) {
      case 'permission_request':
      case 'error':
      case 'session_created':
      case 'session_joined':
      case 'tts_done':
      case 'tts_error':
      case 'mode_changed':
      case 'relay_status':
        return true;
      default:
        return false;
    }
  }

  // Binary frame => audio; it's the only binary frame type in this protocol,
  // which avoids the ~33% base64 inflation (and client-side atob) on this hop.
  _sendAudioToBrowser(base64) {
    // Flush buffered JSON first so audio can't overtake the text stream it belongs with.
    this._flushBatch();
    if (this.browserWs && this.browserWs.readyState === WebSocket.OPEN) {
      // Audio is opaque/already-compact — skip deflate (net-negative CPU).
      this.browserWs.send(Buffer.from(base64, 'base64'), { compress: false });
    }
  }

  setSuppressNextJoin(value) {
    this.suppressNextJoin = value;
  }

  // Last writer wins for a given sessionId; caller (ModuleInvoker) must
  // unregister on terminal events.
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

  setSessionFolder(sessionId, folder) {
    this._send({ type: 'set_session_folder', sessionId, folder });
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

  setVoiceMode(enabled, voice, speed) {
    this.voiceMode = enabled;
    if (voice) this.voicePreset = voice;
    if (speed) this.voiceSpeed = speed;
    this._resetTTSState();
  }

  _resetTTSState() {
    this.ttsTextAccumulator = '';
    this.ttsPending = 0;
    this._ttsChain = Promise.resolve();
    this._ttsChunkSeq = 0;
    this._ttsGeneration++;
    this._ttsFirstChunk = true;
    this.director.reset();
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

      // Must be inside the chain — _sendTTSChunk is async so chunks may not
      // have been sent yet at this point.
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
      this.director.reset();
    }
  }

  _flushCompleteSentences() {
    let result;
    while ((result = extractNextSentence(this.ttsTextAccumulator)) && result.sentence) {
      const minLen = this._ttsFirstChunk ? TTS_MIN_FIRST_CHUNK : TTS_MIN_CHUNK;
      if (result.sentence.length < minLen) break;
      this.ttsTextAccumulator = result.remainder;
      this._sendTTSChunk(result.sentence);
      this._ttsFirstChunk = false;
    }
  }

  // Captures the current generation so stale spans from a cancelled response
  // are dropped even if synthesis completes.
  _sendTTSChunk(rawText) {
    for (const span of this.director.plan(rawText)) {
      const cleaned = cleanChunkText(span.text);
      if (!cleaned) continue;

      const seq = this._ttsChunkSeq++;
      const gen = this._ttsGeneration;
      this._ttsChain = this._ttsChain.then(() => {
        if (gen !== this._ttsGeneration) return;
        return this._synthesizeAndSend(cleaned, seq, gen, span);
      }).catch(err => {
        this.log.error(`TTS chain error at chunk ${seq}:`, err.message);
      });
    }
  }

  async _synthesizeAndSend(text, seq, gen, span) {
    this.log.debug(`TTS chunk ${seq} (${text.length} chars)`);
    this.ttsPending++;
    try {
      // Delivery tempo layers on the user's base speed; instruct/gain carry the
      // emotion (null instruct => daemon uses the voice's configured default).
      const speed = this.voiceSpeed * span.speed;
      const result = await this.ttsService.synthesize(
        text, this.voicePreset, speed, span.instruct, span.gain);
      if (gen !== this._ttsGeneration) {
        this.log.debug(`TTS chunk ${seq} discarded (cancelled while synthesizing)`);
        return;
      }
      this._sendAudioToBrowser(result.audio_base64);
    } catch (err) {
      this.log.error(`TTS chunk ${seq} failed:`, err.message);
    } finally {
      this.ttsPending--;
    }
  }

  close() {
    this._closed = true;
    this._flushBatch();
    if (this._batchTimer) { clearTimeout(this._batchTimer); this._batchTimer = null; }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.schedulerWs) {
      this.schedulerWs.close();
      this.schedulerWs = null;
    }
    this.moduleSessions.clear();
  }
}

module.exports = RelayClient;
