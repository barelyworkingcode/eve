const WebSocket = require('ws');

/**
 * RelayClient - one instance per browser WS connection.
 * Manages a WebSocket connection to relayLLM and forwards events to the browser.
 */
class RelayClient {
  constructor(relayWsUrl, browserWs) {
    this.relayWsUrl = relayWsUrl;
    this.browserWs = browserWs;
    this.ws = null;
    this.alwaysAllow = false;
    this.suppressNextJoin = false;
    this.sessionDirectory = null; // cached for slash command use
    this.currentSessionId = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.relayWsUrl);

      this.ws.on('open', () => {
        console.log('[RelayClient] Connected to relayLLM');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleRelayMessage(msg);
        } catch (err) {
          console.error('[RelayClient] Failed to parse relay message:', err.message);
        }
      });

      this.ws.on('close', () => {
        console.log('[RelayClient] Disconnected from relayLLM');
        this.ws = null;
      });

      this.ws.on('error', (err) => {
        console.error('[RelayClient] WebSocket error:', err.message);
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
    if (msg.type === 'session_joined' && this.suppressNextJoin) {
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

    // Forward everything else to browser
    this._sendToBrowser(msg);
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  _sendToBrowser(msg) {
    if (this.browserWs && this.browserWs.readyState === 1) {
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

  sendMessage(text, files) {
    this._send({ type: 'send_message', text, files });
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

  sendPermissionResponse(permissionId, approved, reason) {
    this._send({ type: 'permission_response', permissionId, approved, reason });
  }

  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

module.exports = RelayClient;
