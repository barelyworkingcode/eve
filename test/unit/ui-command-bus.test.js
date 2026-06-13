/**
 * UiCommandBus — fans LLM-initiated ui_command frames to the browsers viewing a
 * project, behind a loopback + shared-secret gate on POST /internal/ui-command.
 * The gate is the security boundary (only the loopback eve-control MCP may
 * drive the browser), so both the rejection paths and the project-targeted
 * delivery are worth pinning.
 */
const UiCommandBus = require('../../ui-command-bus');

const SECRET = 'super-secret-value';

function mockReq({ remote = '127.0.0.1', secret = SECRET, body = {} } = {}) {
  return {
    socket: { remoteAddress: remote },
    headers: { 'x-eve-internal': secret },
    body,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

function mockClient() {
  return { sent: [], sendToBrowser(f) { this.sent.push(f); } };
}

describe('UiCommandBus', () => {
  let bus;
  beforeEach(() => { bus = new UiCommandBus({ internalSecret: SECRET }); });

  describe('gate', () => {
    it('rejects a non-loopback peer with 403', () => {
      const res = mockRes();
      bus.handleInternalRequest(mockReq({ remote: '10.0.0.9' }), res);
      expect(res.statusCode).toBe(403);
    });

    it('accepts standard loopback forms', () => {
      for (const remote of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const res = mockRes();
        bus.handleInternalRequest(mockReq({ remote, body: { action: 'nope' } }), res);
        expect(res.statusCode).toBe(400); // passed the gate, failed on action
      }
    });

    it('rejects a wrong secret with 401', () => {
      const res = mockRes();
      bus.handleInternalRequest(mockReq({ secret: 'wrong' }), res);
      expect(res.statusCode).toBe(401);
    });

    it('fails closed when no secret is configured', () => {
      const open = new UiCommandBus({ internalSecret: '' });
      const res = mockRes();
      open.handleInternalRequest(mockReq({ secret: '' }), res);
      expect(res.statusCode).toBe(401);
    });
  });

  describe('actions', () => {
    it('rejects an unknown action with 400', () => {
      const res = mockRes();
      bus.handleInternalRequest(mockReq({ body: { action: 'frobnicate' } }), res);
      expect(res.statusCode).toBe(400);
    });

    it('open_tab requires image_url', () => {
      const res = mockRes();
      bus.handleInternalRequest(mockReq({ body: { action: 'open_tab' } }), res);
      expect(res.statusCode).toBe(400);
    });

    it('refresh_tab / close_tab require tab_ref', () => {
      for (const action of ['refresh_tab', 'close_tab']) {
        const res = mockRes();
        bus.handleInternalRequest(mockReq({ body: { action } }), res);
        expect(res.statusCode).toBe(400);
      }
    });

    it('open_tab mints a tab_ref and delivers to browsers viewing the project', () => {
      const client = mockClient();
      bus.setProject(client, 'proj-1');

      const res = mockRes();
      bus.handleInternalRequest(mockReq({
        body: { action: 'open_tab', project_id: 'proj-1', image_url: '/api/generated/x.png', title: 'Pic' },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', delivered: 1 });
      expect(res.body.tab_ref).toEqual(expect.stringMatching(/^eve-llm-/));
      expect(client.sent).toHaveLength(1);
      expect(client.sent[0]).toMatchObject({
        type: 'ui_command',
        actor: 'llm',
        projectId: 'proj-1',
        command: { action: 'open_tab', tab_ref: res.body.tab_ref, image_url: '/api/generated/x.png' },
      });
    });

    it('reports no_client when no browser is viewing the project', () => {
      const res = mockRes();
      bus.handleInternalRequest(mockReq({
        body: { action: 'open_tab', project_id: 'nobody', image_url: '/x.png' },
      }), res);
      expect(res.body).toMatchObject({ status: 'no_client', delivered: 0 });
    });

    it('refresh_tab reuses the caller tab_ref (does NOT mint a new one) and carries image_url', () => {
      const client = mockClient();
      bus.setProject(client, 'proj-1');
      // A caller ref that is deliberately NOT in eve's eve-llm-* mint format, so a
      // regression that minted a fresh ref would visibly change this value.
      const callerRef = 'caller-owned-ref-42';

      const res = mockRes();
      bus.handleInternalRequest(mockReq({
        body: { action: 'refresh_tab', project_id: 'proj-1', tab_ref: callerRef, image_url: '/api/generated/y.png', tab_kind: 'video' },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ status: 'ok', delivered: 1 });
      // Reused, not minted: identical to the caller's ref and never the eve-llm-* form.
      expect(res.body.tab_ref).toBe(callerRef);
      expect(res.body.tab_ref).not.toMatch(/^eve-llm-/);
      expect(client.sent).toHaveLength(1);
      expect(client.sent[0].command).toEqual({
        action: 'refresh_tab',
        tab_kind: 'video',
        tab_ref: callerRef,
        image_url: '/api/generated/y.png',
      });
    });

    it('refresh_tab defaults tab_kind to image and image_url to null when omitted', () => {
      const client = mockClient();
      bus.setProject(client, 'proj-1');

      const res = mockRes();
      bus.handleInternalRequest(mockReq({
        body: { action: 'refresh_tab', project_id: 'proj-1', tab_ref: 'r1' },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(client.sent[0].command).toEqual({
        action: 'refresh_tab',
        tab_kind: 'image',
        tab_ref: 'r1',
        image_url: null,
      });
    });
  });

  describe('connection indexing', () => {
    it('routes only to clients viewing the target project', () => {
      const a = mockClient();
      const b = mockClient();
      bus.setProject(a, 'p-a');
      bus.setProject(b, 'p-b');
      expect(bus.pushToProject('p-a', { action: 'close_tab', tab_ref: 't1' })).toBe(1);
      expect(a.sent).toHaveLength(1);
      expect(b.sent).toHaveLength(0);
    });

    it('unregister stops future delivery to a client', () => {
      const client = mockClient();
      bus.setProject(client, 'p1');
      bus.unregister(client);
      expect(bus.pushToProject('p1', { action: 'close_tab', tab_ref: 't' })).toBe(0);
      expect(client.sent).toHaveLength(0);
    });

    it('counts only successful deliveries and survives a throwing client', () => {
      const ok = mockClient();
      const bad = { sendToBrowser() { throw new Error('socket gone'); } };
      bus.setProject(ok, 'p1');
      bus.setProject(bad, 'p1');
      expect(bus.pushToProject('p1', { action: 'close_tab', tab_ref: 't' })).toBe(1);
      expect(ok.sent).toHaveLength(1);
    });
  });
});
