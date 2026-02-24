/**
 * WebSocket connection management: connect, authenticate, reconnect.
 */
class WsClient {
  constructor(app) {
    this.app = app;
    this.ws = null;
  }

  connect() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${protocol}//${window.location.host}`);

    this.ws.onopen = () => {
      console.log('Connected to server');
      if (this.app.elements?.connectionStatus) {
        this.app.elements.connectionStatus.classList.add('hidden');
      }
      const token = localStorage.getItem('eve_session');
      this.ws.send(JSON.stringify({ type: 'auth', token: token || null }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'auth_success') {
        this.app.onWebSocketReady();
        return;
      }
      if (data.type === 'auth_failed') {
        console.error('WebSocket auth failed:', data.message);
        localStorage.removeItem('eve_session');
        window.location.reload();
        return;
      }

      this.app.handleServerMessage(data);
    };

    this.ws.onclose = () => {
      console.log('Disconnected from server');
      if (this.app.elements?.connectionStatus) {
        this.app.elements.connectionStatus.classList.remove('hidden');
      }
      setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  send(data) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    }
  }
}
