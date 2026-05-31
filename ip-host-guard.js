/**
 * Refuse browser access to Eve by a bare IP address.
 *
 * WebAuthn RP-IDs must be hostnames — a passkey ceremony against `https://1.2.3.4`
 * cannot succeed — and Eve's Origin pinning is hostname-based. Rather than let an
 * IP visit fail in a confusing way mid-login, this middleware intercepts it early
 * and points the user at the configured hostname(s).
 *
 * Active only when a canonical origin is configured (EVE_PUBLIC_ORIGIN). Loopback
 * IPs are exempt so same-host tooling/health checks keep working. WebSocket
 * upgrades are guarded separately by the Origin check (ws-origin.js).
 */
const net = require('net');
const { isLoopbackHost } = require('./relay-transport');

/** Extract the host portion (no port) from a Host header, handling [IPv6]:port. */
function hostOnly(hostHeader) {
  if (!hostHeader) return '';
  const bracket = hostHeader.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1];
  const parts = hostHeader.split(':');
  return parts.length > 2 ? hostHeader : parts[0]; // >2 colons → bare IPv6 literal
}

/** True if this request addresses Eve by a non-loopback bare IP. */
function isBareIpHost(hostHeader) {
  const host = hostOnly(hostHeader);
  return !!host && net.isIP(host) !== 0 && !isLoopbackHost(host);
}

function ipHostGuard({ origin = null } = {}) {
  return function (req, res, next) {
    if (!origin || !isBareIpHost(req.headers.host || '')) return next();

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
        `<p style="font-size:15px"><a href="${origin}" style="color:#3b82f6">${origin}</a></p></div></body>`
      );
  };
}

module.exports = { ipHostGuard, isBareIpHost, hostOnly };
