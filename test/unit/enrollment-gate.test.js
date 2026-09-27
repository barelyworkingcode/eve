const {
  enrollmentGate,
  isEnrollmentBlocked,
  canBootstrapEnrollment,
} = require('../../enrollment-gate');
const { TrustedNetworkService } = require('../../trusted-network');

const req = (remoteAddress, extra = {}) => ({ socket: { remoteAddress }, method: 'GET', url: '/', headers: {}, ...extra });

const trustedNetwork = {
  isInTrustedRange: (r) => {
    const a = r?.socket?.remoteAddress || '';
    return a === '::1' || /^127\./.test(a) || /^192\.168\./.test(a);
  },
};
const enrolled = { isEnrolled: () => true };
const notEnrolled = { isEnrolled: () => false };

describe('canBootstrapEnrollment', () => {
  it('the escape hatch broadens to a non-trusted PRIVATE net (e.g. a different LAN/VPN)', () => {
    expect(canBootstrapEnrollment(req('10.50.50.50'), { trustedNetwork, env: {} })).toBe(false);
    expect(canBootstrapEnrollment(req('10.50.50.50'), { trustedNetwork, env: { EVE_ALLOW_ENROLLMENT: '1' } })).toBe(true);
  });
});

describe('isEnrollmentBlocked', () => {
  const opts = (auth, env = {}) => ({ authService: auth, trustedNetwork, env });

  it('does NOT block un-enrolled loopback (bootstrap)', () => {
    expect(isEnrollmentBlocked(req('127.0.0.1'), opts(notEnrolled))).toBe(false);
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

  it('passes everything through once enrolled', () => {
    const r = res();
    let nexted = false;
    enrollmentGate({ authService: enrolled, trustedNetwork, env: {} })(req('203.0.113.7'), r, () => { nexted = true; });
    expect(nexted).toBe(true);
  });
});

// The hand-rolled double above mirrors the real service's intent but reimplements
// the trust predicate, so it can't catch a normalization regression in the real
// service (e.g. ::ffff:-mapped client handling or CIDR membership math). This
// block wires the real TrustedNetworkService in instead.
describe('with the real TrustedNetworkService', () => {
  // EVE_TRUSTED_SUBNETS replaces the default trusted set, so loopback is not
  // trusted here; an empty NIC list keeps classification independent of the host.
  const realTrustedNetwork = new TrustedNetworkService({
    env: { EVE_TRUSTED_SUBNETS: '192.168.0.0/16' },
    osModule: { networkInterfaces: () => ({}) },
  });

  it('HARD RULE: a public-IP client cannot enroll even with EVE_ALLOW_ENROLLMENT=1', () => {
    // 203.0.113.7 is public AND outside 192.168/16, so both the isPublicIp hard
    // rule and the real isInTrustedRange independently say "no".
    expect(canBootstrapEnrollment(req('203.0.113.7'), {
      trustedNetwork: realTrustedNetwork,
      env: { EVE_ALLOW_ENROLLMENT: '1' },
    })).toBe(false);
    expect(canBootstrapEnrollment(req('8.8.8.8'), {
      trustedNetwork: realTrustedNetwork,
      env: { EVE_ALLOW_ENROLLMENT: '1' },
    })).toBe(false);
  });

  it('honors the real service IPv6-mapped-IPv4 normalization for a trusted client', () => {
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

  // Duplicated from the `enrollmentGate middleware` describe above, rather than
  // shared, to keep this block self-contained.
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
