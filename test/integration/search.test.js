/**
 * Project search over the WS, end-to-end through the real ripgrep
 * (@vscode/ripgrep) against a real temp project. No relay involved.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('project search (real ripgrep)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-search-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'src', 'a.js'), 'function findMe() { return 1; }\n', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'b.js'), 'const other = 2;\n', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# findMe in docs\n', 'utf8');

    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns matches for a query that exists', async () => {
    ws.send({ type: 'search_project', requestId: 's1', projectId: 'p1', query: 'findMe', options: {} });
    const res = await ws.waitFor((f) => f.type === 'search_results' && f.requestId === 's1', 10000);
    const files = res.matches.map((m) => path.basename(m.file)).sort();
    expect(files).toEqual(expect.arrayContaining(['README.md', 'a.js']));
    expect(res.matches.some((m) => path.basename(m.file) === 'b.js')).toBe(false);
  });

  it('returns an empty result set for a query with no matches', async () => {
    ws.send({ type: 'search_project', requestId: 's2', projectId: 'p1', query: 'zzz_nope_zzz', options: {} });
    const res = await ws.waitFor((f) => f.type === 'search_results' && f.requestId === 's2', 10000);
    expect(res.matches).toEqual([]);
  });

  it('errors on an unknown project', async () => {
    ws.send({ type: 'search_project', requestId: 's3', projectId: 'ghost', query: 'x', options: {} });
    const res = await ws.waitFor((f) => f.type === 'search_error' && f.requestId === 's3');
    expect(res.error).toMatch(/not found/i);
  });
});
