/**
 * WebSocket upgrade Origin check — anti-CSWSH.
 *
 * WebSocket connections are NOT subject to the same-origin policy or CORS the
 * way fetch() is: any web page can open `new WebSocket("ws://eve.host")` from a
 * victim's browser, and if that browser sits on a trusted subnet (or auth is
 * disabled) the socket would be authenticated with no token. Because the WS
 * protocol exposes terminal I/O (= shell) and file read/write, that is a path
 * to RCE. See docs/security-audit-frontend.md (C1).
 *
 * Defense: reject the upgrade when a browser presents a cross-site Origin.
 *
 *  - No Origin header  → non-browser client (CLI, native socket). Not a CSWSH
 *    vector (no victim browser is being ridden); it still faces the token /
 *    subnet auth gate downstream. Allowed here.
 *  - EVE_PUBLIC_ORIGIN set → the Origin must equal it exactly (use behind a
 *    proxy whose external origin differs from the Host Eve sees).
 *  - Otherwise → same-origin check. A browser sets BOTH Origin and Host itself
 *    and page script cannot forge either (both are forbidden headers), so
 *    `Origin.host === Host` is true only for a genuine same-origin page.
 */

/** Eve's canonical origin from EVE_PUBLIC_ORIGIN, or null if unset. */
function parsePublicOrigin(env = process.env) {
  const raw = env.EVE_PUBLIC_ORIGIN;
  return raw && raw.trim() ? raw.trim() : null;
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {object} [opts]
 * @param {string|null} [opts.publicOrigin] - from parsePublicOrigin()
 * @returns {boolean} true if the upgrade may proceed
 */
function isAllowedWsOrigin(req, { publicOrigin = null } = {}) {
  const origin = req?.headers?.origin;
  if (!origin) return true; // non-browser client — not a cross-site hijack

  if (publicOrigin) return origin === publicOrigin;

  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // malformed Origin — a real browser never sends this
  }
  const host = req?.headers?.host || '';
  return !!host && parsed.host === host;
}

module.exports = { isAllowedWsOrigin, parsePublicOrigin };
