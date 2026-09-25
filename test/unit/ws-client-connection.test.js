// WsClient drives the browser half of StateStore.connection; the relay half
// arrives as relay_status frames, which may land before auth_success on a
// fresh socket. ws-client.js is a plain <script> global, so it's loaded into
// a vm sandbox with a fake WebSocket and window.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

beforeAll(() => {
  global.EVT = { CONNECTION_CHANGED: 'connection:changed' };
});
afterAll(() => { delete global.EVT; });

const StateStore = require('../../public/core/state-store');

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 3; }
}
FakeWebSocket.OPEN = 1;

function setup() {
  jest.useFakeTimers();
  FakeWebSocket.instances = [];
  const windowListeners = {};
  const sandbox = {
    window: {
      location: { protocol: 'http:', host: 'eve.test' },
      addEventListener: (type, fn) => { windowListeners[type] = fn; },
    },
    document: { hidden: false, addEventListener() {} },
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    localStorage: { getItem: () => null, removeItem() {} },
    WebSocket: FakeWebSocket,
    setTimeout, clearTimeout, setInterval, clearInterval, Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public/core/constants.js'), 'utf8'), sandbox);
  const src = fs.readFileSync(path.join(__dirname, '../../public/ws-client.js'), 'utf8');
  const WsClient = vm.runInContext(`${src}\nWsClient`, sandbox);

  const state = new StateStore({ emit() {} });
  const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
  const values = { logger, bus: { emit() {}, on() {} }, state };
  // Stands in for MessageDispatcher._handleRelayStatus.
  const onMessage = (d) => { if (d.type === 'relay_status') state.setConnection({ relay: !!d.connected }); };
  const client = new WsClient({ get: (k) => values[k] }, { onReady() {}, onMessage, onAudio() {} });

  const open = () => {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen();
    return ws;
  };
  const recv = (ws, frame) => ws.onmessage({ data: JSON.stringify(frame) });
  const connectAndAuth = () => {
    client.connect();
    const ws = open();
    recv(ws, { type: 'auth_success' });
    return ws;
  };
  return { client, state, windowListeners, open, recv, connectAndAuth };
}

describe('WsClient connection state', () => {
  it('a relay_status:false that beats auth_success on a fresh socket leaves the app offline', () => {
    const { client, state, open, recv } = setup();
    state.setConnection({ relay: false });

    client.connect();
    const ws = open();
    expect(state.connection.relay).toBe(true);

    recv(ws, { type: 'relay_status', connected: false });
    recv(ws, { type: 'auth_success' });
    expect(state.connection).toEqual({ browser: true, relay: false });
    expect(state.isOnline()).toBe(false);
  });

  it('an offline event on a still-open socket recovers on the next inbound frame, without reconnecting', () => {
    const { state, windowListeners, recv, connectAndAuth } = setup();
    const ws = connectAndAuth();
    expect(state.isOnline()).toBe(true);

    windowListeners.offline();
    expect(state.isOnline()).toBe(false);

    recv(ws, { type: 'pong' });
    expect(state.isOnline()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('forceReconnect marks the browser leg down until the new socket authenticates', () => {
    const { client, state, open, recv, connectAndAuth } = setup();
    connectAndAuth();
    expect(state.isOnline()).toBe(true);

    client.forceReconnect();
    expect(state.isOnline()).toBe(false);
    const ws = open();
    expect(state.isOnline()).toBe(false);

    recv(ws, { type: 'auth_success' });
    expect(state.isOnline()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
