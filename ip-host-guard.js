// WebAuthn RP-IDs must be hostnames — a passkey ceremony against
// `https://1.2.3.4` cannot succeed, and Eve's Origin pinning is
// hostname-based — so a bare-IP visit is intercepted early with a pointer to
// the configured hostname instead of failing confusingly mid-login. Active
// only when EVE_PUBLIC_ORIGIN is set; loopback IPs are exempt. WebSocket
// upgrades are guarded separately (ws-origin.js).
const net = require('net');
const { isLoopbackHost } = require('./relay-transport');

function hostOnly(hostHeader) {
  if (!hostHeader) return '';
  const bracket = hostHeader.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1];
  const parts = hostHeader.split(':');
  return parts.length > 2 ? hostHeader : parts[0]; // >2 colons → bare IPv6 literal
}

function isBareIpHost(hostHeader) {
  const host = hostOnly(hostHeader);
  return !!host && net.isIP(host) !== 0 && !isLoopbackHost(host);
}

function ipHostGuard({ origin = null } = {}) {
  return function (req, res, next) {
    if (!origin || !isBareIpHost(req.headers.host || '')) return next();

    const escapedOrigin = origin
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    res.status(421)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Cache-Control', 'no-store')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Use the hostname</title>' +
        '<body style="font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;' +
        'display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">' +
        '<div style="max-width:440px;text-align:center;padding:24px">' +
        '<h1 style="font-size:18px;margin:0 0 8px">Open Eve by name, not by IP</h1>' +
        '<p style="color:#999;font-size:14px;margin:0 0 16px">Passkeys are bound to a hostname, so Eve ' +
        'must be reached at its configured address:</p>' +
        `<p style="font-size:15px"><a href="${escapedOrigin}" style="color:#3b82f6">${escapedOrigin}</a></p></div></body>`
      );
  };
}

module.exports = { ipHostGuard, isBareIpHost, hostOnly };
