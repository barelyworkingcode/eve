const WebSocket = require('ws');
const RelayClient = require('../../relay-client');

// Minimal fake socket: records JSON frames + binary frames, controllable readyState.
function makeSocket(readyState = WebSocket.OPEN) {
  return {
    readyState,
    sent: [],    // parsed JSON frames
    binary: [],  // Buffer frames (audio)
    send: jest.fn(function (data) {
      if (Buffer.isBuffer(data)) this.binary.push(data);
      else this.sent.push(JSON.parse(data));
    }),
    close: jest.fn(),
  };
}

describe('RelayClient', () => {
  let browserWs;
  let transport;
  let client;

  beforeEach(() => {
    browserWs = makeSocket();
    // connect() is not exercised here (it opens upstream sockets + scheduler
    // reconnect timers); we test the message-routing core directly with the
    // upstream socket faked as already-open.
    transport = { createWebSocket: jest.fn(() => makeSocket()) };
    client = new RelayClient(transport, browserWs, null, null);
    client.ws = makeSocket();
  });

  afterEach(() => {
    client.close();
  });

  describe('module-session interception (load-bearing: keeps hidden sessions out of chat)', () => {
    it('routes a registered session to its handler and does NOT forward to the browser', () => {
      const handler = jest.fn();
      client.registerModuleSession('mod-1', handler);

      client._handleRelayMessage({ sessionId: 'mod-1', type: 'llm_event', event: { type: 'assistant' } });
      client._flushBatch();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'mod-1' }));
      expect(browserWs.send).not.toHaveBeenCalled();
    });

    it('forwards messages to the browser once the session is unregistered', () => {
      const handler = jest.fn();
      client.registerModuleSession('mod-1', handler);
      client.unregisterModuleSession('mod-1');

      // 'error' is an immediate-flush type, so it reaches the browser synchronously.
      client._handleRelayMessage({ sessionId: 'mod-1', type: 'error', message: 'x' });

      expect(handler).not.toHaveBeenCalled();
      expect(browserWs.sent).toContainEqual({ sessionId: 'mod-1', type: 'error', message: 'x' });
    });

    it('ignores registration with a falsy id or a non-function handler', () => {
      client.registerModuleSession('', jest.fn());
      client.registerModuleSession('has-id', null);
      expect(client.moduleSessions.size).toBe(0);
    });

    it('catches a throwing module-session handler and still suppresses the frame', () => {
      client.registerModuleSession('mod-1', () => { throw new Error('boom'); });
      expect(() => client._handleRelayMessage({ sessionId: 'mod-1', type: 'llm_event' })).not.toThrow();
      client._flushBatch();
      expect(browserWs.send).not.toHaveBeenCalled();
    });
  });

  describe('session_joined suppression', () => {
    it('suppresses the join that matches suppressNextJoin, clears the flag, and caches the directory', () => {
      client.setSuppressNextJoin('s2');
      client._handleRelayMessage({ type: 'session_joined', sessionId: 's2', directory: '/proj' });
      client._flushBatch();

      expect(browserWs.send).not.toHaveBeenCalled();
      expect(client.suppressNextJoin).toBe(false);
      expect(client.sessionDirectory).toBe('/proj');
    });

    it('forwards a non-suppressed session_joined and caches directory + currentSessionId', () => {
      client._handleRelayMessage({ type: 'session_joined', sessionId: 's3', directory: '/p3' });

      expect(client.sessionDirectory).toBe('/p3');
      expect(client.currentSessionId).toBe('s3');
      expect(browserWs.sent).toContainEqual({ type: 'session_joined', sessionId: 's3', directory: '/p3' });
    });
  });

  describe('browser-bound frame batching', () => {
    it('coalesces multiple buffered frames into a single __batch frame on the timer', () => {
      jest.useFakeTimers();
      client.sendToBrowser({ type: 'llm_event', n: 1 });
      client.sendToBrowser({ type: 'stats_update', n: 2 });
      expect(browserWs.send).not.toHaveBeenCalled(); // still buffered

      jest.advanceTimersByTime(client.BATCH_MS);

      expect(browserWs.send).toHaveBeenCalledTimes(1);
      expect(browserWs.sent[0]).toEqual({ type: '__batch', msgs: [{ type: 'llm_event', n: 1 }, { type: 'stats_update', n: 2 }] });
    });

    it('sends a single buffered frame bare, with no __batch envelope', () => {
      jest.useFakeTimers();
      client.sendToBrowser({ type: 'llm_event', n: 1 });
      jest.advanceTimersByTime(client.BATCH_MS);
      expect(browserWs.sent[0]).toEqual({ type: 'llm_event', n: 1 });
    });

    it('flushes the buffer before an immediate-priority frame so ordering is preserved', () => {
      jest.useFakeTimers();
      client.sendToBrowser({ type: 'llm_event', n: 1 });        // buffered
      client.sendToBrowser({ type: 'permission_request', id: 'p' }); // immediate → flush then send

      expect(browserWs.sent[0]).toEqual({ type: 'llm_event', n: 1 });
      expect(browserWs.sent[1]).toEqual({ type: 'permission_request', id: 'p' });
    });
  });

  describe('upstream send + dispatch', () => {
    it('send() writes only when the upstream socket is OPEN', () => {
      client.ws = makeSocket(WebSocket.CONNECTING);
      client.send({ type: 'ping' });
      expect(client.ws.send).not.toHaveBeenCalled();

      client.ws = makeSocket(WebSocket.OPEN);
      client.send({ type: 'ping' });
      expect(client.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
    });

    it('joinSession emits a join_session frame and sets currentSessionId', () => {
      client.joinSession('sx');
      expect(client.currentSessionId).toBe('sx');
      expect(client.ws.sent).toContainEqual({ type: 'join_session', sessionId: 'sx' });
    });

    it('sendMessage emits a send_message frame with text, files and sessionId', () => {
      client.sendMessage('hi', [{ name: 'a.txt' }], 'sx');
      expect(client.ws.sent).toContainEqual({ type: 'send_message', text: 'hi', files: [{ name: 'a.txt' }], sessionId: 'sx' });
    });

    it('sendPermissionResponse emits the relay frame verbatim', () => {
      client.sendPermissionResponse('perm-1', true, 'ok');
      expect(client.ws.sent).toContainEqual({ type: 'permission_response', permissionId: 'perm-1', approved: true, reason: 'ok' });
    });
  });

  describe('close()', () => {
    it('closes the upstream socket, clears module sessions, and marks closed', () => {
      const upstream = client.ws;
      client.registerModuleSession('s', jest.fn());

      client.close();

      expect(upstream.close).toHaveBeenCalled();
      expect(client.ws).toBeNull();
      expect(client.moduleSessions.size).toBe(0);
      expect(client._closed).toBe(true);
    });
  });
});
