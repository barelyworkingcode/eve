// Anti-CSWSH: WebSocket upgrades aren't subject to same-origin/CORS the way
// fetch() is — any page can open `new WebSocket("ws://eve.host")` from a
// victim's browser, and since the WS protocol exposes terminal I/O and file
// read/write, an authenticated socket opened that way is a path to RCE.
// Reject the upgrade when a browser presents a cross-site Origin.
// See docs/security-audit-frontend.md (C1).
//
//  - No Origin header      → non-browser client; not a CSWSH vector (no
//    victim browser is being ridden). Still faces the token/subnet gate
//    downstream.
//  - Loopback Origin       → always allowed. A browser only sends a loopback
//    Origin for a page actually served from the box itself — unforgeable by
//    a remote attacker in a victim's browser. A forged one from a remote IP
//    still dies at the token/subnet gate (source IP is unchanged).
//  - EVE_PUBLIC_ORIGIN set → Origin must equal it exactly.
//  - Otherwise             → same-origin check: Origin and Host are both
//    forbidden headers a page can't forge, so `Origin.host === Host` is true
//    only for a genuine same-origin page.

const { isLoopbackHost: relayIsLoopbackHost } = require('./relay-transport');

function parsePublicOrigin(env = process.env) {
  const raw = env.EVE_PUBLIC_ORIGIN;
  return raw && raw.trim() ? raw.trim() : null;
}

// Re-exported from relay-transport so all loopback checks in the codebase
// use one exact (not substring) definition.
const isLoopbackHost = relayIsLoopbackHost;

function isAllowedWsOrigin(req, { publicOrigin = null } = {}) {
  const origin = req?.headers?.origin;
  if (!origin) return true;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // malformed Origin — a real browser never sends this
  }

  if (isLoopbackHost(parsed.hostname)) return true;

  if (publicOrigin) return origin === publicOrigin;

  const host = req?.headers?.host || '';
  return !!host && parsed.host === host.toLowerCase();
}

module.exports = { isAllowedWsOrigin, parsePublicOrigin, isLoopbackHost };
