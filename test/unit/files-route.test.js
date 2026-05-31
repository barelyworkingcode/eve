/**
 * Integration test for the hardened `/api/files/:projectId/*` route.
 * The traversal check and the XSS-hardening headers live in the route itself
 * (routes/index.js), so they need a real Express app to exercise.
 * See docs/security-audit-frontend.md (H1, H2).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const registerRoutes = require('../../routes/index');

describe('/api/files route hardening', () => {
  let server, baseUrl, projectDir, siblingDir;

  beforeAll((done) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-files-route-'));
    projectDir = path.join(tmp, 'project');
    siblingDir = path.join(tmp, 'project-secrets'); // shared "project" name prefix
    fs.mkdirSync(projectDir);
    fs.mkdirSync(siblingDir);
    fs.writeFileSync(path.join(projectDir, 'note.txt'), 'hello', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'page.html'), '<script>alert(1)</script>', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'pic.png'), 'PNGDATA', 'utf8');
    fs.writeFileSync(path.join(siblingDir, 'secret.env'), 'API_KEY=topsecret', 'utf8');

    const app = express();
    const project = { id: 'p1', path: projectDir };
    registerRoutes(app, {
      authService: { isEnrolled: () => false, validateSession: () => false },
      trustedNetwork: { isTrusted: () => false },
      relayTransport: { fetch: async () => ({ status: 200, data: [] }), fetchRaw: async () => ({ status: 404 }) },
      refreshProjectCache: () => {},
      removeFromProjectCache: () => {},
      resolveProject: (id) => (id === 'p1' ? project : null),
      ttsService: {}, sttService: {}, moduleService: {},
      log: null,
    });

    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  it('serves an in-project file', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/note.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('sets nosniff and a sandbox CSP on served files', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/note.txt`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('forces HTML to download (no inline render in Eve origin)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('serves images inline (no attachment disposition)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/pic.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('blocks traversal into a sibling dir sharing the project name prefix', async () => {
    // %2e%2e keeps Express from collapsing ../ before our handler sees it.
    const res = await fetch(`${baseUrl}/api/files/p1/..%2fproject-secrets%2fsecret.env`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/traversal/i);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await fetch(`${baseUrl}/api/files/nope/note.txt`);
    expect(res.status).toBe(404);
  });
});
