// SSH host connectivity (../relay/docs/ssh-hosts.md): StateStore.hosts holds
// eve's own file-agent status per host id, fed by `host_status` WS frames
// (via message-dispatcher.js) and seeded from GET /api/hosts.
beforeAll(() => {
  global.EVT = { HOST_STATUS: 'host:status' };
});
afterAll(() => { delete global.EVT; });

const StateStore = require('../../public/core/state-store');

function makeBus() {
  const events = [];
  return { events, emit: (event, data) => events.push({ event, data }) };
}

describe('StateStore hosts', () => {
  it('getHost/hostStatus default to unknown for a host never seen', () => {
    const store = new StateStore(makeBus());
    expect(store.getHost('h1')).toBeUndefined();
    expect(store.hostStatus('h1')).toBe('unknown');
  });

  it('setHosts seeds the map from a GET /api/hosts-shaped list and emits once', () => {
    const bus = makeBus();
    const store = new StateStore(bus);
    store.setHosts([
      { id: 'h1', name: 'devbox', status: 'idle', target: 'admin@devbox.local' },
      { id: 'h2', name: 'other', status: 'unreachable' },
    ]);
    expect(store.getHost('h1')).toMatchObject({ id: 'h1', name: 'devbox', status: 'idle', target: 'admin@devbox.local' });
    expect(store.hostStatus('h2')).toBe('unreachable');
    expect(bus.events.filter((e) => e.event === 'host:status')).toHaveLength(1);
  });

  it('setHostStatus applies a live host_status frame and emits with the hostId', () => {
    const bus = makeBus();
    const store = new StateStore(bus);
    store.setHostStatus({ hostId: 'h1', name: 'devbox', status: 'connecting' });
    expect(store.hostStatus('h1')).toBe('connecting');
    expect(bus.events).toContainEqual({ event: 'host:status', data: { hostId: 'h1' } });
  });

  it('setHostStatus merges onto an existing entry without losing fields setHosts seeded', () => {
    const store = new StateStore(makeBus());
    store.setHosts([{ id: 'h1', name: 'devbox', status: 'idle', target: 'admin@devbox.local' }]);
    store.setHostStatus({ hostId: 'h1', status: 'connected' });
    expect(store.getHost('h1')).toMatchObject({ id: 'h1', name: 'devbox', target: 'admin@devbox.local', status: 'connected' });
  });

  it('setHostStatus carries an error message through, and clears it on the next status without one', () => {
    const store = new StateStore(makeBus());
    store.setHostStatus({ hostId: 'h1', name: 'devbox', status: 'unreachable', error: 'connection refused' });
    expect(store.getHost('h1').error).toBe('connection refused');
    store.setHostStatus({ hostId: 'h1', name: 'devbox', status: 'connected' });
    expect(store.getHost('h1').error).toBeUndefined();
  });

  it('setHostStatus ignores a frame with no hostId', () => {
    const store = new StateStore(makeBus());
    store.setHostStatus({ status: 'connected' });
    expect(store.hosts.size).toBe(0);
  });

  it("a project's own host field is untouched by StateStore.hosts (they are separate namespaces)", () => {
    const store = new StateStore(makeBus());
    store.setProjects([{ id: 'p1', name: 'proj', host: { id: 'h1', name: 'devbox', status: 'connected' } }]);
    store.setHostStatus({ hostId: 'h1', name: 'devbox', status: 'unreachable' });
    // The project's own snapshot doesn't retroactively update — a fresh
    // resolveProject()/getProjects() call from the server is what refreshes it.
    expect(store.getProject('p1').host.status).toBe('connected');
    expect(store.hostStatus('h1')).toBe('unreachable');
  });
});
