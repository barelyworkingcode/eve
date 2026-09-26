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
  // The replay replaces the screen rather than stacking a second copy.
  expect((await gridText(page)).match(/BEFORE/g)).toHaveLength(1);
});

// xterm loads through a dynamic import, so eve can forward a terminal_created
// before the browser can build a terminal for it. The gate parks xterm's
// module request until the test has seen that frame land in the browser.
const EARLY = 't-early';

const heldXtermTest = test.extend({
  xtermGate: async ({}, use) => {
    const gate = {};
    gate.held = new Promise((resolve) => { gate.markHeld = resolve; });
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    gate.frameSeen = new Promise((resolve) => { gate.markFrameSeen = resolve; });
    await use(gate);
    gate.release();
  },
  context: async ({ context, xtermGate }, use) => {
    await context.route('**/xterm/lib/xterm.mjs', async (route) => {
      xtermGate.markHeld();
      await xtermGate.released;
      // A failing run closes the context with this request still parked.
      await route.continue().catch(() => {});
    });
    context.on('page', (p) => p.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      let frame;
      try { frame = JSON.parse(payload); } catch { return; }
      if (frame.type === 'terminal_created' && frame.terminalId === EARLY) xtermGate.markFrameSeen();
    })));
    await use(context);
  },
});

heldXtermTest('a terminal created before xterm finishes loading still opens', async ({ page, eve, xtermGate }) => {
  await eve.relay.waitForRelay();
  await xtermGate.held;

  eve.relay.emitToRelay(relayFrames.terminalCreated({ terminalId: EARLY, name: 'shell' }));
  await xtermGate.frameSeen;
  xtermGate.release();

  await expect
    .poll(() => page.evaluate((id) => window.client.terminalManager.activeTerminalId === id, EARLY))
    .toBe(true);
  // A project-less terminal never renders into the project-filtered tab bar,
  // so the tab model is the observable.
  await expect
    .poll(() => page.evaluate((id) =>
      window.client.tabManager.tabs.some((t) => t.id === id && t.type === 'terminal'), EARLY))
    .toBe(true);
});
