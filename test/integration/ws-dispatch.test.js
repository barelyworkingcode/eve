// Frozen before the registry migration starts and must not be modified
// afterwards — if it fails, the migration is wrong.
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

  // Pure relayClient.send field-picks, forwarded verbatim.
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

  // Today an unmatched cancel does nothing — no crash, no reply frame. A
  // future implementation that starts replying (or throwing) would be a
  // protocol change this test catches.
  it('search_ai_stop with no matching request in flight: no crash, no frame', async () => {
    const from = ws.mark();
    ws.send({ type: 'search_ai_stop', requestId: 'no-such-search' });
    // Round-trip an unrelated op to prove the connection is still alive and
    // dispatching, then assert nothing arrived for the stop itself.
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
 * Two-connection isolation (C1, docs/decisions/003-ws-message-registry.md).
 * The ONLY test in the repo that would catch a future handler that captures
 * one connection's socket / relayClient / fileWatcher at registration time
 * and serves another connection's data through it.
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
    fs.writeFileSync(path.join(projectDir, 'needleA.txt'), 'ZEBRAALPHA marker', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'needleB.txt'), 'ZEBRABRAVO marker', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'dataA.txt'), 'MODULE-DATA-A', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'dataB.txt'), 'MODULE-DATA-B', 'utf8');
    // Same fixture shape as file-ops.test.js.
    fs.mkdirSync(path.join(projectDir, 'modules', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'modules', 'demo', 'module.json'), JSON.stringify({
      displayName: 'Demo', entry: 'index.html', permissions: { files: ['dataA.txt', 'dataB.txt'] },
    }), 'utf8');
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    wsA = await eve.connectWs();
    wsB = await eve.connectWs();
    await eve.relay.waitForRelay();
    // waitForRelay only guarantees the first of eve's two upstreams is open;
    // the terminal case below needs both (relayClient.send silently no-ops
    // on a not-yet-open socket).
    for (let i = 0; i < 100 && eve.relay.relayConnectionCount() < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
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

    // Fire concurrently — a captured-ws bug would route one to the wrong
    // socket, or duplicate both replies onto one.
    wsA.send({ type: 'read_file', projectId: 'p1', path: 'secretA.txt' });
    wsB.send({ type: 'read_file', projectId: 'p1', path: 'secretB.txt' });

    const replyA = await wsA.waitFor((f) => f.type === 'file_content' && f.path === 'secretA.txt', 5000, fromA);
    const replyB = await wsB.waitFor((f) => f.type === 'file_content' && f.path === 'secretB.txt', 5000, fromB);

    expect(replyA.content).toBe('AAA-ONLY-FOR-A');
    expect(replyB.content).toBe('BBB-ONLY-FOR-B');

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

  // C1's "accepted limits" named search, module, and voice as
  // review-checklist-only; terminal is covered below too, closing that gap.
  it('search_project on each connection replies only to the connection that asked', async () => {
    const fromA = wsA.mark();
    const fromB = wsB.mark();

    wsA.send({ type: 'search_project', projectId: 'p1', query: 'ZEBRAALPHA', requestId: 'search-A' });
    wsB.send({ type: 'search_project', projectId: 'p1', query: 'ZEBRABRAVO', requestId: 'search-B' });

    const resultsA = await wsA.waitFor((f) => f.type === 'search_results' && f.requestId === 'search-A', 10000, fromA);
    const resultsB = await wsB.waitFor((f) => f.type === 'search_results' && f.requestId === 'search-B', 10000, fromB);

    expect(resultsA.matches.some((m) => path.basename(m.file) === 'needleA.txt')).toBe(true);
    expect(resultsB.matches.some((m) => path.basename(m.file) === 'needleB.txt')).toBe(true);

    expect(wsA.frames.slice(fromA).some((f) => f.requestId === 'search-B')).toBe(false);
    expect(wsB.frames.slice(fromB).some((f) => f.requestId === 'search-A')).toBe(false);
  });

  it('module_read_file on each connection replies only to the connection that asked', async () => {
    const fromA = wsA.mark();
    const fromB = wsB.mark();

    wsA.send({ type: 'module_read_file', projectId: 'p1', moduleName: 'demo', path: 'dataA.txt', requestId: 'mod-A' });
    wsB.send({ type: 'module_read_file', projectId: 'p1', moduleName: 'demo', path: 'dataB.txt', requestId: 'mod-B' });

    const respA = await wsA.waitFor((f) => f.type === 'module_file_response' && f.requestId === 'mod-A', 5000, fromA);
    const respB = await wsB.waitFor((f) => f.type === 'module_file_response' && f.requestId === 'mod-B', 5000, fromB);

    expect(respA).toMatchObject({ ok: true, content: 'MODULE-DATA-A' });
    expect(respB).toMatchObject({ ok: true, content: 'MODULE-DATA-B' });

    expect(wsA.frames.slice(fromA).some((f) => f.requestId === 'mod-B')).toBe(false);
    expect(wsB.frames.slice(fromB).some((f) => f.requestId === 'mod-A')).toBe(false);
  });

  it('transcribe_audio on each connection replies with its own error, never the other\'s', async () => {
    const fromA = wsA.mark();
    const fromB = wsB.mark();

    // Both land on the daemon-unreachable path (harness pins TTS_PORT/STT_PORT
    // to dead ports), but the two arms diverge before that dial even
    // happens, on the payload alone — see handleTranscribeAudio.
    wsA.send({ type: 'transcribe_audio' }); // no audio field at all
    wsB.send({ type: 'transcribe_audio', audio: Buffer.from('ABCD').toString('base64') }); // 4 raw bytes, well under the 100-byte floor

    const errA = await wsA.waitFor((f) => f.type === 'transcription_error', 5000, fromA);
    const errB = await wsB.waitFor((f) => f.type === 'transcription_error', 5000, fromB);

    expect(errA.error).toBe('No audio data');
    expect(errB.error).toBe('Audio recording too short');

    expect(wsA.frames.slice(fromA).some((f) => f.error === 'Audio recording too short')).toBe(false);
    expect(wsB.frames.slice(fromB).some((f) => f.error === 'No audio data')).toBe(false);
  });

  it('terminal_input from each connection arrives at relay on a different relay socket', async () => {
    wsA.send({ type: 'terminal_input', terminalId: 'tA', data: 'FROM-A' });
    wsB.send({ type: 'terminal_input', terminalId: 'tB', data: 'FROM-B' });

    const inA = await eve.relay.waitForInbound((f) => f.type === 'terminal_input' && f.terminalId === 'tA');
    const inB = await eve.relay.waitForInbound((f) => f.type === 'terminal_input' && f.terminalId === 'tB');

    expect(inA.__relaySocketId).toBeDefined();
    expect(inB.__relaySocketId).toBeDefined();
    expect(inA.__relaySocketId).not.toBe(inB.__relaySocketId);
  });
});
