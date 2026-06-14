/**
 * Increment 2 — project create/edit/delete end-to-end. These proxy through eve
 * to the fake relay (which plays the project store) and update eve's in-memory
 * project cache. Asserts BOTH eve's HTTP response and the resulting store state,
 * plus that a deleted project stops resolving for file ops.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

// Headers + body only; the caller sets `method` (spreading this must not clobber it).
const json = (body) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('project CRUD (eve <-> fake relay)', () => {
  let eve;
  let projDir;

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-projcrud-'));
    eve = await startEve({ projects: [] }); // start with an empty store
  });

  afterAll(async () => {
    if (eve) await eve.stop();
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it('creates a project (stored in the fake relay, cached by eve)', async () => {
    const res = await eve.get('/api/projects', { method: 'POST', ...json({ name: 'Created', path: projDir }) });
    expect([200, 201]).toContain(res.status);
    const created = await res.json();
    expect(created).toMatchObject({ id: expect.any(String), name: 'Created', path: projDir });

    // The fake relay now holds it...
    expect(eve.relay.getProject(created.id)).toMatchObject({ name: 'Created' });
    // ...and eve serves it from cache.
    const list = await (await eve.get('/api/projects')).json();
    expect(list.map((p) => p.id)).toContain(created.id);
  });

  it('edits a project (name change round-trips through eve)', async () => {
    const created = await (await eve.get('/api/projects', { method: 'POST', ...json({ name: 'Before', path: projDir }) })).json();

    const res = await eve.get(`/api/projects/${created.id}`, { method: 'PUT', ...json({ name: 'After', path: projDir }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: created.id, name: 'After' });
    expect(eve.relay.getProject(created.id)).toMatchObject({ name: 'After' });
  });

  it('deletes a project (removed from the store and eve stops resolving it)', async () => {
    const created = await (await eve.get('/api/projects', { method: 'POST', ...json({ name: 'Doomed', path: projDir }) })).json();

    const res = await eve.get(`/api/projects/${created.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(eve.relay.getProject(created.id)).toBeUndefined();

    const list = await (await eve.get('/api/projects')).json();
    expect(list.map((p) => p.id)).not.toContain(created.id);

    // A file op against the deleted project no longer resolves.
    const ws = await eve.connectWs();
    try {
      ws.send({ type: 'list_directory', projectId: created.id, path: '/' });
      const frame = await ws.waitFor((f) => f.type === 'file_error');
      expect(frame.error).toMatch(/not found/i);
    } finally {
      await ws.close();
    }
  });
});
