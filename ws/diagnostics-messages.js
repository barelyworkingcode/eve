/**
 * Diagnostics message descriptor — the iOS app's native-relayClient audio
 * cold-start / background-survival trace, collected without a USB cable. See
 * ws/message-registry.js for the registry this is registered into.
 *
 * This arm is not `await`ed in today's switch, so its descriptor may not be
 * `async` — see C2 in ws/message-registry.js. `req` is per-connection and is
 * therefore reached only through `ctx.req` at call time, never captured — see
 * C1 in ws/message-registry.js.
 */
const fs = require('fs');
const path = require('path');

// Device diagnostics (relayClient native audio): the iOS app streams its
// cold-start / background-survival trace here as { type:'device_log', line|lines }
// so it can be collected with no USB cable. Appended to a file for tailing.
const DEVICE_LOG_PATH = process.env.EVE_DEVICE_LOG_PATH || path.join(__dirname, '..', 'relay-device.log');

function appendDeviceLog(message, req) {
  try {
    const lines = Array.isArray(message.lines)
      ? message.lines
      : (typeof message.line === 'string' ? [message.line] : []);
    if (!lines.length) return;
    const recv = new Date().toISOString();
    const src = (req && req.socket && req.socket.remoteAddress) || '?';
    const text = lines
      .map((l) => `${recv} ${src} ${typeof l === 'string' ? l : JSON.stringify(l)}`)
      .join('\n') + '\n';
    fs.appendFile(DEVICE_LOG_PATH, text, () => {});
  } catch (_) { /* diagnostics must never break the socket */ }
}

module.exports = [
  {
    type: 'device_log',
    handle(ctx) {
      appendDeviceLog(ctx.message, ctx.req);
    },
  },
];
