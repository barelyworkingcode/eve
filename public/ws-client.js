/**
 * WebSocket connection management: connect, authenticate, reconnect.
 */
class WsClient {
  /**
   * @param {Container} container - DI container
   * @param {Object} callbacks - { onReady, onMessage }
   */
  constructor(container, callbacks) {
    this.bus = container.get('bus');
    this._connectionStatusEl = null;
    this._onReady = callbacks.onReady;
    this._onMessage = callbacks.onMessage;
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

    this.ws.onopen = () => {
      console.log('Connected to server');
      this.reconnectDelay = 2000;
      if (this._connectionStatusEl) {
        this._connectionStatusEl.classList.add('hidden');
      }
      const token = localStorage.getItem('eve_session');
      this.ws.send(JSON.stringify({ type: 'auth', token: token || null }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'auth_success') {
        this._onReady();
        return;
      }
      if (data.type === 'auth_failed') {
        console.error('WebSocket auth failed:', data.message);
        localStorage.removeItem('eve_session');
        window.location.reload();
        return;
      }

      this._onMessage(data);
    };

    this.ws.onclose = () => {
      console.log(`Disconnected from server, reconnecting in ${this.reconnectDelay / 1000}s`);
      if (this._connectionStatusEl) {
        this._connectionStatusEl.classList.remove('hidden');
      }
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }
}
