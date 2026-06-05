const {
  enrollmentGate,
  isEnrollmentBlocked,
  canBootstrapEnrollment,
} = require('../../enrollment-gate');

const req = (remoteAddress, extra = {}) => ({ socket: { remoteAddress }, method: 'GET', url: '/', headers: {}, ...extra });

// trustedNetwork double: mirrors the real service's default trusted set, which
// ALWAYS includes loopback (127.0.0.0/8 + ::1) plus, here, the 192.168.0.0/16 LAN.
const trustedNetwork = {
  isInTrustedRange: (r) => {
    const a = r?.socket?.remoteAddress || '';
    return a === '::1' || /^127\./.test(a) || /^192\.168\./.test(a);
  },
};
const enrolled = { isEnrolled: () => true };
const notEnrolled = { isEnrolled: () => false };

describe('canBootstrapEnrollment', () => {
  it('allows loopback', () => {
    expect(canBootstrapEnrollment(req('127.0.0.1'), { trustedNetwork, env: {} })).toBe(true);
  });
  it('allows a trusted-range client (LAN/WireGuard)', () => {
    expect(canBootstrapEnrollment(req('192.168.1.50'), { trustedNetwork, env: {} })).toBe(true);
  });
  it('blocks a remote (public) client', () => {
    expect(canBootstrapEnrollment(req('203.0.113.7'), { trustedNetwork, env: {} })).toBe(false);
  });
  it('NEVER allows a public internet IP, even with EVE_ALLOW_ENROLLMENT=1', () => {
    expect(canBootstrapEnrollment(req('203.0.113.7'), { trustedNetwork, env: { EVE_ALLOW_ENROLLMENT: '1' } })).toBe(false);
    expect(canBootstrapEnrollment(req('8.8.8.8'), { trustedNetwork, env: { EVE_ALLOW_ENROLLMENT: '1' } })).toBe(false);
  });
  it('the escape hatch broadens to a non-trusted PRIVATE net (e.g. a different LAN/VPN)', () => {
    // 10.50.50.50 is private but outside the trustedNetwork double's 192.168/16
    expect(canBootstrapEnrollment(req('10.50.50.50'), { trustedNetwork, env: {} })).toBe(false);
    expect(canBootstrapEnrollment(req('10.50.50.50'), { trustedNetwork, env: { EVE_ALLOW_ENROLLMENT: '1' } })).toBe(true);
  });
});

describe('isEnrollmentBlocked', () => {
  const opts = (auth, env = {}) => ({ authService: auth, trustedNetwork, env });

  it('never blocks once enrolled', () => {
    expect(isEnrollmentBlocked(req('203.0.113.7'), opts(enrolled))).toBe(false);
  });
  it('blocks an un-enrolled remote client', () => {
    expect(isEnrollmentBlocked(req('203.0.113.7'), opts(notEnrolled))).toBe(true);
  });
  it('blocks an un-enrolled public IP EVEN with EVE_ALLOW_ENROLLMENT=1', () => {
    expect(isEnrollmentBlocked(req('203.0.113.7'), opts(notEnrolled, { EVE_ALLOW_ENROLLMENT: '1' }))).toBe(true);
  });
  it('does NOT block un-enrolled loopback (bootstrap)', () => {
    expect(isEnrollmentBlocked(req('127.0.0.1'), opts(notEnrolled))).toBe(false);
  });
  it('does NOT block un-enrolled LAN/WireGuard (bootstrap)', () => {
    expect(isEnrollmentBlocked(req('192.168.1.50'), opts(notEnrolled))).toBe(false);
  });
  it('is a no-op when EVE_NO_AUTH=1', () => {
    expect(isEnrollmentBlocked(req('203.0.113.7'), opts(notEnrolled, { EVE_NO_AUTH: '1' }))).toBe(false);
  });
});

describe('enrollmentGate middleware', () => {
  function res() {
    return {
      statusCode: null, body: null, headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      type() { return this; },
      send(b) { this.body = b; return this; },
    };
  }

  it('404s an un-enrolled remote request', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({ authService: notEnrolled, trustedNetwork, env: {} })(req('203.0.113.7'), r, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(r.statusCode).toBe(404);
    expect(r.body).toBe('Not found');
  });

  it('passes an un-enrolled bootstrap (LAN) request through', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({ authService: notEnrolled, trustedNetwork, env: {} })(req('192.168.1.50'), r, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(r.statusCode).toBeNull();
  });

  it('404s a public IP even with EVE_ALLOW_ENROLLMENT=1', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({ authService: notEnrolled, trustedNetwork, env: { EVE_ALLOW_ENROLLMENT: '1' } })(req('203.0.113.7'), r, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(r.statusCode).toBe(404);
  });

  it('passes everything through once enrolled', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({ authService: enrolled, trustedNetwork, env: {} })(req('203.0.113.7'), r, () => { nexted = true; });
    expect(nexted).toBe(true);
  });
});
