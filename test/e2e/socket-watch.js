// Page-side record of eve's socket. `sent`: every frame the page sends, pushed inside
// send(), so it is complete once the action that sends has returned. `handled`: every
// frame after the app dispatched it (this listener is added after the app's onmessage,
// which dispatches synchronously). Re-install after a reload or reconnect; it resets both lists.
async function watchSocket(page) {
  await page.evaluate(() => {
    window.__sock = { sent: [], handled: [] };
    if (!WebSocket.prototype.send.__watch) {
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { try { window.__sock.sent.push(JSON.parse(d)); } catch {} return send.call(this, d); };
      WebSocket.prototype.send.__watch = true;
    }
    const ws = window.client.wsClient.ws;
    if (ws.__watch) return;
    ws.__watch = true;
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') return;
      const d = JSON.parse(e.data);
      window.__sock.handled.push(...(d.type === '__batch' ? d.msgs : [d]));
    });
  });
}

const sentFrames = (page) => page.evaluate(() => window.__sock.sent);
const sentTypes = async (page) => (await sentFrames(page)).map((f) => f.type);

const waitHandled = (page, { type, sessionId }) => page.waitForFunction(
  ({ type, sessionId }) => window.__sock.handled.some((f) => f.type === type && (!sessionId || f.sessionId === sessionId)),
  { type, sessionId });

module.exports = { watchSocket, sentFrames, sentTypes, waitHandled };
