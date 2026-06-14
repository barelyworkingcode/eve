/**
 * Permission round-trip: relay emits a permission_request → eve forwards it to
 * the browser → the browser's permission_response is forwarded back to relay.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');
const { relayFrames } = require('./protocol');

describe('permission request/response forwarding', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-perm-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
    await eve.relay.waitForRelay();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('forwards a relay permission_request to the browser and the response back to relay', async () => {
    // Real relayLLM field names (toolName/toolInput/toolUseId) — see protocol.js.
    eve.relay.emitToRelay(relayFrames.permissionRequest({
      sessionId: 's1', permissionId: 'perm-1', toolName: 'Bash', toolInput: '{"command":"ls"}', toolUseId: 'tu-1',
    }));

    const req = await ws.waitFor((f) => f.type === 'permission_request' && f.permissionId === 'perm-1');
    expect(req.toolName).toBe('Bash');
    expect(req.toolUseId).toBe('tu-1');

    ws.send({ type: 'permission_response', permissionId: 'perm-1', approved: true, reason: 'ok' });

    const resp = await eve.relay.waitForInbound((f) => f.type === 'permission_response' && f.permissionId === 'perm-1');
    expect(resp).toMatchObject({ approved: true, reason: 'ok' });
  });
});
