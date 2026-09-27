const { startEve } = require('./harness');

describe('relay handshake: a test can wait for eve\'s relay leg to be open', () => {
  const HOLD_MS = 500;
  let eve;
  let ws;
  let openedAfterMs;

  beforeAll(async () => {
    eve = await startEve();
    eve.relay.holdRelayHandshake(HOLD_MS);
    ws = await eve.connectWs();
    await eve.relay.waitForRelay();
    const t0 = Date.now();
    await eve.waitForRelayOpen(ws);
    openedAfterMs = Date.now() - t0;
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
  });

  // Without this, a hold that stopped holding would let the test below pass
  // without ever exercising the window.
  it('the held handshake keeps eve\'s side closed after relay sees it', () => {
    expect(openedAfterMs).toBeGreaterThanOrEqual(HOLD_MS - 50);
  });

  it('a frame sent right after the wait reaches relay', async () => {
    ws.send({ type: 'terminal_list' });
    const got = await eve.relay.waitForInbound((f) => f.type === 'terminal_list', 2000);
    expect(got).toMatchObject({ type: 'terminal_list' });
  });
});
