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
const FileService = require('../../file-service');

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
    fs.writeFileSync(path.join(projectDir, 'doc.pdf'), '%PDF-1.4', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'game.html'), '<script>1</script>', 'utf8');
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
      fileService: new FileService(),
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

  it('sets nosniff and a locked-down (non-sandbox) CSP on inert files', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/note.txt`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  it('forces HTML to download and sandboxes it (no inline render in Eve origin)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('serves images inline (no attachment disposition)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/pic.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
  });

  it('serves PDFs inline without the sandbox directive (native viewer needs it)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/doc.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  it('renders HTML inline with a script-sandbox CSP under ?preview=1', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/game.html?preview=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
  });

  it('ignores ?preview=1 for non-HTML types (still locked down)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/note.txt?preview=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'");
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
