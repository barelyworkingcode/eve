const { isAllowedWsOrigin, parsePublicOrigin, isLoopbackHost } = require('../../ws-origin');

function reqWith(headers) {
  return { headers };
}

describe('ws-origin', () => {
  describe('parsePublicOrigin', () => {
    it('returns null when unset', () => {
      expect(parsePublicOrigin({})).toBeNull();
    });

    it('returns null when blank', () => {
      expect(parsePublicOrigin({ EVE_PUBLIC_ORIGIN: '   ' })).toBeNull();
    });

    it('returns the trimmed origin', () => {
      expect(parsePublicOrigin({ EVE_PUBLIC_ORIGIN: '  https://eve.example  ' }))
        .toBe('https://eve.example');
    });
  });

  describe('isAllowedWsOrigin — no pinned origin (same-origin mode)', () => {
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

  describe('isAllowedWsOrigin — pinned public origin', () => {
    const publicOrigin = 'https://eve.example';

    it('allows the exact pinned origin even if Host differs (proxy case)', () => {
      const req = reqWith({ origin: 'https://eve.example', host: 'internal:3000' });
      expect(isAllowedWsOrigin(req, { publicOrigin })).toBe(true);
    });

    it('rejects any other origin', () => {
      const req = reqWith({ origin: 'https://evil.example', host: 'eve.example' });
      expect(isAllowedWsOrigin(req, { publicOrigin })).toBe(false);
    });

    it('still allows a no-Origin client when pinned', () => {
      const req = reqWith({ host: 'eve.example' });
      expect(isAllowedWsOrigin(req, { publicOrigin })).toBe(true);
    });
  });

  describe('isLoopbackHost (exact match, no substrings)', () => {
    it('matches the canonical loopback hostnames', () => {
      expect(isLoopbackHost('localhost')).toBe(true);
      expect(isLoopbackHost('127.0.0.1')).toBe(true);
      expect(isLoopbackHost('::1')).toBe(true);
      expect(isLoopbackHost('[::1]')).toBe(true); // bracketed IPv6
      expect(isLoopbackHost('LOCALHOST')).toBe(true);
    });
    it('rejects substring/lookalike bypass attempts', () => {
      expect(isLoopbackHost('localhost.evil.com')).toBe(false);
      expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
      expect(isLoopbackHost('evil.com')).toBe(false);
      expect(isLoopbackHost('127.0.0.2')).toBe(false);
      expect(isLoopbackHost('')).toBe(false);
    });
  });

  describe('loopback Origin exception (on-box automation, even when pinned)', () => {
    const publicOrigin = 'https://eve.example';

    it('allows a localhost browser through despite the pin', () => {
      const req = reqWith({ origin: 'http://localhost:3000', host: 'localhost:3000' });
      expect(isAllowedWsOrigin(req, { publicOrigin })).toBe(true);
    });
    it('allows 127.0.0.1 and [::1] origins', () => {
      expect(isAllowedWsOrigin(reqWith({ origin: 'http://127.0.0.1:3000', host: 'x' }), { publicOrigin })).toBe(true);
      expect(isAllowedWsOrigin(reqWith({ origin: 'http://[::1]:3000', host: 'x' }), { publicOrigin })).toBe(true);
    });
    it('does NOT allow a loopback-lookalike host (forged/malformed)', () => {
      expect(isAllowedWsOrigin(reqWith({ origin: 'http://localhost.evil.com', host: 'x' }), { publicOrigin })).toBe(false);
      expect(isAllowedWsOrigin(reqWith({ origin: 'http://127.0.0.1.evil.com', host: 'x' }), { publicOrigin })).toBe(false);
    });
    it('still rejects a genuine cross-site origin', () => {
      expect(isAllowedWsOrigin(reqWith({ origin: 'https://evil.example', host: 'eve.example' }), { publicOrigin })).toBe(false);
    });
  });
});
