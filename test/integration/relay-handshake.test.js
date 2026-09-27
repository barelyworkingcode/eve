const { startEve } = require('./harness');

describe('relay handshake: a test can wait for eve\'s relay leg to be open', () => {
  let eve;
  let ws;

  beforeAll(async () => {
    eve = await startEve();
    eve.relay.holdRelayHandshake(500);
    ws = await eve.connectWs();
    await eve.waitForRelayOpen(ws);
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
  });

  it('a frame sent right after the wait reaches relay', async () => {
    ws.send({ type: 'terminal_list' });
    const got = await eve.relay.waitForInbound((f) => f.type === 'terminal_list', 2000);
    expect(got).toMatchObject({ type: 'terminal_list' });
  });
});
