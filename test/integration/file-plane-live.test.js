/**
 * The file-plane conformance table against a real relay (console project only;
 * host projects wait on relay#275). Skipped unless EVE_RELAY_FILES_LIVE=1.
 *
 * How it reaches the routes. Every file route is execute-class and lives on
 * relay's frontend socket only. Eve's own access is a launch identity, which a
 * test process cannot hold. The legitimate door is a control-plane credential
 * (docs/tokens.md in relay), minted at the console, where a presence prompt asks
 * the person there to approve it:
 *
 *   relay credential mint --name eve-files-live --class read --class configure --class execute --ttl 1h
 *   EVE_RELAY_FILES_LIVE=1 EVE_RELAY_FRONTEND_SOCKET=<relay config dir>/frontend.sock \
 *     EVE_RELAY_FILES_TOKEN=<printed token> npx jest -c jest.integration.config.js test/integration/file-plane-live
 *
 * The test registers its own project over POST /api/projects on a temp folder
 * (relay raises a presence prompt for that too, so run it with someone at the
 * console), and removes the project afterwards. Revoke the credential with
 * `relay credential revoke --id <id>`. Nothing in relay's config or gates is
 * changed. `delete` moves the test files into the Trash.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defineFilePlaneConformance, makeRequester } = require('./file-plane-conformance');

const LIVE = process.env.EVE_RELAY_FILES_LIVE === '1';
const PROMPT_WAIT_MS = 150000; // relay's presence prompt expires after 120 s

(LIVE ? describe : describe.skip)('real relay serves the file-plane conformance table', () => {
  let request;
  let projectId;
  let dir;
  const json = (r) => JSON.parse(r.body.toString('utf8'));

  beforeAll(async () => {
    const socketPath = process.env.EVE_RELAY_FRONTEND_SOCKET;
    const token = process.env.EVE_RELAY_FILES_TOKEN;
    if (!socketPath || !token) throw new Error('EVE_RELAY_FRONTEND_SOCKET and EVE_RELAY_FILES_TOKEN are required (see the header of this file)');
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
