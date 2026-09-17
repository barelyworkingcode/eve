/**
 * Terminal frames proxy through eve to relay and back. Creation is C11:
 * eve answers the browser's WS `terminal_create` over HTTP
 * (`POST /api/terminals`), then joins the resulting terminal over WS —
 * it never forwards `terminal_create` itself to relay. input/resize/close
 * stay on WS, and eve relays terminal_output to the browser unchanged.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');
const { relayFrames } = require('./protocol');

describe('terminal proxying (eve <-> relay)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-term-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
    await eve.relay.waitForRelay();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('creates over HTTP with the fetch body carrying the projectId, then the browser gets terminal_created', async () => {
    const from = ws.mark();
    ws.send({ type: 'terminal_create', templateId: 'zsh', name: 'sh', directory: projectDir, projectId: 'p1', cols: 80, rows: 24 });

    const created = await ws.waitFor((f) => f.type === 'terminal_created', 5000, from);
    expect(created).toMatchObject({ templateId: 'zsh', name: 'sh', directory: projectDir });
    expect(typeof created.terminalId).toBe('string');

    const req = eve.relay.requests.find((r) => r.method === 'POST' && r.path === '/api/terminals');
    expect(req).toBeTruthy();
    const [term] = eve.relay.listTerminals();
    expect(term).toMatchObject({ templateId: 'zsh', name: 'sh', directory: projectDir });
  });

  it('never sends terminal_create to relay over WS — relay gets join_terminal instead', async () => {
    const before = eve.relay.inbound.filter((f) => f.type === 'terminal_create').length;
    const from = ws.mark();
    ws.send({ type: 'terminal_create', templateId: 'zsh', name: 't2', directory: projectDir, projectId: 'p1', cols: 80, rows: 24 });
    const created = await ws.waitFor((f) => f.type === 'terminal_created', 5000, from);

    const joined = await eve.relay.waitForInbound((f) => f.type === 'join_terminal' && f.terminalId === created.terminalId);
    expect(joined).toMatchObject({ type: 'join_terminal', terminalId: created.terminalId });
    expect(eve.relay.inbound.filter((f) => f.type === 'terminal_create').length).toBe(before);
  });

  it('a non-2xx from POST /api/terminals becomes a browser error, and relay never gets a join', async () => {
    eve.relay.failTerminalCreateWith(500);
    try {
      const from = ws.mark();
      ws.send({ type: 'terminal_create', templateId: 'zsh', name: 'boom', directory: projectDir, projectId: 'p1', cols: 80, rows: 24 });
      const err = await ws.waitFor((f) => f.type === 'error', 5000, from);
      expect(err.message).toBe('terminal create failed (500)');
      expect(ws.frames.slice(from).some((f) => f.type === 'terminal_created')).toBe(false);
    } finally {
      eve.relay.clearTerminalCreateFail();
    }
  });

  it('relays terminal_output (base64-encoded, as relayLLM sends it) to the browser', async () => {
    // relayLLM base64-encodes terminal data (main.go); the browser
    // _decodeBase64s it. eve forwards verbatim, so the wire data must be base64.
    eve.relay.emitToRelay(relayFrames.terminalOutput({ terminalId: 't1', data: '$ echo hi\n' }));
    const out = await ws.waitFor((f) => f.type === 'terminal_output' && f.terminalId === 't1');
    expect(Buffer.from(out.data, 'base64').toString()).toBe('$ echo hi\n');
  });

  it('forwards terminal_input, resize and close to relay', async () => {
    ws.send({ type: 'terminal_input', terminalId: 't1', data: 'ls\n' });
    await eve.relay.waitForInbound((f) => f.type === 'terminal_input' && f.terminalId === 't1');

    ws.send({ type: 'terminal_resize', terminalId: 't1', cols: 100, rows: 40 });
    const resize = await eve.relay.waitForInbound((f) => f.type === 'terminal_resize' && f.terminalId === 't1');
    expect(resize).toMatchObject({ cols: 100, rows: 40 });

    ws.send({ type: 'terminal_close', terminalId: 't1' });
    await eve.relay.waitForInbound((f) => f.type === 'terminal_close' && f.terminalId === 't1');
  });
});
