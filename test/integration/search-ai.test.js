/**
 * Search AI summarize — the `__search:` hidden ephemeral session (sibling of
 * `__module:`). The fake relay streams the summary; eve intercepts the hidden
 * session and surfaces it as `search_ai_*` frames (never plain llm_event), then
 * deletes the session.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('search AI summarize (__search: hidden session)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-searchai-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('summarizes without leaking the hidden session into chat, then cleans it up', async () => {
    ws.send({
      type: 'search_ai_summarize',
      requestId: 'sum1',
      projectId: 'p1',
      query: 'findMe',
      matches: [{ file: 'src/a.js', lineNumber: 1, lineText: 'function findMe() {}' }],
    });

    const started = await ws.waitFor((f) => f.type === 'search_ai_started' && f.requestId === 'sum1');
    expect(started.sessionId).toMatch(/^sess-/);

    await ws.waitFor((f) => f.type === 'search_ai_completed' && f.requestId === 'sum1');

    // Hidden-session frames surfaced as search_ai_event, never plain llm_event.
    expect(ws.frames.some((f) => f.type === 'search_ai_event')).toBe(true);
    expect(ws.frames.some((f) => f.type === 'llm_event')).toBe(false);

    expect(eve.relay.requests).toContainEqual({ method: 'DELETE', path: `/api/sessions/${started.sessionId}` });
  });
});
