/**
 * The file-plane conformance table against a real relay (console project only;
 * host projects wait on relay#275). Not collected by any jest config: run it with
 * `node test/integration/file-plane-live.js`, which explains the setup.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineFilePlaneConformance, makeRequester } = require('./file-plane-conformance');

const PROMPT_WAIT_MS = 150000; // relay's presence prompt expires after 120 s

describe('real relay serves the file-plane conformance table', () => {
  let request;
  let projectId;
  let dir;
  const json = (r) => JSON.parse(r.body.toString('utf8'));

  beforeAll(async () => {
    const socketPath = process.env.EVE_RELAY_FRONTEND_SOCKET;
    const token = process.env.EVE_RELAY_FILES_TOKEN;
    if (!socketPath || !token) throw new Error('EVE_RELAY_FRONTEND_SOCKET and EVE_RELAY_FILES_TOKEN are required (see `node test/integration/file-plane-live.js`)');
    request = makeRequester({ socketPath, token });
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-files-live-')));
    const res = await request('POST', '/api/projects', { json: { name: `Acme files live ${path.basename(dir)}`, path: dir } });
    if (res.status !== 201) throw new Error(`POST /api/projects answered ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
    projectId = json(res).id;
  }, PROMPT_WAIT_MS);

  afterAll(async () => {
    if (projectId) await request('DELETE', `/api/projects/${projectId}`);
    // Guard: only a folder this test made, and never an empty path, is removed.
    if (dir && path.basename(dir).startsWith('eve-files-live-')) fs.rmSync(dir, { recursive: true, force: true });
  });

  const wipe = () => { for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true }); };

  defineFilePlaneConformance({
    request: (...args) => request(...args),
    get projectId() { return projectId; },
    async seed(tree) {
      wipe();
      for (const [key, value] of Object.entries(tree)) {
        const full = path.join(dir, key);
        fs.mkdirSync(key.endsWith('/') || value === null ? full : path.dirname(full), { recursive: true });
        if (!key.endsWith('/') && value !== null) fs.writeFileSync(full, value);
      }
    },
    async symlink(rel, target) { fs.symlinkSync(target, path.join(dir, rel)); },
    async setReadOnly(on) {
      const res = await request('PUT', `/api/projects/${projectId}`, { json: { files_read_only: on } });
      if (res.status !== 200) throw new Error(`PUT files_read_only answered ${res.status}`);
    },
  });
});
