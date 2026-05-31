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

    it('locks down object-src, base-uri, and frame-ancestors', () => {
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
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

    it('sets HSTS behind a TLS-terminating proxy (x-forwarded-proto=https)', () => {
      const res = mockRes();
      securityHeaders()({ headers: { 'x-forwarded-proto': 'https' }, secure: false }, res, () => {});
      expect(res.get('Strict-Transport-Security')).toContain('max-age=31536000');
    });
  });
});
