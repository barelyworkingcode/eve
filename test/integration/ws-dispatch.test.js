/**
 * Characterisation for the arms of ws-handler.js's switch that had zero test
 * coverage before phase 5 (see /tmp/eve-phase5-ws-handler-spec.md §9b) and
 * that the fake relay can reach. Table-driven forwarding, modelled directly on
 * session-forwarding.test.js's it.each(cases) idiom, plus two negative
 * characterisations and the two-connection isolation test (§9c-T2).
 *
 * This file is written and frozen BEFORE the registry migration starts. It
 * must not be modified afterwards — if it fails, the migration is wrong.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('ws-dispatch: previously-uncovered arms the fake relay can reach', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-dispatch-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
    await eve.relay.waitForRelay(); // eve drops relay sends on a not-yet-open socket
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  // --- Terminal bookkeeping arms: pure relayClient.send field-picks, forwarded verbatim. ---
  const terminalCases = [
    ['terminal_list', { type: 'terminal_list' }, { type: 'terminal_list' }],
    ['terminal_reconnect',
      { type: 'terminal_reconnect', terminalId: 't1', cols: 90, rows: 30 },
      { type: 'terminal_reconnect', terminalId: 't1', cols: 90, rows: 30 }],
    ['join_terminal', { type: 'join_terminal', terminalId: 't1' }, { type: 'join_terminal', terminalId: 't1' }],
    ['leave_terminal', { type: 'leave_terminal', terminalId: 't1' }, { type: 'leave_terminal', terminalId: 't1' }],
    ['terminal_templates', { type: 'terminal_templates' }, { type: 'terminal_templates' }],
  ];

  it.each(terminalCases)('%s reaches relay verbatim', async (_label, frame, expected) => {
    ws.send(frame);
    const got = await eve.relay.waitForInbound((f) => f.type === frame.type);
    expect(got).toMatchObject(expected);
  });

  // --- Local file arms with no prior coverage. Real disk, asserted both ways. ---
  it('delete_file removes the file and replies file_deleted', async () => {
    const target = path.join(projectDir, 'to-delete.txt');
    fs.writeFileSync(target, 'bye', 'utf8');
    ws.send({ type: 'delete_file', projectId: 'p1', path: 'to-delete.txt' });
    const reply = await ws.waitFor((f) => f.type === 'file_deleted');
    expect(reply).toMatchObject({ projectId: 'p1', path: 'to-delete.txt' });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('create_directory makes the directory and replies directory_created', async () => {
    ws.send({ type: 'create_directory', projectId: 'p1', path: '/', name: 'new-dir' });
    const reply = await ws.waitFor((f) => f.type === 'directory_created' && f.name === 'new-dir');
    expect(reply).toMatchObject({ projectId: 'p1', name: 'new-dir' });
    expect(fs.statSync(path.join(projectDir, 'new-dir')).isDirectory()).toBe(true);
  });

  // --- Negative characterisation: cancel-with-nothing-in-flight. What these
  // arms actually do today is nothing — no crash, no reply frame. A future
  // implementation that starts replying (or throwing) to an unmatched cancel
  // would be a protocol change this test catches. ---
  it('search_ai_stop with no matching request in flight: no crash, no frame', async () => {
    const from = ws.mark();
    ws.send({ type: 'search_ai_stop', requestId: 'no-such-search' });
    // Prove the connection is still alive and dispatching by round-tripping
    // an unrelated op, then assert nothing arrived for the stop itself.
    ws.send({ type: 'terminal_list' });
    await eve.relay.waitForInbound((f) => f.type === 'terminal_list');
    expect(ws.frames.slice(from).some((f) => f.requestId === 'no-such-search')).toBe(false);
  });

  it('module_ai_stop with no matching request in flight: no crash, no frame', async () => {
    const from = ws.mark();
    ws.send({ type: 'module_ai_stop', requestId: 'no-such-invoke' });
    ws.send({ type: 'terminal_list' });
    await eve.relay.waitForInbound((f) => f.type === 'terminal_list');
    expect(ws.frames.slice(from).some((f) => f.requestId === 'no-such-invoke')).toBe(false);
  });
});

/**
 * T2 — two-connection isolation (§9c-T2, constraint C1).
 *
 * The current switch is correct: every per-arm reply is addressed through the
 * `ws` closed over by that specific connection's handler invocation, and
 * every collaborator (relayClient, fileWatcher) is constructed fresh per
 * connection. Nothing here should ever cross-talk. This is the ONLY test in
 * the repo that would catch a future registry descriptor that captures
 * connection-scoped state (ws / relayClient / fileWatcher) at registration
 * time instead of reaching it through a per-call ctx — see C1 in the spec.
 * Written and passing against today's correct code, before any production
 * line of the registry migration lands, so it proves itself.
 */
describe('ws-dispatch: two-connection isolation (C1)', () => {
  let eve;
  let projectDir;
  let wsA;
  let wsB;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-isolation-'));
    fs.writeFileSync(path.join(projectDir, 'secretA.txt'), 'AAA-ONLY-FOR-A', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'secretB.txt'), 'BBB-ONLY-FOR-B', 'utf8');
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    wsA = await eve.connectWs();
    wsB = await eve.connectWs();
    await eve.relay.waitForRelay();
  });

  afterAll(async () => {
    if (wsA) await wsA.close();
    if (wsB) await wsB.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('a file op on each connection replies only to the connection that asked', async () => {
    const fromA = wsA.mark();
    const fromB = wsB.mark();

    // Fire both concurrently — a captured-ws bug would route (at least) one
    // of these to the wrong socket, or duplicate both replies onto one.
    wsA.send({ type: 'read_file', projectId: 'p1', path: 'secretA.txt' });
    wsB.send({ type: 'read_file', projectId: 'p1', path: 'secretB.txt' });

    const replyA = await wsA.waitFor((f) => f.type === 'file_content' && f.path === 'secretA.txt', 5000, fromA);
    const replyB = await wsB.waitFor((f) => f.type === 'file_content' && f.path === 'secretB.txt', 5000, fromB);

    expect(replyA.content).toBe('AAA-ONLY-FOR-A');
    expect(replyB.content).toBe('BBB-ONLY-FOR-B');

    // The negative half of the assertion: neither socket ever saw the other's data.
    expect(wsA.frames.slice(fromA).some((f) => f.type === 'file_content' && f.content === 'BBB-ONLY-FOR-B')).toBe(false);
    expect(wsB.frames.slice(fromB).some((f) => f.type === 'file_content' && f.content === 'AAA-ONLY-FOR-A')).toBe(false);
  });

  it('a session op on each connection replies only to the connection that asked', async () => {
    const fromA = wsA.mark();
    const fromB = wsB.mark();

    wsA.send({ type: 'create_session', projectId: 'p1', name: 'session-A' });
    wsB.send({ type: 'create_session', projectId: 'p1', name: 'session-B' });

    const createdA = await wsA.waitFor((f) => f.type === 'session_created' && f.name === 'session-A', 5000, fromA);
    const createdB = await wsB.waitFor((f) => f.type === 'session_created' && f.name === 'session-B', 5000, fromB);

    expect(createdA.sessionId).not.toBe(createdB.sessionId);
    expect(wsA.frames.slice(fromA).some((f) => f.type === 'session_created' && f.sessionId === createdB.sessionId)).toBe(false);
    expect(wsB.frames.slice(fromB).some((f) => f.type === 'session_created' && f.sessionId === createdA.sessionId)).toBe(false);
  });
});
