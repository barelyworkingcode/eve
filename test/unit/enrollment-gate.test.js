const {
  enrollmentGate,
  isEnrollmentBlocked,
  canBootstrapEnrollment,
  isLoopbackIp,
} = require('../../enrollment-gate');

const req = (remoteAddress, extra = {}) => ({ socket: { remoteAddress }, method: 'GET', url: '/', headers: {}, ...extra });

// trustedNetwork double: trusts the 192.168.0.0/16 LAN, nothing else.
const trustedNetwork = {
  isInTrustedRange: (r) => /^192\.168\./.test(r?.socket?.remoteAddress || ''),
};
const enrolled = { isEnrolled: () => true };
const notEnrolled = { isEnrolled: () => false };

describe('isLoopbackIp', () => {
  it('recognizes loopback v4/v6', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('127.0.0.5')).toBe(true);
    expect(isLoopbackIp('::1')).toBe(true);
  });
  it('rejects non-loopback', () => {
    expect(isLoopbackIp('192.168.1.4')).toBe(false);
    expect(isLoopbackIp('8.8.8.8')).toBe(false);
    expect(isLoopbackIp('')).toBe(false);
  });
});

describe('canBootstrapEnrollment', () => {
  it('allows loopback', () => {
    expect(canBootstrapEnrollment(req('127.0.0.1'), { trustedNetwork, env: {} })).toBe(true);
  });
  it('allows a trusted-range client (LAN/WireGuard)', () => {
    expect(canBootstrapEnrollment(req('192.168.1.50'), { trustedNetwork, env: {} })).toBe(true);
  });
  it('blocks a remote client', () => {
    expect(canBootstrapEnrollment(req('203.0.113.7'), { trustedNetwork, env: {} })).toBe(false);
  });
  it('honors the EVE_ALLOW_ENROLLMENT escape hatch even for remote', () => {
    expect(canBootstrapEnrollment(req('203.0.113.7'), { trustedNetwork, env: { EVE_ALLOW_ENROLLMENT: '1' } })).toBe(true);
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

  it('passes everything through once enrolled', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({ authService: enrolled, trustedNetwork, env: {} })(req('203.0.113.7'), r, () => { nexted = true; });
    expect(nexted).toBe(true);
  });
});
