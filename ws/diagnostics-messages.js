const fs = require('fs');
const path = require('path');

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
