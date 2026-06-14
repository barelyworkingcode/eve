/**
 * UI command bus: the eve-control MCP POSTs to the loopback-only
 * /internal/ui-command endpoint; eve fans a `ui_command` frame to the browser(s)
 * viewing that project. Gated by a loopback peer + the shared secret.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

const SECRET = 'test-internal-secret';

describe('ui command bus (/internal/ui-command)', () => {
  let eve;
  let projectDir;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-ui-'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# hi', 'utf8');
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }], env: { EVE_INTERNAL_SECRET: SECRET } });
  });

  afterAll(async () => {
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  const post = (body, secret = SECRET) => eve.get('/internal/ui-command', {
    method: 'POST',
    headers: { 'x-eve-internal': secret, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('fans an open_tab command to the browser viewing the project', async () => {
    const ws = await eve.connectWs();
    try {
      // Announce that this browser is viewing p1 (ws-handler -> uiBus.setProject).
      ws.send({ type: 'list_directory', projectId: 'p1', path: '/' });
      await ws.waitFor((f) => f.type === 'directory_listing');

      const res = await post({ action: 'open_tab', project_id: 'p1', image_url: '/api/generated/x.png', title: 'Pic' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ status: 'ok', delivered: 1 });
      expect(body.tab_ref).toMatch(/^eve-llm-/);

      const cmd = await ws.waitFor((f) => f.type === 'ui_command');
      expect(cmd.actor).toBe('llm');
      expect(cmd.command).toMatchObject({ action: 'open_tab', image_url: '/api/generated/x.png', tab_ref: body.tab_ref });
    } finally {
      await ws.close();
    }
  });

  it('rejects a wrong secret with 401', async () => {
    const res = await post({ action: 'open_tab', project_id: 'p1', image_url: '/x' }, 'wrong-secret');
    expect(res.status).toBe(401);
  });

  it('reports no_client when no browser is viewing the project', async () => {
    const res = await post({ action: 'open_tab', project_id: 'unwatched', image_url: '/x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'no_client', delivered: 0 });
  });
});
