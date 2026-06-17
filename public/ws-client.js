/**
 * WebSocket connection management: connect, authenticate, reconnect.
 */
class WsClient {
  /**
   * @param {Container} container - DI container
   * @param {Object} callbacks - { onReady, onMessage }
   */
  constructor(container, callbacks) {
    this.log = container.get('logger').child('WS');
    this.bus = container.get('bus');
    this._connectionStatusEl = null;
    this._onReady = callbacks.onReady;
    this._onMessage = callbacks.onMessage;
    this._onAudio = callbacks.onAudio;
    this.ws = null;
    this.reconnectDelay = 2000;

    // --- Graceful reconnect (Issue 1): heartbeat + network-change handling ---
    // Timings: ping every 15s; if no inbound frame for 30s the link is a zombie
    // (a network switch left a half-open socket) and we force a reconnect; a
    // connectivity-probe waits 4s for a reply before giving up.
    this._heartbeatIntervalMs = 15000;
    this._staleAfterMs = 30000;
    this._probeTimeoutMs = 4000;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._lastInbound = 0;
    this._reconnecting = false;
    this._listenersWired = false;
    this._wireConnectivityListeners();
  }

  /** Set the connection status DOM element (called after initElements). */
  setConnectionStatusEl(el) {
    this._connectionStatusEl = el;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}`);
    // TTS audio arrives as binary frames; receive them as ArrayBuffer so they
    // can be decoded directly without a Blob round-trip.
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.log.info('Connected to server');
      this.reconnectDelay = 2000;
      this._lastInbound = Date.now();
      // A fresh socket is open — cancel any backoff reconnect still pending.
      if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
      if (this._connectionStatusEl) {
        this._connectionStatusEl.classList.add('hidden');
      }
      const token = localStorage.getItem('eve_session');
      this.ws.send(JSON.stringify({ type: 'auth', token: token || null }));
      this._startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      this._lastInbound = Date.now();
      // Binary frames are TTS audio chunks (the only binary the server sends).
      if (event.data instanceof ArrayBuffer) {
        this._onAudio?.(event.data);
        return;
      }

      const data = JSON.parse(event.data);
      // Heartbeat reply — liveness already recorded above; nothing to dispatch.
      if (data.type === 'pong') return;

      // The server coalesces high-frequency frames (token deltas, terminal
      // output, stats) into one __batch frame on a short timer. Unwrap and
      // dispatch each in order. See RelayClient._flushBatch.
      if (data.type === '__batch') {
        for (const m of data.msgs) this._dispatchOne(m);
        return;
      }
      this._dispatchOne(data);
    };

    this.ws.onclose = () => {
      this.log.info(`Disconnected from server, reconnecting in ${this.reconnectDelay / 1000}s`);
      this._stopHeartbeat();
      if (this._connectionStatusEl) {
        this._connectionStatusEl.classList.remove('hidden');
      }
      if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };

    this.ws.onerror = (err) => {
      this.log.error('Error:', err);
    };
  }

  /** Ping on an interval; if the link has gone silent past the stale window,
   *  force a reconnect. The server replies {type:'pong'} (see ws-handler.js),
   *  which refreshes _lastInbound via onmessage. */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this._lastInbound > this._staleAfterMs) {
        this.log.warn('Heartbeat: link stale, forcing reconnect');
        this.forceReconnect();
        return;
      }
      try { this.ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* ignore */ }
    }, this._heartbeatIntervalMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }

  /** Tear down the current socket and reconnect immediately, resetting backoff.
   *  Detaches the old socket's handlers first so its onclose can't also schedule
   *  a competing reconnect. Guarded against overlapping triggers. */
  forceReconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    const old = this.ws;
    this.ws = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      try { old.close(); } catch (e) { /* ignore */ }
    }
    this.reconnectDelay = 2000;
    this.connect();
    this._reconnecting = false;
  }

  /** Connectivity signal (network change / app resume / online). If not open,
   *  reconnect now. If apparently open, it may be a zombie from the previous
   *  network — probe it and only reconnect if no reply arrives. This avoids
   *  needlessly dropping a healthy connection. */
  checkConnection() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.forceReconnect();
      return;
    }
    const probeAt = Date.now();
    try { this.ws.send(JSON.stringify({ type: 'ping' })); }
    catch (e) { this.forceReconnect(); return; }
    setTimeout(() => {
      if (this._lastInbound < probeAt) {
        this.log.warn('Connectivity probe got no response, reconnecting');
        this.forceReconnect();
      }
    }, this._probeTimeoutMs);
  }

  /** Wire browser + native connectivity signals once. WKWebView's online/offline
   *  events are unreliable, so the native shell (relayClient) also dispatches a
   *  'eve:networkchange' window event from an NWPathMonitor; all of them route to
   *  checkConnection(). Guarded for non-browser contexts. */
  _wireConnectivityListeners() {
    if (this._listenersWired || typeof window === 'undefined') return;
    this._listenersWired = true;
    const onUp = () => this.checkConnection();
    window.addEventListener('online', onUp);
    window.addEventListener('eve:networkchange', onUp);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.checkConnection();
    });
    window.addEventListener('offline', () => {
      if (this._connectionStatusEl) this._connectionStatusEl.classList.remove('hidden');
    });
  }

  /** Route a single decoded frame: auth frames are handled here, everything
   *  else goes to the message handler. Shared by top-level and batched frames. */
  _dispatchOne(data) {
    if (data.type === 'auth_success') {
      this._onReady();
      return;
    }
    if (data.type === 'auth_failed') {
      this.log.error('Auth failed:', data.message);
      localStorage.removeItem('eve_session');
      window.location.reload();
      return;
    }
    this._onMessage(data);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (data.type === 'user_input') {
        const flags = [data.dictated && 'dictated', data.files?.length && `${data.files.length} files`].filter(Boolean).join(', ');
        this.log.debug(`→ LLM${flags ? ` (${flags})` : ''}:`, data.text);
      }
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }
}
