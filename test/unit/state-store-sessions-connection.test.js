// Running state comes from relay's `live` flag, and the composer's online
// state from the browser socket plus relay's upstream (`relay_status`).
beforeAll(() => {
  global.EVT = { SESSION_UPDATED: 'session:updated', CONNECTION_CHANGED: 'connection:changed' };
});
afterAll(() => { delete global.EVT; });

const StateStore = require('../../public/core/state-store');

function makeBus() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}

describe('StateStore.addSession running flag', () => {
  it.each([
    [{ live: true }, true],
    [{ live: false }, false],
    [{}, false],
    [{ active: false, live: true }, false],
  ])('%j stores active=%p', (flags, expected) => {
    const store = new StateStore(makeBus());
    store.addSession({ sessionId: 's1', ...flags });
    expect(store.getSession('s1').active).toBe(expected);
  });
});

describe('StateStore connection', () => {
  const changes = (bus) => bus.events.filter((e) => e.event === 'connection:changed');

  it('starts offline: browser down, relay assumed up', () => {
    const store = new StateStore(makeBus());
    expect(store.connection).toEqual({ browser: false, relay: true });
    expect(store.isOnline()).toBe(false);
  });

  it('setConnection merges, reports online = browser && relay, and emits only on change', () => {
    const bus = makeBus();
    const store = new StateStore(bus);

    store.setConnection({ browser: true });
    expect(store.isOnline()).toBe(true);
    expect(changes(bus).map((e) => e.data)).toEqual([{ browser: true, relay: true, online: true }]);

    store.setConnection({ browser: true });
    store.setConnection({ browser: true, relay: true });
    expect(changes(bus)).toHaveLength(1);

    store.setConnection({ relay: false });
    expect(store.isOnline()).toBe(false);
    expect(store.connection).toEqual({ browser: true, relay: false });
    expect(changes(bus).map((e) => e.data)).toEqual([
      { browser: true, relay: true, online: true },
      { browser: true, relay: false, online: false },
    ]);
  });
});
