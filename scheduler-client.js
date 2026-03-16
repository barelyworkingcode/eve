const WebSocket = require('ws');

/**
 * SchedulerClient - receive-only WS connection to relayScheduler.
 * Forwards task lifecycle events (task_started, task_completed, task_error, task_status)
 * to the browser WebSocket. Auto-reconnects on disconnect.
 */
class SchedulerClient {
  constructor(schedulerWsUrl, browserWs) {
    this.schedulerWsUrl = schedulerWsUrl;
    this.browserWs = browserWs;
    this.ws = null;
    this._closing = false;
    this._reconnectTimer = null;
  }

  connect() {
    if (this._closing) return;

    try {
      this.ws = new WebSocket(this.schedulerWsUrl);
    } catch (err) {
      console.error('[SchedulerClient] Failed to create WebSocket:', err.message);
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[SchedulerClient] Connected to relayScheduler');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._sendToBrowser(msg);
      } catch (err) {
        console.error('[SchedulerClient] Failed to parse message:', err.message);
      }
    });

    this.ws.on('close', () => {
      console.log('[SchedulerClient] Disconnected from relayScheduler');
      this.ws = null;
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[SchedulerClient] WebSocket error:', err.message);
    });
  }

  _sendToBrowser(msg) {
    if (this.browserWs && this.browserWs.readyState === 1) {
      this.browserWs.send(JSON.stringify(msg));
    }
  }

  _scheduleReconnect() {
    if (this._closing) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  close() {
    this._closing = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = SchedulerClient;
