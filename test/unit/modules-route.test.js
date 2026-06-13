/**
 * Integration test for the module routes (routes/modules.js). The SERVE_MIME
 * allowlist, the 403 traversal/symlink mapping, and the no-store/nosniff
 * headers live in the route + ModuleService, so they need a real Express app.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { register } = require('../../routes/modules');
const ModuleService = require('../../module-service');

describe('module routes', () => {
  let server;
  let baseUrl;
  let projectDir;
  let symlinksSupported = true;

  beforeAll((done) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-modules-route-'));
    projectDir = path.join(tmp, 'project');
    const modDir = path.join(projectDir, 'modules', 'demo');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'module.json'), JSON.stringify({
      displayName: 'Demo', entry: 'index.html', permissions: { files: ['data/notes.txt'] },
    }), 'utf8');
    fs.writeFileSync(path.join(modDir, 'index.html'), '<h1>hi</h1>', 'utf8');
    fs.writeFileSync(path.join(modDir, 'style.css'), 'body{}', 'utf8');
    fs.writeFileSync(path.join(modDir, 'data.bin'), 'BINARY', 'utf8'); // disallowed type
    fs.writeFileSync(path.join(projectDir, 'secret.txt'), 'TOP SECRET', 'utf8'); // outside the module

    // Symlink inside the module pointing outside it (escape attempt).
    try {
      fs.writeFileSync(path.join(tmp, 'outside.html'), '<b>leak</b>', 'utf8');
      fs.symlinkSync(path.join(tmp, 'outside.html'), path.join(modDir, 'leak.html'));
    } catch { symlinksSupported = false; }

    const app = express();
    const project = { id: 'p1', path: projectDir };
    register(app, {
      requireAuth: (req, res, next) => next(),
      moduleService: new ModuleService(),
      resolveProject: (id) => (id === 'p1' ? project : null),
      log: null,
    });

    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  describe('static serve', () => {
    it('serves the manifest entry at the module root with no-store + nosniff', async () => {
      const res = await fetch(`${baseUrl}/api/modules/serve/p1/demo/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toBe('<h1>hi</h1>');
    });

    it('serves a CSS asset with the right mime', async () => {
      const res = await fetch(`${baseUrl}/api/modules/serve/p1/demo/style.css`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/css/);
    });

    it('rejects a file type not in the SERVE_MIME allowlist with 415', async () => {
      const res = await fetch(`${baseUrl}/api/modules/serve/p1/demo/data.bin`);
      expect(res.status).toBe(415);
      const body = await res.json();
      expect(body.error).toMatch(/Disallowed file type/);
    });

    it('returns 403 on a path traversal out of the module folder', async () => {
      const res = await fetch(`${baseUrl}/api/modules/serve/p1/demo/..%2f..%2fsecret.txt`);
      expect(res.status).toBe(403);
    });

    it('returns 403 on a symlink that escapes the module folder', async () => {
      if (!symlinksSupported) return;
      const res = await fetch(`${baseUrl}/api/modules/serve/p1/demo/leak.html`);
      expect(res.status).toBe(403);
    });

    it('returns 404 for an unknown project', async () => {
      const res = await fetch(`${baseUrl}/api/modules/serve/nope/demo/index.html`);
      expect(res.status).toBe(404);
    });

    it('returns 404 when the module manifest is missing', async () => {
      const res = await fetch(`${baseUrl}/api/modules/serve/p1/ghost/`);
      expect(res.status).toBe(404);
    });
  });

  describe('list + manifest', () => {
    it('lists modules for a project', async () => {
      const res = await fetch(`${baseUrl}/api/modules?projectId=p1`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.modules.map(m => m.name)).toContain('demo');
    });

    it('400s when projectId is missing from the list query', async () => {
      const res = await fetch(`${baseUrl}/api/modules`);
      expect(res.status).toBe(400);
    });

    it('returns a single module public view', async () => {
      const res = await fetch(`${baseUrl}/api/modules/p1/demo`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ name: 'demo', displayName: 'Demo', entry: 'index.html' });
      // publicView must not leak internal manifest internals beyond the contract.
      expect(body.permissions.files).toEqual(['data/notes.txt']);
    });

    it('404s a single-module request for an unknown project', async () => {
      const res = await fetch(`${baseUrl}/api/modules/nope/demo`);
      expect(res.status).toBe(404);
    });
  });
});
