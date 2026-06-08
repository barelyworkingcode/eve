const WebSocket = require('ws');
const {
  TTS_MIN_FIRST_CHUNK,
  TTS_MIN_CHUNK,
  extractNextSentence,
  cleanChunkText,
} = require('./tts-chunker');

const DEFAULT_TTS_VOICE = 'af_heart';

/**
 * RelayClient - one instance per browser WS connection.
 * Manages two upstream WebSockets and forwards their events to the browser:
 *   - relayLLM's /ws (sessions, terminals, permissions) — the primary stream.
 *   - relayScheduler's /ws/tasks (task lifecycle events) — auxiliary.
 * The browser opens exactly one socket to eve, so eve is the only place these
 * two upstreams can be merged onto a single browser stream.
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
    this.schedulerWs = null;         // second upstream: relayScheduler task events (/ws/tasks)
    this._closed = false;            // set in close() to stop scheduler reconnect attempts
    this._schedulerReconnectDelay = 2000;
    this.suppressNextJoin = false;
    this.sessionDirectory = null; // cached for slash command use
    this.currentSessionId = null;

    // Hidden module-invocation sessions intercepted before normal dispatch.
    // sessionId -> handler(msg). Module sessions must never reach the browser
    // as regular llm_event/message_complete — the dispatcher would treat them
    // as background events for an unknown session and start a buffer.
    this.moduleSessions = new Map();

    // Outbound frame coalescing: high-frequency browser-bound frames (token
    // deltas, terminal output, stats) are buffered and flushed together as one
    // `__batch` frame on a short timer. Cuts frame count (radio wakeups on
    // mobile); latency-sensitive frames bypass via _shouldFlushImmediately.
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

      // Auxiliary upstream: relayScheduler's task lifecycle events. Independent
      // of the relayLLM connection above — it never blocks (or rejects) this
      // connect() promise, since task events are nice-to-have live updates, not
      // core session traffic.
      this._connectScheduler();
    });
  }

  /**
   * Connect the second upstream WebSocket to relayScheduler's /ws/tasks (via
   * relay's front door) and forward task lifecycle frames
   * (task_started/completed/error/status) to the browser, where
   * message-dispatcher already routes them. relayLLM owns "/ws"; the scheduler
   * serves "/ws/tasks". Best-effort: reconnects with capped backoff while this
   * client is open, self-healing across scheduler restarts. Replaces the old
   * relayLLM SchedulerWSForwarder, relocated here per the service-manifest split.
   */
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

    // Swallow errors at debug level: when the scheduler is down relay 404s the
    // upgrade and we'd otherwise log on every retry. 'close' fires after
    // 'error' and drives the reconnect.
    sws.on('error', (err) => {
      this.log.debug('Scheduler WS error:', err.message);
    });
  }

  /** Reconnect the scheduler upstream with capped backoff, unless closed. */
  _scheduleSchedulerReconnect() {
    if (this._closed) return;
    const delay = this._schedulerReconnectDelay;
    this._schedulerReconnectDelay = Math.min(delay * 2, 30000);
    setTimeout(() => this._connectScheduler(), delay);
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
    // Latency-/order-sensitive frames flush the buffer and go out immediately;
    // everything else batches.
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

  /** Send a single frame to the browser now, bypassing the batch buffer. */
  _rawSend(msg) {
    if (this.browserWs && this.browserWs.readyState === WebSocket.OPEN) {
      this.browserWs.send(JSON.stringify(msg));
    }
  }

  /**
   * Flush buffered frames. A single frame is sent bare (no envelope); multiple
   * are wrapped in a `__batch` frame the client unwraps and dispatches in order.
   */
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

  /**
   * Frames that must not sit in the batch buffer: user-perceptible prompts and
   * order-critical control frames (tts_done must follow all audio; session
   * lifecycle must not lag). Everything else (llm_event, terminal_output,
   * raw_output, stats_update) batches.
   */
  _shouldFlushImmediately(msg) {
    switch (msg.type) {
      case 'permission_request':
      case 'error':
      case 'session_created':
      case 'session_joined':
      case 'tts_done':
      case 'tts_error':
      case 'mode_changed':
        return true;
      default:
        return false;
    }
  }

  /**
   * Send a TTS audio chunk as a binary WS frame. The browser carries no other
   * binary frames, so any binary frame is unambiguously audio — this avoids the
   * ~33% base64 inflation (and the client-side atob) on the browser↔eve hop,
   * which matters most on mobile. Control frames (tts_done/tts_error) stay JSON.
   */
  _sendAudioToBrowser(base64) {
    // Flush any buffered JSON first so the audio frame can't overtake the text
    // stream it belongs with (voice mode batches text deltas). See _flushBatch.
    this._flushBatch();
    if (this.browserWs && this.browserWs.readyState === WebSocket.OPEN) {
      // Audio is opaque/already-compact — skip deflate (net-negative CPU).
      this.browserWs.send(Buffer.from(base64, 'base64'), { compress: false });
    }
  }

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
    while ((result = extractNextSentence(this.ttsTextAccumulator)) && result.sentence) {
      const minLen = this._ttsFirstChunk ? TTS_MIN_FIRST_CHUNK : TTS_MIN_CHUNK;
      if (result.sentence.length < minLen) break;
      this.ttsTextAccumulator = result.remainder;
      this._sendTTSChunk(result.sentence);
      this._ttsFirstChunk = false;
    }
  }

  /**
   * Clean text and chain it onto the TTS synthesis pipeline.
   * Chunks are synthesized and sent to browser in order.
   * Captures the current generation so stale chunks from a cancelled
   * response are discarded even if synthesis completes.
   */
  _sendTTSChunk(text) {
    const cleaned = cleanChunkText(text);
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
      const result = await this.ttsService.synthesize(text, this.voicePreset, this.voiceSpeed);
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
