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

const ORIGINAL_PUBLIC_ORIGIN = process.env.EVE_PUBLIC_ORIGIN;

function makeService(publicOrigin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-auth-'));
  // auth.js reads EVE_PUBLIC_ORIGIN fresh on every getOrigin/getRpId call (not
  // just at construction), so the var must stay set for the whole test body.
  // afterEach restores it.
  if (publicOrigin === undefined) delete process.env.EVE_PUBLIC_ORIGIN;
  else process.env.EVE_PUBLIC_ORIGIN = publicOrigin;
  return new AuthService(dir, silentLog);
}

describe('AuthService origin pinning (M1)', () => {
  let svc;
  afterEach(() => {
    svc?.stop?.(); svc = null;
    if (ORIGINAL_PUBLIC_ORIGIN === undefined) delete process.env.EVE_PUBLIC_ORIGIN;
    else process.env.EVE_PUBLIC_ORIGIN = ORIGINAL_PUBLIC_ORIGIN;
  });

  describe('without EVE_PUBLIC_ORIGIN (legacy host-derived)', () => {
    it('derives rpId and origin from the request Host', () => {
      svc = makeService(undefined);
      const req = mkReq({ host: 'eve.example.com:3000' });
      expect(svc.getRpId(req)).toBe('eve.example.com');
      expect(svc.getOrigin(req)).toBe('http://eve.example.com:3000');
    });

    it('uses https when the request is secure', () => {
      svc = makeService(undefined);
      expect(svc.getOrigin(mkReq({ host: 'eve.example.com', secure: true }))).toBe('https://eve.example.com');
    });
  });

  describe('with EVE_PUBLIC_ORIGIN set', () => {
    it('pins rpId and origin, ignoring a spoofed Host header', () => {
      svc = makeService('https://eve.example.com');
      const spoofed = mkReq({ host: 'attacker.test' });
      expect(svc.getRpId(spoofed)).toBe('eve.example.com');
      expect(svc.getOrigin(spoofed)).toBe('https://eve.example.com');
    });

    it('keeps the pin regardless of port or protocol on the request', () => {
      svc = makeService('https://eve.example.com');
      expect(svc.getOrigin(mkReq({ host: 'eve.example.com:3000', secure: false }))).toBe('https://eve.example.com');
    });

    it('ignores an invalid EVE_PUBLIC_ORIGIN and falls back to host-derived', () => {
      svc = makeService('not-a-url');
      expect(svc.getRpId(mkReq({ host: 'eve.example.com' }))).toBe('eve.example.com');
    });
  });
});
