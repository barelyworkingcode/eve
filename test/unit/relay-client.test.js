const { EventEmitter } = require('events');
const WebSocket = require('ws');
const RelayClient = require('../../relay-client');

// A minimal stand-in for the real `ws` socket connect() drives: real events
// (open/message/close/error) via EventEmitter, plus the readyState/send/close
// surface relay-client.js reads directly.
function makeFakeUpstream() {
  const ws = new EventEmitter();
  ws.readyState = WebSocket.CONNECTING;
  ws.send = jest.fn();
  ws.close = jest.fn();
  return ws;
}

function openFakeUpstream(ws) {
  ws.readyState = WebSocket.OPEN;
  ws.emit('open');
}

function makeSocket(readyState = WebSocket.OPEN) {
  return {
    readyState,
    sent: [],
    binary: [],
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
    // connect() opens upstream sockets + scheduler reconnect timers, so it's not
    // exercised here; the message-routing core is tested directly against an
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
      expect(browserWs.send).not.toHaveBeenCalled();

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
      client.sendToBrowser({ type: 'llm_event', n: 1 });
      client.sendToBrowser({ type: 'permission_request', id: 'p' });

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

  describe('connect() self-heals the upstream leg (mirrors _connectScheduler)', () => {
    let upstreams;
    let rTransport;
    let rBrowserWs;
    let rClient;

    beforeEach(() => {
      jest.useFakeTimers();
      upstreams = [];
      rTransport = {
        createWebSocket: jest.fn((path) => {
          const ws = makeFakeUpstream();
          if (path === '/ws') upstreams.push(ws);
          return ws;
        }),
      };
      rBrowserWs = makeSocket();
      rClient = new RelayClient(rTransport, rBrowserWs, null, null);
    });

    afterEach(() => {
      rClient.close();
    });

    it('resolves connect() from the first open and never re-settles it on a later reconnect', async () => {
      const connected = rClient.connect();
      openFakeUpstream(upstreams[0]);
      await expect(connected).resolves.toBeUndefined();

      upstreams[0].emit('close');
      jest.advanceTimersByTime(2000);
      expect(upstreams).toHaveLength(2);
      expect(() => openFakeUpstream(upstreams[1])).not.toThrow();
    });

    it('retries with capped exponential backoff after the upstream drops', () => {
      rClient.connect().catch(() => {});
      openFakeUpstream(upstreams[0]);

      upstreams[0].emit('close');
      jest.advanceTimersByTime(1999);
      expect(upstreams).toHaveLength(1);
      jest.advanceTimersByTime(1);
      expect(upstreams).toHaveLength(2);

      upstreams[1].emit('close');
      jest.advanceTimersByTime(3999);
      expect(upstreams).toHaveLength(2);
      jest.advanceTimersByTime(1);
      expect(upstreams).toHaveLength(3);
    });

    it('resets the backoff delay after a successful reconnect', () => {
      rClient.connect().catch(() => {});
      openFakeUpstream(upstreams[0]);

      upstreams[0].emit('close');
      jest.advanceTimersByTime(2000);
      openFakeUpstream(upstreams[1]);

      upstreams[1].emit('close');
      jest.advanceTimersByTime(1999);
      expect(upstreams).toHaveLength(2);
      jest.advanceTimersByTime(1);
      expect(upstreams).toHaveLength(3);
    });

    it('keeps retrying even when the very first connection attempt fails outright', async () => {
      const connected = rClient.connect();
      connected.catch(() => {});
      upstreams[0].emit('error', new Error('ECONNREFUSED'));
      upstreams[0].emit('close');
      await expect(connected).rejects.toThrow('ECONNREFUSED');

      jest.advanceTimersByTime(2000);
      expect(upstreams).toHaveLength(2);
    });

    it('stops retrying once close() is called', () => {
      rClient.connect().catch(() => {});
      openFakeUpstream(upstreams[0]);

      rClient.close();
      upstreams[0].emit('close');
      jest.advanceTimersByTime(30000);
      expect(upstreams).toHaveLength(1);
    });

    it('tells the browser relay_status:false immediately on loss, bypassing the batch timer', () => {
      rClient.connect().catch(() => {});
      openFakeUpstream(upstreams[0]);

      upstreams[0].emit('close');
      expect(rBrowserWs.sent).toContainEqual({ type: 'relay_status', connected: false });
    });

    it('does not announce relay_status on the initial connect, only on a later re-establishment', () => {
      rClient.connect().catch(() => {});
      openFakeUpstream(upstreams[0]);
      expect(rBrowserWs.sent).not.toContainEqual(expect.objectContaining({ type: 'relay_status' }));

      upstreams[0].emit('close');
      jest.advanceTimersByTime(2000);
      openFakeUpstream(upstreams[1]);
      expect(rBrowserWs.sent).toContainEqual({ type: 'relay_status', connected: true });
    });
  });
});
