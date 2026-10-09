// Asserts eve's documented degradation behavior when relay is unavailable,
// and that a browser reconnect establishes a fresh working session. Each
// test runs its own spawned eve since the relay-down cases are destructive.
const { startEve } = require('./harness');
const { createFakeRelay } = require('./fake-relay');

describe('resilience (relay down / reconnect)', () => {
  const project = () => ({ id: 'p1', name: 'Test', path: '/work/acme' });
  const tree = { 'README.md': '# hi', 'src/': null };

  it('surfaces a graceful error (not a crash) when create_session hits a dead relay', async () => {
    const eve = await startEve({ projects: [project()], files: { p1: tree } });
    try {
      await eve.relay.close(); // relay goes away after eve has booted + cached the project
      const ws = await eve.connectWs();
      try {
        ws.send({ type: 'create_session', projectId: 'p1' });
        const err = await ws.waitFor((f) => f.type === 'error' && /create session/i.test(f.message || ''));
        expect(err.message).toMatch(/unavailable/i);
      } finally {
        await ws.close();
      }
    } finally {
      await eve.stop();
    }
  });

  it('fails file ops with "Relay is not reachable" while relay is down, and works again once it is back', async () => {
    const eve = await startEve({ projects: [project()], files: { p1: tree } });
    try {
      await eve.relay.close(); // project is already cached, so resolution still works
      const ws = await eve.connectWs();
      try {
        ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
        const err = await ws.waitFor((f) => f.type === 'file_error');
        expect(err).toMatchObject({ projectId: 'p1', error: 'Relay is not reachable' });

        const revived = await eve.reviveRelay({ projects: [project()], files: { p1: tree } });
        ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
        const listing = await ws.waitFor((f) => f.type === 'directory_listing');
        expect(listing.entries.map((e) => e.name)).toContain('README.md');
        await revived.files.watched('p1'); // the file leg reconnected and re-sent its watch
      } finally {
        await ws.close();
      }
    } finally {
      await eve.stop();
    }
  });

  it('establishes a fresh working session after a browser reconnect', async () => {
    const eve = await startEve({ projects: [project()], files: { p1: tree } });
    try {
      const ws1 = await eve.connectWs();
      ws1.send({ type: 'create_session', projectId: 'p1' });
      await ws1.waitFor((f) => f.type === 'session_created');
      await ws1.close();

      // Reconnect: a brand-new browser socket → brand-new RelayClient.
      const ws2 = await eve.connectWs();
      try {
        const from = ws2.mark();
        ws2.send({ type: 'create_session', projectId: 'p1' });
        const created = await ws2.waitFor((f) => f.type === 'session_created', 5000, from);
        ws2.send({ type: 'user_input', text: 'hi', sessionId: created.sessionId });
        await ws2.waitFor((f) => f.type === 'message_complete' && f.sessionId === created.sessionId);
        const text = ws2.frames
          .filter((f) => f.type === 'llm_event' && f.sessionId === created.sessionId)
          .map((f) => f.event.delta.text).join('');
        expect(text).toBe('Hello from fake relay');
      } finally {
        await ws2.close();
      }
    } finally {
      await eve.stop();
    }
  });

  it('retries the upstream leg on its own and forwards session traffic again once relay comes back', async () => {
    const eve = await startEve({ projects: [project()], files: { p1: tree } });
    let revived = null;
    try {
      const ws = await eve.connectWs();
      try {
        ws.send({ type: 'create_session', projectId: 'p1' });
        const created = await ws.waitFor((f) => f.type === 'session_created');

        // create_session's own internal join_session/session_joined round trip
        // (suppressed from the browser — see relay-client.js suppressNextJoin)
        // has to land before relay goes away, or the suppress flag is left set
        // forever and swallows the session_joined this test waits for below.
        await eve.relay.waitForInbound((f) => f.type === 'join_session' && f.sessionId === created.sessionId);
        await new Promise((r) => setTimeout(r, 200));

        await eve.relay.close();
        await ws.waitFor((f) => f.type === 'relay_status' && f.connected === false);

        // RELAY_FRONTEND_URL was fixed at eve's spawn — the only way back is a
        // fresh relay bound to the exact same port eve is retrying against.
        revived = createFakeRelay();
        await revived.listen(eve.relayPort);

        await ws.waitFor((f) => f.type === 'relay_status' && f.connected === true, 10000);

        const from = ws.mark();
        ws.send({ type: 'join_session', sessionId: created.sessionId });
        const joined = await ws.waitFor((f) => f.type === 'session_joined', 5000, from);
        expect(joined.sessionId).toBe(created.sessionId);
      } finally {
        await ws.close();
      }
    } finally {
      if (revived) await revived.close();
      await eve.stop();
    }
  });
});
