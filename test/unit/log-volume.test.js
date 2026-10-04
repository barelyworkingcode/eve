// Volume rule of the logging standard: nothing per poll, reconnect attempt or
// stream chunk. Real Logger at debug, so a debug line per attempt would show.
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { Logger } = require('../../logger');
const RelayClient = require('../../relay-client');
const { RoutineFailureWatcher } = require('../../routine-failure-watcher');

function realLogger() {
  const writes = [];
  const stream = { write: (s) => { writes.push(s); return true; } };
  const log = new Logger('debug', { stream, now: () => Date.now(), service: 'eve' });
  return { log, writes, lines: () => writes.map((w) => JSON.parse(w)) };
}

// A socket that fails the way a dead daemon does: error, then close.
function failingTransport() {
  const sockets = [];
  return {
    sockets,
    createWebSocket: jest.fn((p) => {
      const ws = new EventEmitter();
      ws.path = p;
      ws.readyState = WebSocket.CONNECTING;
      ws.send = jest.fn();
      ws.close = jest.fn();
      sockets.push(ws);
      setTimeout(() => { ws.emit('error', new Error('connect ECONNREFUSED')); ws.emit('close'); }, 0);
      return ws;
    }),
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('reconnect volume', () => {
  it('failed upstream and scheduler reconnects write at most one upstream down line and no scheduler line', async () => {
    const { log, lines } = realLogger();
    const transport = failingTransport();
    const client = new RelayClient(transport, { readyState: WebSocket.OPEN, send: jest.fn() }, null, log);
    client.connect().catch(() => {});
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    client.close();

    const attempts = (p) => transport.createWebSocket.mock.calls.filter(([x]) => x === p).length;
    expect(attempts('/ws')).toBeGreaterThanOrEqual(10);
    expect(attempts('/ws/tasks')).toBeGreaterThanOrEqual(10);
    expect(lines().filter((l) => /scheduler/i.test(l.msg))).toEqual([]);
    expect(lines().length).toBeLessThanOrEqual(1);
  });

  it('routine failure watcher writes no lines over repeated failed attempts', async () => {
    const { log, writes } = realLogger();
    const transport = failingTransport();
    const watcher = new RoutineFailureWatcher({ relayTransport: transport, notifier: { notify: jest.fn() }, log });
    watcher.start();
    await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
    watcher.stop();
    expect(transport.createWebSocket.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(writes).toEqual([]);
  });
});

describe('TTS volume', () => {
  async function speak(chunks, synthesize) {
    const { log, lines } = realLogger();
    const browserWs = { readyState: WebSocket.OPEN, send: jest.fn() };
    const client = new RelayClient({ createWebSocket: jest.fn() }, browserWs, { synthesize }, log);
    client.currentSessionId = 's1';
    client.setVoiceMode(true);
    for (let i = 0; i < chunks; i++) {
      client._handleRelayMessage({
        type: 'llm_event', sessionId: 's1',
        event: { type: 'assistant', delta: { type: 'text_delta', text: `Sentence number ${i} is long enough to be spoken aloud by the daemon. ` } },
      });
    }
    client._handleRelayMessage({ type: 'message_complete', sessionId: 's1' });
    await jest.advanceTimersByTimeAsync(1000);
    const audio = browserWs.send.mock.calls.filter(([d]) => Buffer.isBuffer(d)).length;
    client.close();
    return { lines: lines(), audio, synthesize };
  }

  it('writes the same number of lines for 30 chunks as for 3', async () => {
    const ok = () => jest.fn().mockResolvedValue({ audio_base64: 'AAAA' });
    const small = await speak(3, ok());
    const large = await speak(30, ok());
    expect(small.audio).toBeGreaterThanOrEqual(3);
    expect(large.audio).toBeGreaterThanOrEqual(30);
    expect(large.lines.length).toBe(small.lines.length);
  });

  it('a failing TTS daemon over 12 chunks writes at most one error line', async () => {
    const fail = jest.fn().mockRejectedValue(new Error('TTS daemon connection error: ECONNREFUSED'));
    const { lines } = await speak(12, fail);
    expect(fail.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(lines.filter((l) => l.level === 'error').length).toBeLessThanOrEqual(1);
  });
});

describe('malformed frames', () => {
  const frame = 'zq7frame-not-json {"secret":"x"}';

  it('never copy the frame text into a line', async () => {
    const { log, writes } = realLogger();
    const transport = failingTransport();
    transport.createWebSocket.mockImplementation((p) => {
      const ws = new EventEmitter();
      ws.readyState = WebSocket.OPEN;
      ws.send = jest.fn();
      ws.close = jest.fn();
      transport.sockets.push(ws);
      return ws;
    });
    const client = new RelayClient(transport, { readyState: WebSocket.OPEN, send: jest.fn() }, null, log);
    client.connect().catch(() => {});
    const watcher = new RoutineFailureWatcher({ relayTransport: transport, notifier: { notify: jest.fn() }, log });
    watcher.start();
    for (const ws of transport.sockets) ws.emit('message', Buffer.from(frame));
    await jest.advanceTimersByTimeAsync(100);
    client.close();
    watcher.stop();

    expect(transport.sockets.length).toBeGreaterThanOrEqual(3);
    expect(writes.join('')).not.toContain('zq7frame');
  });
});
