/**
 * Project search over the WS, end to end through eve to the fake relay's
 * in-memory file plane (relay does the searching).
 * Waits: a held search is parked when holdNext('search').arrived resolves;
 * "no results frame for the cancelled search" is asserted only after the next
 * search's results arrived, which proves the window closed.
 */
const { startEve } = require('./harness');

describe('project search', () => {
  let eve;
  let ws;

  beforeAll(async () => {
    eve = await startEve({
      projects: [{ id: 'p1', name: 'T', path: '/work/acme' }],
      files: {
        p1: {
          'src/a.js': 'function findMe() { return 1; }\n',
          'src/b.js': 'const other = 2;\n',
          'README.md': '# findMe in docs\n',
        },
      },
    });
    ws = await eve.connectWs();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
  });

  it('returns matches in the browser shape for a query that exists', async () => {
    ws.send({ type: 'search_project', requestId: 's1', projectId: 'p1', query: 'findMe', options: {} });
    const res = await ws.waitFor((f) => f.type === 'search_results' && f.requestId === 's1');
    expect(res.projectId).toBe('p1');
    expect(res.truncated).toBe(false);
    expect(typeof res.durationMs).toBe('number');
    expect(res.matches.map((m) => m.file).sort()).toEqual(['README.md', 'src/a.js']);
    const hit = res.matches.find((m) => m.file === 'src/a.js');
    expect(hit).toEqual({ file: 'src/a.js', lineNumber: 1, lineText: 'function findMe() { return 1; }', submatches: [{ start: 9, end: 15 }] });
  });

  it('returns an empty result set for a query with no matches', async () => {
    ws.send({ type: 'search_project', requestId: 's2', projectId: 'p1', query: 'zzz_nope_zzz', options: {} });
    const res = await ws.waitFor((f) => f.type === 'search_results' && f.requestId === 's2');
    expect(res.matches).toEqual([]);
  });

  it('errors on an unknown project', async () => {
    ws.send({ type: 'search_project', requestId: 's3', projectId: 'ghost', query: 'x', options: {} });
    const res = await ws.waitFor((f) => f.type === 'search_error' && f.requestId === 's3');
    expect(res.error).toMatch(/not found/i);
  });

  it('errors on an empty query with relay\'s refusal text', async () => {
    ws.send({ type: 'search_project', requestId: 's4', projectId: 'p1', query: '', options: {} });
    const res = await ws.waitFor((f) => f.type === 'search_error' && f.requestId === 's4');
    expect(res.error).toBe('Search query is empty');
  });

  it('search_cancel ends a search in flight: its answer never reaches the browser', async () => {
    const held = eve.relay.files.holdNext('search');
    const from = ws.mark();
    ws.send({ type: 'search_project', requestId: 'cancelled', projectId: 'p1', query: 'findMe', options: {} });
    await held.arrived;
    ws.send({ type: 'search_cancel', requestId: 'cancelled' });
    held.release();
    // The next search's answer closes the window: it starts after the cancelled one was released.
    ws.send({ type: 'search_project', requestId: 'next', projectId: 'p1', query: 'other', options: {} });
    await ws.waitFor((f) => f.type === 'search_results' && f.requestId === 'next', 5000, from);
    expect(ws.frames.slice(from).some((f) => f.requestId === 'cancelled')).toBe(false);
  });
});
