/**
 * Record-and-verify against a LIVE relay — the keystone that makes the whole
 * mock layer trustworthy. It drives the running eve (default http://localhost:3000,
 * loopback-trusted so no passkey), creates a throwaway session, sends a trivial
 * prompt, captures the REAL relay→eve frames, and asserts each conforms to
 * protocol.js. If relayLLM changes a frame shape, this is what catches it — the
 * fake's frames pass the same validateRelayFrame, so the fake can't be trusted
 * beyond what this confirms.
 *
 * Skipped by default (non-hermetic, hits a real LLM). Run with:
 *   EVE_CONTRACT=1 npm run test:integration -- contract-live
 * Optional: EVE_BASE_URL (default http://localhost:3000), EVE_CONTRACT_MODEL
 * (default 'haiku'), EVE_CONTRACT_DIR (default '/tmp').
 */
const WebSocket = require('ws');
const { validateRelayFrame, extractAssistantText } = require('./protocol');

const RUN = process.env.EVE_CONTRACT === '1';
const BASE = process.env.EVE_BASE_URL || 'http://localhost:3000';
const MODEL = process.env.EVE_CONTRACT_MODEL || 'haiku';
const DIR = process.env.EVE_CONTRACT_DIR || '/tmp';

function liveClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const frames = [];
  const waiters = [];
  const deliver = (f) => {
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
    }
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === '__batch' && Array.isArray(m.msgs)) m.msgs.forEach(deliver);
    else deliver(m);
  });
  return {
    frames,
    ready: () => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (pred, ms = 30000) => new Promise((res, rej) => {
      const e = frames.find(pred);
      if (e) return res(e);
      const t = setTimeout(() => rej(new Error('waitFor: timed out')), ms);
      waiters.push({ pred, resolve: (f) => { clearTimeout(t); res(f); } });
    }),
    close: () => new Promise((r) => { ws.once('close', r); ws.close(); }),
  };
}

(RUN ? describe : describe.skip)('relay contract — record & verify (live)', () => {
  it('every real relay->eve frame conforms to protocol.js', async () => {
    const wsUrl = BASE.replace(/^http/, 'ws') + '/ws';
    const client = liveClient(wsUrl);
    await client.ready();

    client.send({ type: 'create_session', directory: DIR, model: MODEL });
    const created = await client.waitFor((f) => f.type === 'session_created' || f.type === 'error', 20000);
    if (created.type === 'error') throw new Error(`create_session failed: ${created.message}`);
    const sessionId = created.sessionId;

    try {
      client.send({ type: 'user_input', text: 'Reply with exactly the single word: hi', sessionId });
      await client.waitFor((f) => f.type === 'message_complete' && f.sessionId === sessionId, 60000);

      // Validate every frame of a type we claim to model.
      const MODELED = new Set(['session_joined', 'llm_event', 'message_complete', 'error']);
      const seen = client.frames.filter((f) => MODELED.has(f.type));
      const failures = seen
        .map((f) => ({ type: f.type, result: validateRelayFrame(f), frame: f }))
        .filter((x) => !x.result.ok);

      if (failures.length) {
        // Surface the drift loudly — this is the whole point of the test.
        // eslint-disable-next-line no-console
        console.error('RELAY CONTRACT DRIFT:\n' + failures.map((x) =>
          `  ${x.type}: ${x.result.errors.join('; ')}\n    frame=${JSON.stringify(x.frame).slice(0, 300)}`).join('\n'));
      }
      expect(failures.map((x) => `${x.type}: ${x.result.errors.join(', ')}`)).toEqual([]);

      // And at least one assistant llm_event must yield text via our extractor.
      const texts = client.frames.filter((f) => f.type === 'llm_event').map(extractAssistantText).filter(Boolean);
      expect(texts.length).toBeGreaterThan(0);
    } finally {
      client.send({ type: 'delete_session', sessionId });
      await new Promise((r) => setTimeout(r, 500));
      await client.close();
    }
  }, 90000);
});
