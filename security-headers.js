// The strict CSP built by buildShellCsp() applies ONLY to the main app HTML
// document, deliberately NOT to: module iframes (isolated by the iframe
// sandbox / opaque origin — the real trust boundary there), the standalone
// /api/auth/safari-login page, or /api/files/* (sets its own
// default-src 'none'; sandbox). See docs/security-audit-frontend.md (C3).
const crypto = require('crypto');

// Hash is taken over the exact inline <script> text content, which is what
// the browser hashes. Relies on server.js's cache-bust rewrite only touching
// `<script src=...>` tags, so inline bodies stay byte-stable.
function computeInlineScriptHashes(html) {
  const hashes = [];
  const re = /<script(\b[^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    // Browsers normalise CRLF to LF before hashing — a CRLF-checked-out
    // index.html would otherwise never match its own hash.
    const body = (m[2] || '').replace(/\r\n/g, '\n');
    if (!body.trim()) continue;
    const digest = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push(`'sha256-${digest}'`);
  }
  return hashes;
}

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
    // 'self', not 'none': index.html's <base href="/"> must still resolve
    // relative script/link URLs when served from a /:project path with a
    // trailing slash. 'self' still blocks an injected off-origin <base>.
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function securityHeaders({ hsts = true, trustedNetwork = null } = {}) {
  return function (req, res, next) {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    // x-forwarded-proto is trusted only when the request comes from a
    // trusted reverse proxy (validated via trustedNetwork).
    let isTls = req.secure;
    if (hsts && !isTls && trustedNetwork?.isTrusted(req) && req.headers['x-forwarded-proto'] === 'https') {
      isTls = true;
    }
    if (hsts && isTls) {
      res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

module.exports = { computeInlineScriptHashes, buildShellCsp, securityHeaders };
