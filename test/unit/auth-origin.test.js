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
