const crypto = require('crypto');
const { computeInlineScriptHashes, buildShellCsp, securityHeaders } = require('../../security-headers');

function mockRes() {
  const headers = {};
  return {
    headers,
    set(name, value) { headers[name] = value; return this; },
    get(name) { return headers[name]; },
  };
}

describe('security-headers', () => {
  describe('computeInlineScriptHashes', () => {
    it('hashes inline scripts and skips external (src) scripts', () => {
      const body = 'console.log(1);';
      const expected = `'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`;
      const html = `
        <script src="/app.js"></script>
        <script>${body}</script>
        <script src="/x.js?rnd=abc"></script>
      `;
      const hashes = computeInlineScriptHashes(html);
      expect(hashes).toEqual([expected]);
    });

    it('hashes multiple inline scripts in order', () => {
      const html = '<script>a()</script><script>b()</script>';
      expect(computeInlineScriptHashes(html)).toHaveLength(2);
    });

    // Browsers normalise CRLF to LF before hashing an inline script body. Hashing
    // the raw bytes of a CRLF file therefore yields a hash the browser never
    // matches, and every inline script is silently blocked — which is exactly
    // what happened to index.html's theme bootstrap and bad-network safety net.
    it('hashes CRLF and LF bodies identically', () => {
      const lf = '<script>\nvar a = 1;\nvar b = 2;\n</script>';
      const crlf = '<script>\r\nvar a = 1;\r\nvar b = 2;\r\n</script>';
      expect(computeInlineScriptHashes(crlf)).toEqual(computeInlineScriptHashes(lf));
    });

    it('returns [] when there are no inline scripts', () => {
      expect(computeInlineScriptHashes('<script src="/a.js"></script>')).toEqual([]);
    });
  });

  describe('buildShellCsp', () => {
    const csp = buildShellCsp(["'sha256-abc'"]);

    it('restricts script-src to self + wasm + blob + the given hashes (no unsafe-inline)', () => {
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval' blob: 'sha256-abc'");
      expect(csp).not.toContain("script-src 'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-eval'"); // only the narrower wasm-unsafe-eval
    });

    it('locks down object-src and frame-ancestors', () => {
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    // 'self' rather than 'none': index.html carries <base href="/"> so the shell
    // resolves its relative script URLs when served from a /:project path with a
    // trailing slash. 'none' blocked the tag and 404'd all 60 scripts there.
    it('allows a same-origin base-uri so <base href="/"> survives', () => {
      expect(csp).toContain("base-uri 'self'");
      expect(csp).not.toContain("base-uri 'none'");
    });

    it('allows ws/wss in connect-src for the relay socket', () => {
      expect(csp).toContain("connect-src 'self' ws: wss: data: blob:");
    });
  });

  describe('securityHeaders middleware', () => {
    it('sets nosniff, frame-options, referrer-policy, and COOP', () => {
      const res = mockRes();
      let called = false;
      securityHeaders()({ headers: {} }, res, () => { called = true; });
      expect(called).toBe(true);
      expect(res.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.get('X-Frame-Options')).toBe('SAMEORIGIN');
      expect(res.get('Referrer-Policy')).toBe('no-referrer');
      expect(res.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    });

    it('omits HSTS on a plain-HTTP request', () => {
      const res = mockRes();
      securityHeaders()({ headers: {}, secure: false }, res, () => {});
      expect(res.get('Strict-Transport-Security')).toBeUndefined();
    });

    it('sets HSTS when the request is secure', () => {
      const res = mockRes();
      securityHeaders()({ headers: {}, secure: true }, res, () => {});
      expect(res.get('Strict-Transport-Security')).toContain('max-age=31536000');
    });

    it('sets HSTS behind a TRUSTED TLS-terminating proxy (x-forwarded-proto=https)', () => {
      const res = mockRes();
      const trustedNetwork = { isTrusted: () => true };
      securityHeaders({ trustedNetwork })({ headers: { 'x-forwarded-proto': 'https' }, secure: false }, res, () => {});
      expect(res.get('Strict-Transport-Security')).toContain('max-age=31536000');
    });

    it('ignores x-forwarded-proto from an UNtrusted client (no HSTS spoofing)', () => {
      const res = mockRes();
      const trustedNetwork = { isTrusted: () => false };
      securityHeaders({ trustedNetwork })({ headers: { 'x-forwarded-proto': 'https' }, secure: false }, res, () => {});
      expect(res.get('Strict-Transport-Security')).toBeUndefined();
    });
  });
});
