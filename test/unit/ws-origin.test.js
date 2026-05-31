const { isAllowedWsOrigin, parseAllowedOrigins } = require('../../ws-origin');

function reqWith(headers) {
  return { headers };
}

describe('ws-origin', () => {
  describe('parseAllowedOrigins', () => {
    it('returns [] when unset', () => {
      expect(parseAllowedOrigins({})).toEqual([]);
    });

    it('returns [] when blank', () => {
      expect(parseAllowedOrigins({ EVE_PUBLIC_ORIGIN: '   ' })).toEqual([]);
    });

    it('splits and trims a comma list', () => {
      expect(parseAllowedOrigins({ EVE_PUBLIC_ORIGIN: 'https://a.com, https://b.com' }))
        .toEqual(['https://a.com', 'https://b.com']);
    });
  });

  describe('isAllowedWsOrigin — no allowlist (same-origin mode)', () => {
    it('allows a request with no Origin (non-browser client)', () => {
      expect(isAllowedWsOrigin(reqWith({ host: 'eve.host:3000' }))).toBe(true);
    });

    it('allows same-origin (Origin host matches Host, with port)', () => {
      const req = reqWith({ origin: 'http://eve.host:3000', host: 'eve.host:3000' });
      expect(isAllowedWsOrigin(req)).toBe(true);
    });

    it('allows same-origin over https on default port', () => {
      const req = reqWith({ origin: 'https://eve.host', host: 'eve.host' });
      expect(isAllowedWsOrigin(req)).toBe(true);
    });

    it('REJECTS a cross-site Origin (the CSWSH case)', () => {
      const req = reqWith({ origin: 'https://evil.example', host: 'eve.host:3000' });
      expect(isAllowedWsOrigin(req)).toBe(false);
    });

    it('REJECTS when Origin host matches but port differs', () => {
      const req = reqWith({ origin: 'http://eve.host:9999', host: 'eve.host:3000' });
      expect(isAllowedWsOrigin(req)).toBe(false);
    });

    it('REJECTS a malformed Origin', () => {
      const req = reqWith({ origin: 'not a url', host: 'eve.host:3000' });
      expect(isAllowedWsOrigin(req)).toBe(false);
    });

    it('REJECTS when Host header is absent but Origin is present', () => {
      const req = reqWith({ origin: 'http://eve.host:3000' });
      expect(isAllowedWsOrigin(req)).toBe(false);
    });
  });

  describe('isAllowedWsOrigin — explicit allowlist', () => {
    const allowedOrigins = ['https://eve.example'];

    it('allows an exact allowlisted origin even if Host differs (proxy case)', () => {
      const req = reqWith({ origin: 'https://eve.example', host: 'internal:3000' });
      expect(isAllowedWsOrigin(req, { allowedOrigins })).toBe(true);
    });

    it('rejects an origin not on the allowlist', () => {
      const req = reqWith({ origin: 'https://evil.example', host: 'eve.example' });
      expect(isAllowedWsOrigin(req, { allowedOrigins })).toBe(false);
    });

    it('still allows a no-Origin client under an allowlist', () => {
      const req = reqWith({ host: 'eve.example' });
      expect(isAllowedWsOrigin(req, { allowedOrigins })).toBe(true);
    });
  });
});
