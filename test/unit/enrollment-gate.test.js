const {
  enrollmentGate,
  isEnrollmentBlocked,
  canBootstrapEnrollment,
} = require('../../enrollment-gate');
const { TrustedNetworkService } = require('../../trusted-network');

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

// Integration-flavored: wire the REAL TrustedNetworkService into the REAL gate so
// the gate <-> service seam is exercised. The hand-rolled double above mirrors the
// service's intent but reimplements the trust predicate; here a normalization
// regression in the real service (e.g. how it classifies a ::ffff:-mapped client,
// or its CIDR membership math) would actually fail a test.
describe('with the real TrustedNetworkService', () => {
  // Pin the trusted set to a private /16 via EVE_TRUSTED_SUBNETS and feed an
  // empty NIC list so the service's classification is fully deterministic and
  // independent of the host running the tests. (The override REPLACES the default
  // set, so loopback is intentionally not in `cidrs` here — but loopback is still
  // non-public and handled by the gate's isPublicIp short-circuit.)
  const realTrustedNetwork = new TrustedNetworkService({
    env: { EVE_TRUSTED_SUBNETS: '192.168.0.0/16' },
    osModule: { networkInterfaces: () => ({}) },
  });

  it('classifies the pinned private /16 as in-range (real service)', () => {
    // Sanity-check the seam directly: the gate calls exactly this method.
    expect(realTrustedNetwork.isInTrustedRange(req('192.168.1.50'))).toBe(true);
    expect(realTrustedNetwork.isInTrustedRange(req('203.0.113.7'))).toBe(false);
  });

  it('HARD RULE: a public-IP client cannot enroll even with EVE_ALLOW_ENROLLMENT=1', () => {
    // Drives the real service: 203.0.113.7 is public AND outside 192.168/16, so
    // both the isPublicIp hard rule and the real isInTrustedRange say "no".
    expect(canBootstrapEnrollment(req('203.0.113.7'), {
      trustedNetwork: realTrustedNetwork,
      env: { EVE_ALLOW_ENROLLMENT: '1' },
    })).toBe(false);
    expect(canBootstrapEnrollment(req('8.8.8.8'), {
      trustedNetwork: realTrustedNetwork,
      env: { EVE_ALLOW_ENROLLMENT: '1' },
    })).toBe(false);
  });

  it('a client in the trusted private range may bootstrap (no escape hatch needed)', () => {
    // No EVE_ALLOW_ENROLLMENT — trust comes purely from the real service's CIDR
    // membership test, so this exercises isInTrustedRange end-to-end.
    expect(canBootstrapEnrollment(req('192.168.1.50'), {
      trustedNetwork: realTrustedNetwork,
      env: {},
    })).toBe(true);
  });

  it('honors the real service IPv6-mapped-IPv4 normalization for a trusted client', () => {
    // ::ffff:192.168.1.50 must normalize to 192.168.1.50 inside the real service.
    // A regression in normalizeIp/getClientIp would make this client look untrusted.
    expect(canBootstrapEnrollment(req('::ffff:192.168.1.50'), {
      trustedNetwork: realTrustedNetwork,
      env: {},
    })).toBe(true);
  });

  it('end-to-end gate: 404s an un-enrolled public client even with EVE_ALLOW_ENROLLMENT=1', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({
      authService: notEnrolled,
      trustedNetwork: realTrustedNetwork,
      env: { EVE_ALLOW_ENROLLMENT: '1' },
    })(req('203.0.113.7'), r, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(r.statusCode).toBe(404);
    expect(r.body).toBe('Not found');
  });

  it('end-to-end gate: passes an un-enrolled trusted-range (LAN) client through', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({
      authService: notEnrolled,
      trustedNetwork: realTrustedNetwork,
      env: {},
    })(req('192.168.1.50'), r, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(r.statusCode).toBeNull();
  });

  // `res()` is defined inside the `enrollmentGate middleware` describe above; the
  // two end-to-end cases need it, so re-declare the same minimal fake here to keep
  // this block self-contained.
  function res() {
    return {
      statusCode: null, body: null, headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      type() { return this; },
      send(b) { this.body = b; return this; },
    };
  }
});
