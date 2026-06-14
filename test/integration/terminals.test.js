/**
 * Terminal frames proxy through eve to relay and back. eve owns no terminal
 * state — it forwards create/input/resize/close to relay and relays
 * terminal_output to the browser.
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

  it('forwards terminal_create to relay with the projectId', async () => {
    ws.send({ type: 'terminal_create', templateId: 'zsh', name: 'sh', directory: projectDir, projectId: 'p1', cols: 80, rows: 24 });
    const created = await eve.relay.waitForInbound((f) => f.type === 'terminal_create');
    expect(created).toMatchObject({ type: 'terminal_create', projectId: 'p1', cols: 80, rows: 24 });
  });

  it('relays terminal_output (base64-encoded, as relayLLM sends it) to the browser', async () => {
    // relayLLM base64-encodes terminal data (main.go:150); the browser _decodeBase64s
    // it. eve forwards verbatim, so the data on the wire must be base64.
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
