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
      if (this._connectionStatusEl) {
        this._connectionStatusEl.classList.add('hidden');
      }
      const token = localStorage.getItem('eve_session');
      this.ws.send(JSON.stringify({ type: 'auth', token: token || null }));
    };

    this.ws.onmessage = (event) => {
      // Binary frames are TTS audio chunks (the only binary the server sends).
      if (event.data instanceof ArrayBuffer) {
        this._onAudio?.(event.data);
        return;
      }

      const data = JSON.parse(event.data);

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
      if (this._connectionStatusEl) {
        this._connectionStatusEl.classList.remove('hidden');
      }
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };

    this.ws.onerror = (err) => {
      this.log.error('Error:', err);
    };
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
