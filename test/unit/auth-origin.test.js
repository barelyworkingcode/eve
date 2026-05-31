const os = require('os');
const fs = require('fs');
const path = require('path');
const AuthService = require('../../auth');

const silentLog = { info() {}, warn() {}, error() {}, debug() {}, child() { return silentLog; } };

function mkReq({ host, proto, secure = false } = {}) {
  const headers = {};
  if (host) headers['host'] = host;
  if (proto) headers['x-forwarded-proto'] = proto;
  return { secure, get: (h) => headers[h.toLowerCase()] };
}

function makeService(publicOrigin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-auth-'));
  const prev = process.env.EVE_PUBLIC_ORIGIN;
  if (publicOrigin === undefined) delete process.env.EVE_PUBLIC_ORIGIN;
  else process.env.EVE_PUBLIC_ORIGIN = publicOrigin;
  const svc = new AuthService(dir, silentLog);
  // restore env immediately — the constructor has already read it
  if (prev === undefined) delete process.env.EVE_PUBLIC_ORIGIN;
  else process.env.EVE_PUBLIC_ORIGIN = prev;
  return svc;
}

describe('AuthService origin pinning (M1)', () => {
  let svc;
  afterEach(() => { svc?.stop?.(); svc = null; });

  describe('without EVE_PUBLIC_ORIGIN (legacy host-derived)', () => {
    it('derives rpId and origin from the request Host', () => {
      svc = makeService(undefined);
      const req = mkReq({ host: 'eve.lan:3000' });
      expect(svc.getRpId(req)).toBe('eve.lan');
      expect(svc.getOrigin(req)).toBe('http://eve.lan:3000');
    });

    it('uses https when the request is secure', () => {
      svc = makeService(undefined);
      expect(svc.getOrigin(mkReq({ host: 'eve.lan', secure: true }))).toBe('https://eve.lan');
    });

    it('expected origin/rpId fall back to request + stored values', () => {
      svc = makeService(undefined);
      const req = mkReq({ host: 'eve.lan:3000' });
      expect(svc._expectedOrigins(req)).toBe('http://eve.lan:3000');
      expect(svc._expectedRpIds(req, 'stored.host')).toBe('stored.host');
      expect(svc._expectedRpIds(req, null)).toBe('eve.lan');
    });
  });

  describe('with EVE_PUBLIC_ORIGIN set', () => {
    it('pins rpId and origin, ignoring a spoofed Host header', () => {
      svc = makeService('https://eve.example.com');
      const spoofed = mkReq({ host: 'attacker.test' });
      expect(svc.getRpId(spoofed)).toBe('eve.example.com');
      expect(svc.getOrigin(spoofed)).toBe('https://eve.example.com');
    });

    it('returns the full allowlist for verification', () => {
      svc = makeService('https://eve.example.com, https://eve.lan');
      const req = mkReq({ host: 'attacker.test' });
      expect(svc._expectedOrigins(req)).toEqual(['https://eve.example.com', 'https://eve.lan']);
      expect(svc._expectedRpIds(req, null)).toEqual(['eve.example.com', 'eve.lan']);
    });

    it('includes a credential\'s stored rpId so pre-pinning enrollments still verify', () => {
      svc = makeService('https://eve.example.com');
      expect(svc._expectedRpIds(mkReq({ host: 'x' }), 'old.host'))
        .toEqual(['eve.example.com', 'old.host']);
    });

    it('skips invalid entries', () => {
      svc = makeService('not-a-url, https://eve.example.com');
      expect(svc.getRpId(mkReq({ host: 'x' }))).toBe('eve.example.com');
    });
  });

  describe('two hostnames (eve.lan + DDNS)', () => {
    const TWO = 'https://eve.lan, https://home.firewalla.net';

    it('selects the RP-ID matching the host the browser used', () => {
      svc = makeService(TWO);
      expect(svc.getRpId(mkReq({ host: 'eve.lan' }))).toBe('eve.lan');
      expect(svc.getRpId(mkReq({ host: 'home.firewalla.net' }))).toBe('home.firewalla.net');
    });

    it('selects the matching origin too, ignoring the port', () => {
      svc = makeService(TWO);
      expect(svc.getOrigin(mkReq({ host: 'eve.lan:3000' }))).toBe('https://eve.lan');
      expect(svc.getOrigin(mkReq({ host: 'home.firewalla.net:443' }))).toBe('https://home.firewalla.net');
    });

    it('falls back to the first pinned entry for an unlisted host', () => {
      svc = makeService(TWO);
      expect(svc.getRpId(mkReq({ host: 'something-else' }))).toBe('eve.lan');
    });

    it('verifies against BOTH origins/RP-IDs regardless of which host was used', () => {
      svc = makeService(TWO);
      const req = mkReq({ host: 'eve.lan' });
      expect(svc._expectedOrigins(req)).toEqual(['https://eve.lan', 'https://home.firewalla.net']);
      expect(svc._expectedRpIds(req, null)).toEqual(['eve.lan', 'home.firewalla.net']);
    });
  });
});
