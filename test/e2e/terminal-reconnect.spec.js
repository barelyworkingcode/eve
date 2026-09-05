// relayLLM sends terminal_output only to connections it registered as viewers,
// but accepts terminal_input for any terminal by id. A browser reconnect builds
// a fresh upstream connection with an empty viewer set, so a pane that survived
// the drop used to keep typing into the live PTY and never receive another byte
// — it looked frozen, and only a reload brought it back. Nothing below asserts
// on rendering: the bug was a missing subscription, not a missing repaint.
const { test, expect } = require('./fixtures');
const { relayFrames } = require('../integration/protocol');

const TERM = 't-reconnect';
const LIST_REPLY = {
  terminals: [{ id: TERM, templateId: 'zsh', name: 'shell', directory: '/fake', state: 'running' }],
};

const countInbound = (eve, type) => eve.relay.inbound.filter((f) => f.type === type).length;

async function openTerminal(page, eve) {
  await eve.relay.waitForRelay();
  eve.relay.emitToRelay(relayFrames.terminalCreated({ terminalId: TERM, name: 'shell' }));
  await expect
    .poll(() => page.evaluate((id) => window.client.terminalManager.activeTerminalId === id, TERM))
    .toBe(true);
}

// The grid xterm holds, which is what a missing subscription starves — read it
// directly rather than through the DOM so a paint quirk can't mask the result.
const gridText = (page) =>
  page.evaluate((id) => {
    const term = window.client.terminalManager.terminals.get(id).term;
    const buf = term.buffer.active;
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) out += line.translateToString(true).trim();
    }
    return out;
  }, TERM);

// A reconnect re-runs onWebSocketReady, which asks for the terminal list.
// Answering it is where the story used to end: every id was already held
// locally, so nothing re-joined.
async function reconnectAndAnswerList(page, eve) {
  const listsBefore = countInbound(eve, 'terminal_list');
  await page.evaluate(() => window.client.wsClient.forceReconnect());
  await expect.poll(() => countInbound(eve, 'terminal_list')).toBeGreaterThan(listsBefore);
  eve.relay.emitToRelay(relayFrames.terminalList(LIST_REPLY));
}

test('a terminal keeps receiving output after the socket drops and reconnects', async ({ page, eve }) => {
  await openTerminal(page, eve);

  eve.relay.emitToRelay(relayFrames.terminalOutput({ terminalId: TERM, data: 'BEFORE' }));
  await expect.poll(() => gridText(page)).toContain('BEFORE');

  // A first connect never sends terminal_reconnect, so any of these frames is
  // the re-join under test.
  expect(countInbound(eve, 'terminal_reconnect')).toBe(0);

  await reconnectAndAnswerList(page, eve);

  // The regression guard: the client must re-subscribe rather than assume the
  // server still remembers it.
  const rejoin = await eve.relay.waitForInbound((f) => f.type === 'terminal_reconnect');
  expect(rejoin.terminalId).toBe(TERM);

  // And output must actually flow again, end to end.
  eve.relay.emitToRelay(relayFrames.terminalJoined({ terminalId: TERM, name: 'shell', scrollback: 'BEFORE' }));
  eve.relay.emitToRelay(relayFrames.terminalOutput({ terminalId: TERM, data: 'AFTER' }));
  await expect.poll(() => gridText(page)).toContain('AFTER');
});

test('a re-join replay replaces the screen instead of stacking a second copy', async ({ page, eve }) => {
  await openTerminal(page, eve);

  eve.relay.emitToRelay(relayFrames.terminalOutput({ terminalId: TERM, data: 'ONCE' }));
  await expect.poll(() => gridText(page)).toContain('ONCE');

  await reconnectAndAnswerList(page, eve);
  await eve.relay.waitForInbound((f) => f.type === 'terminal_reconnect');

  eve.relay.emitToRelay(relayFrames.terminalJoined({ terminalId: TERM, name: 'shell', scrollback: 'ONCE' }));

  await expect.poll(() => gridText(page)).toContain('ONCE');
  expect((await gridText(page)).match(/ONCE/g)).toHaveLength(1);
});
