// The traversal check, the XSS-hardening headers and Range live in the route
// itself (routes/index.js), so they need a real Express app to exercise. The
// files come from the fake relay's in-memory file plane through the real
// RelayTransport and RelayFileClient.
const http = require('http');
const express = require('express');
const registerRoutes = require('../../routes/index');
const { RelayTransport } = require('../../relay-transport');
const { NullLogger } = require('../../logger');
const { createFakeRelay } = require('./fake-relay');
const mod = require('../../relay-file-client');

const RelayFileClient = mod.RelayFileClient || mod;

// Express app + fake relay + file client, with `projects` ({id, path, hostId?}) and their trees.
async function bootRoutes({ projects, trees, hosts = [] }) {
  const relay = createFakeRelay({ token: null });
  const relayPort = await relay.listen();
  for (const h of hosts) relay.addHost(h);
  for (const p of projects) relay.addProject({ name: p.id, id: p.id, path: p.path, host_id: p.hostId });
  for (const [id, tree] of Object.entries(trees)) relay.files.seed(id, tree);
  const log = new NullLogger();
  const relayTransport = RelayTransport.fromEnv({ env: { RELAY_FRONTEND_URL: `http://127.0.0.1:${relayPort}`, RELAY_FRONTEND_TOKEN: 't' }, log });
  const files = new RelayFileClient({ relayTransport, log });
  const app = express();
  registerRoutes(app, {
    authService: { isEnrolled: () => false, validateSession: () => false },
    trustedNetwork: { isTrusted: () => false },
    relayTransport: { fetch: async () => ({ status: 200, data: [] }), fetchRaw: async () => ({ status: 404 }) },
    refreshProjectCache: () => {},
    removeFromProjectCache: () => {},
    resolveProject: (id) => projects.find((p) => p.id === id) || null,
    fileServiceFor: (project) => files.forProject(project),
    files,
    ttsService: {}, sttService: {},
    log: null,
  });
  const server = await new Promise((resolve) => { const sv = http.createServer(app).listen(0, () => resolve(sv)); });
  return {
    relay,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      files.close();
      await new Promise((r) => { server.closeAllConnections(); server.close(r); });
      await relay.close();
    },
  };
}

describe('/api/files route hardening', () => {
  let rig;
  let baseUrl;

  beforeAll(async () => {
    rig = await bootRoutes({
      projects: [{ id: 'p1', path: '/work/project' }],
      trees: {
        p1: {
          'note.txt': 'hello',
          'page.html': '<script>alert(1)</script>',
          'pic.png': 'PNGDATA',
          'doc.pdf': '%PDF-1.4',
          'game.html': '<script>1</script>',
          'art.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
          'data.xml': '<?xml version="1.0"?><root/>',
          '.playwright-cli/snap.png': 'PNGDATA',
          'digits.bin': '0123456789',
        },
      },
    });
    rig.relay.files.symlink('p1', 'escape', '/work/project-secrets');
    baseUrl = rig.baseUrl;
  });

  afterAll(async () => { await rig.close(); });

  it('serves an in-project file', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/note.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
  });

  it('answers a Range request on a console project with 206 and the requested bytes', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/digits.bin`, { headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await res.text()).toBe('2345');
  });

  it('answers a suffix Range with the last bytes, and a plain request advertises ranges', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/digits.bin`, { headers: { Range: 'bytes=-3' } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe('789');
    const plain = await fetch(`${baseUrl}/api/files/p1/digits.bin`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('accept-ranges')).toBe('bytes');
    expect(await plain.text()).toBe('0123456789');
  });

  it('answers a Range past the end of the file with 416', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/digits.bin`, { headers: { Range: 'bytes=50-60' } });
    expect(res.status).toBe(416);
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

  it('serves an image inside a dot-directory (regression: dotfiles deny)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/.playwright-cli/snap.png`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('PNGDATA');
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

  // SVG and XML are script-capable (SVG can carry inline <script>), so they must
  // be neutralized exactly like HTML: sandboxed + forced to download, never
  // rendered inline in Eve's origin.
  it('forces SVG to download and sandboxes it (stored-XSS vector)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/art.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('forces XML to download and sandboxes it', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/data.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('does not honor ?preview=1 for SVG or other non-HTML types (only HTML previews inline)', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/art.svg?preview=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");

    const txt = await fetch(`${baseUrl}/api/files/p1/note.txt?preview=1`);
    expect(txt.status).toBe(200);
    expect(txt.headers.get('content-disposition')).toBeNull();
    expect(txt.headers.get('content-security-policy')).toBe("default-src 'none'");
  });

  it('blocks traversal into a sibling dir sharing the project name prefix, without asking relay', async () => {
    const before = rig.relay.files.requests.length;
    // %2e%2e keeps Express from collapsing ../ before our handler sees it.
    const res = await fetch(`${baseUrl}/api/files/p1/..%2fproject-secrets%2fsecret.env`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/traversal/i);
    expect(rig.relay.files.requests.length).toBe(before);
  });

  it('refuses a file reached through a symlink', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/escape/secret.env`);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('topsecret');
  });

  it('returns 404 for a missing file', async () => {
    const res = await fetch(`${baseUrl}/api/files/p1/missing.txt`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown project', async () => {
    const res = await fetch(`${baseUrl}/api/files/nope/note.txt`);
    expect(res.status).toBe(404);
  });
});

// A host project has no local path Express can sendFile: the route streams it
// from relay, chunked, with the same CSP/disposition rules by extension, and a
// host answers Range with the whole file.
describe('/api/files route on a host project', () => {
  let rig;

  beforeAll(async () => {
    rig = await bootRoutes({
      hosts: [{ id: 'host1', name: 'testbox' }],
      projects: [{ id: 'h1', path: '/srv/app', hostId: 'host1' }],
      trees: { h1: { 'note.txt': 'hello from the host', 'page.html': '<script>1</script>', 'digits.bin': '0123456789' } },
    });
  });

  afterAll(async () => { await rig.close(); });

  it('streams the file content, with a content-type from the extension', async () => {
    const res = await fetch(`${rig.baseUrl}/api/files/h1/note.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('hello from the host');
  });

  it('answers a Range request with the whole file and status 200', async () => {
    const res = await fetch(`${rig.baseUrl}/api/files/h1/digits.bin`, { headers: { Range: 'bytes=2-5' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('0123456789');
  });

  it('sets the same download/sandbox rules as a console HTML file', async () => {
    const res = await fetch(`${rig.baseUrl}/api/files/h1/page.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/^attachment/);
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('maps a missing file to 404', async () => {
    const res = await fetch(`${rig.baseUrl}/api/files/h1/missing.txt`);
    expect(res.status).toBe(404);
  });

  it('maps traversal to 403 without asking relay', async () => {
    const before = rig.relay.files.requests.length;
    const res = await fetch(`${rig.baseUrl}/api/files/h1/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
    expect(rig.relay.files.requests.length).toBe(before);
  });
});
