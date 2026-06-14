/**
 * Increment 5 — resilience. Asserts eve's documented degradation behavior when
 * relay is unavailable, and that a browser reconnect establishes a fresh working
 * session. Each test runs its own spawned eve since the relay-down cases are
 * destructive to the shared backend.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('resilience (relay down / reconnect)', () => {
  let projectDir;

  beforeAll(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-resil-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# hi', 'utf8');
  });

  afterAll(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const project = () => ({ id: 'p1', name: 'Test', path: projectDir });

  it('surfaces a graceful error (not a crash) when create_session hits a dead relay', async () => {
    const eve = await startEve({ projects: [project()] });
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

  it('keeps local file ops working while relay is down', async () => {
    const eve = await startEve({ projects: [project()] });
    try {
      await eve.relay.close(); // project is already cached, so resolution still works
      const ws = await eve.connectWs();
      try {
        ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
        const listing = await ws.waitFor((f) => f.type === 'directory_listing');
        expect(listing.entries.map((e) => e.name)).toContain('README.md');
      } finally {
        await ws.close();
      }
    } finally {
      await eve.stop();
    }
  });

  it('establishes a fresh working session after a browser reconnect', async () => {
    const eve = await startEve({ projects: [project()] });
    try {
      // First connection, then drop it.
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
});
