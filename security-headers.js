/**
 * Security response headers for the Browser ↔ Eve boundary.
 *
 * Two layers:
 *   1. `securityHeaders()` — a global middleware setting headers that are safe
 *      on every response (nosniff, frame-options, referrer-policy, COOP, and
 *      HSTS when the connection is TLS).
 *   2. `shellCsp()` — the strict Content-Security-Policy applied ONLY to the
 *      main application HTML document (the page that runs Eve's own JS). It is
 *      deliberately NOT applied to:
 *        - module iframes (AI-authored inline scripts; isolated by the iframe
 *          sandbox / opaque origin, which is the real trust boundary),
 *        - the standalone `/api/auth/safari-login` page (its own inline script),
 *        - `/api/files/*` (sets its own `default-src 'none'; sandbox`).
 *
 * The shell CSP pins the two inline bootstrap scripts in index.html by
 * SHA-256 hash so we avoid `'unsafe-inline'` for scripts entirely. WASM
 * compilation (onnxruntime / transformers / vad) needs `'wasm-unsafe-eval'`,
 * and Monaco / ML workers need `blob:` worker sources — both are strictly
 * narrower than `'unsafe-eval'`.
 *
 * See docs/security-audit-frontend.md (C3).
 */
const crypto = require('crypto');

/**
 * Compute CSP `'sha256-...'` source tokens for every INLINE <script> block
 * (i.e. <script> with no src attribute) in an HTML string. The hash is taken
 * over the exact text content between the tags, which is what the browser
 * hashes. The cache-bust rewrite in server.js only touches `<script src=...>`
 * tags, so inline bodies are byte-stable across the transform.
 */
function computeInlineScriptHashes(html) {
  const hashes = [];
  const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue; // external script, not inline
    const body = m[2];
    const digest = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

/**
 * Build the strict CSP string for the app shell.
 * @param {string[]} scriptHashes - inline-script hash tokens from computeInlineScriptHashes
 */
function buildShellCsp(scriptHashes = []) {
  const scriptSrc = ["'self'", "'wasm-unsafe-eval'", 'blob:', ...scriptHashes].join(' ');
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' ws: wss: data: blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Global security-headers middleware. Safe on every response.
 * @param {object} [opts]
 * @param {boolean} [opts.hsts=true] - emit Strict-Transport-Security on TLS requests
 */
function securityHeaders({ hsts = true } = {}) {
  return function (req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    // Only meaningful (and only honored) over HTTPS. req.secure is true for the
    // https listener; the x-forwarded-proto branch covers a TLS-terminating
    // proxy that fronts Eve.
    if (hsts && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

module.exports = { computeInlineScriptHashes, buildShellCsp, securityHeaders };
