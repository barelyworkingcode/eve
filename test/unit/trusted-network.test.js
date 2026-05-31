const {
  TrustedNetworkService,
  computeTrustedCidrs,
  isIpInCidrs,
  isPublicV4Cidr,
  isPublicIp,
  getClientIp,
  parseCidr,
  normalizeIp,
  ipv4ToInt,
} = require('../../trusted-network');

describe('ipv4ToInt', () => {
  test('parses a dotted-quad', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('1.2.3.4')).toBe((1 << 24) + (2 << 16) + (3 << 8) + 4);
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
  });

  test('rejects invalid input', () => {
    expect(ipv4ToInt('1.2.3')).toBeNull();
    expect(ipv4ToInt('1.2.3.4.5')).toBeNull();
    expect(ipv4ToInt('1.2.3.256')).toBeNull();
    expect(ipv4ToInt('1.2.3.a')).toBeNull();
    expect(ipv4ToInt('')).toBeNull();
  });
});

describe('normalizeIp', () => {
  test('strips IPv6-mapped IPv4 prefix', () => {
    expect(normalizeIp('::ffff:192.168.1.5')).toBe('192.168.1.5');
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  test('leaves bare IPv4 untouched', () => {
    expect(normalizeIp('10.0.0.1')).toBe('10.0.0.1');
  });

  test('lower-cases IPv6 literals', () => {
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('FE80::1')).toBe('fe80::1');
  });

  test('returns null for empty / undefined', () => {
    expect(normalizeIp('')).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });
});

describe('parseCidr', () => {
  test('parses IPv4 CIDR', () => {
    const c = parseCidr('10.0.0.0/24');
    expect(c).not.toBeNull();
    expect(c.kind).toBe('v4');
    expect(c.prefix).toBe(24);
    expect(c.mask).toBe(0xffffff00);
  });

  test('treats bare IPv4 as /32', () => {
    const c = parseCidr('10.0.0.1');
    expect(c.kind).toBe('v4');
    expect(c.prefix).toBe(32);
    expect(c.mask).toBe(0xffffffff);
  });

  test('parses /0 and /32 boundaries', () => {
    const a = parseCidr('0.0.0.0/0');
    expect(a.mask).toBe(0);
    expect(a.prefix).toBe(0);
    const b = parseCidr('1.2.3.4/32');
    expect(b.prefix).toBe(32);
  });

  test('normalizes the base against the mask', () => {
    const c = parseCidr('10.0.0.77/24');
    // The parsed base should be the network address, not the literal addr.
    expect(c.base).toBe(ipv4ToInt('10.0.0.0'));
  });

  test('accepts IPv6 literals as exact-match entries', () => {
    const c = parseCidr('::1');
    expect(c.kind).toBe('v6');
    expect(c.literal).toBe('::1');
  });

  test('rejects garbage', () => {
    expect(parseCidr('not-a-cidr')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('10.0.0.0/-1')).toBeNull();
    expect(parseCidr('')).toBeNull();
    expect(parseCidr(null)).toBeNull();
  });
});

describe('isIpInCidrs', () => {
  const cidrs = [
    parseCidr('127.0.0.0/8'),
    parseCidr('10.0.0.0/24'),
    parseCidr('::1'),
  ];

  test('matches an IP inside an IPv4 CIDR', () => {
    expect(isIpInCidrs('10.0.0.1', cidrs)).toBe(true);
    expect(isIpInCidrs('10.0.0.255', cidrs)).toBe(true);
    expect(isIpInCidrs('127.0.0.1', cidrs)).toBe(true);
    expect(isIpInCidrs('127.255.255.254', cidrs)).toBe(true);
  });

  test('rejects an IP outside all CIDRs', () => {
    expect(isIpInCidrs('10.0.1.1', cidrs)).toBe(false);
    expect(isIpInCidrs('192.168.1.1', cidrs)).toBe(false);
    expect(isIpInCidrs('8.8.8.8', cidrs)).toBe(false);
  });

  test('honors IPv6-mapped IPv4 normalization', () => {
    expect(isIpInCidrs('::ffff:10.0.0.5', cidrs)).toBe(true);
    expect(isIpInCidrs('::ffff:192.168.1.1', cidrs)).toBe(false);
  });

  test('matches IPv6 loopback literal', () => {
    expect(isIpInCidrs('::1', cidrs)).toBe(true);
  });

  test('edge boundaries on /24', () => {
    const c = [parseCidr('10.0.0.0/24')];
    expect(isIpInCidrs('10.0.0.0', c)).toBe(true);
    expect(isIpInCidrs('10.0.0.255', c)).toBe(true);
    expect(isIpInCidrs('10.0.1.0', c)).toBe(false);
    expect(isIpInCidrs('9.255.255.255', c)).toBe(false);
  });

  test('/32 matches exactly one address', () => {
    const c = [parseCidr('1.2.3.4/32')];
    expect(isIpInCidrs('1.2.3.4', c)).toBe(true);
    expect(isIpInCidrs('1.2.3.5', c)).toBe(false);
  });

  test('/0 matches everything IPv4', () => {
    const c = [parseCidr('0.0.0.0/0')];
    expect(isIpInCidrs('1.2.3.4', c)).toBe(true);
    expect(isIpInCidrs('255.255.255.255', c)).toBe(true);
    // But not IPv6.
    expect(isIpInCidrs('::1', c)).toBe(false);
  });

  test('returns false for empty / invalid input', () => {
    expect(isIpInCidrs('', cidrs)).toBe(false);
    expect(isIpInCidrs(null, cidrs)).toBe(false);
  });
});

describe('getClientIp', () => {
  test('reads req.socket.remoteAddress', () => {
    const req = { socket: { remoteAddress: '192.168.1.5' } };
    expect(getClientIp(req)).toBe('192.168.1.5');
  });

  test('normalizes IPv6-mapped IPv4', () => {
    const req = { socket: { remoteAddress: '::ffff:10.0.0.1' } };
    expect(getClientIp(req)).toBe('10.0.0.1');
  });

  test('ignores req.headers.host entirely', () => {
    const req = {
      socket: { remoteAddress: '8.8.8.8' },
      headers: { host: 'localhost' },
    };
    expect(getClientIp(req)).toBe('8.8.8.8');
  });

  test('ignores X-Forwarded-For entirely', () => {
    const req = {
      socket: { remoteAddress: '8.8.8.8' },
      headers: { 'x-forwarded-for': '127.0.0.1' },
    };
    expect(getClientIp(req)).toBe('8.8.8.8');
  });

  test('returns null on missing socket', () => {
    expect(getClientIp({})).toBeNull();
    expect(getClientIp({ socket: {} })).toBeNull();
  });
});

describe('computeTrustedCidrs', () => {
  test('explicit override replaces the default set', () => {
    const env = { EVE_TRUSTED_SUBNETS: '10.9.9.0/24,192.168.0.0/16' };
    const osModule = { networkInterfaces: () => ({}) };
    const cidrs = computeTrustedCidrs({ env, osModule });
    expect(cidrs).toHaveLength(2);
    expect(isIpInCidrs('10.9.9.17', cidrs)).toBe(true);
    expect(isIpInCidrs('192.168.99.99', cidrs)).toBe(true);
    expect(isIpInCidrs('127.0.0.1', cidrs)).toBe(false);
  });

  test('default set includes loopback when no override', () => {
    const env = {};
    const osModule = { networkInterfaces: () => ({}) };
    const cidrs = computeTrustedCidrs({ env, osModule });
    expect(isIpInCidrs('127.0.0.1', cidrs)).toBe(true);
    expect(isIpInCidrs('::1', cidrs)).toBe(true);
    expect(isIpInCidrs('10.0.0.1', cidrs)).toBe(false);
  });

  test('derives subnet from a non-internal IPv4 interface', () => {
    const osModule = {
      networkInterfaces: () => ({
        en0: [
          { family: 'IPv4', address: '192.168.1.5', netmask: '255.255.255.0', internal: false, cidr: '192.168.1.5/24' },
          { family: 'IPv6', address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', internal: false, cidr: 'fe80::1/64' },
        ],
        lo0: [
          { family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true, cidr: '127.0.0.1/8' },
        ],
      }),
    };
    const cidrs = computeTrustedCidrs({ env: {}, osModule });
    expect(isIpInCidrs('192.168.1.77', cidrs)).toBe(true);
    expect(isIpInCidrs('192.168.2.1', cidrs)).toBe(false);
    expect(isIpInCidrs('127.0.0.1', cidrs)).toBe(true);
  });

  test('derives subnet without a cidr field (netmask popcount)', () => {
    const osModule = {
      networkInterfaces: () => ({
        en0: [
          { family: 'IPv4', address: '10.0.0.42', netmask: '255.255.255.0', internal: false },
        ],
      }),
    };
    const cidrs = computeTrustedCidrs({ env: {}, osModule });
    expect(isIpInCidrs('10.0.0.1', cidrs)).toBe(true);
    expect(isIpInCidrs('10.0.0.254', cidrs)).toBe(true);
    expect(isIpInCidrs('10.0.1.1', cidrs)).toBe(false);
  });

  test('ignores internal interfaces (already covered by loopback)', () => {
    const osModule = {
      networkInterfaces: () => ({
        lo0: [
          { family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true, cidr: '127.0.0.1/8' },
        ],
      }),
    };
    const cidrs = computeTrustedCidrs({ env: {}, osModule });
    // Loopback is still matched via the default 127.0.0.0/8 we always add.
    expect(isIpInCidrs('127.0.0.1', cidrs)).toBe(true);
  });
});

describe('TrustedNetworkService', () => {
  const mkReq = (remoteAddress) => ({ socket: { remoteAddress } });

  test('trusts loopback and interface subnet by default', () => {
    const svc = new TrustedNetworkService({
      env: {},
      osModule: {
        networkInterfaces: () => ({
          en0: [{ family: 'IPv4', address: '192.168.5.10', netmask: '255.255.255.0', internal: false, cidr: '192.168.5.10/24' }],
        }),
      },
    });
    expect(svc.isTrusted(mkReq('127.0.0.1'))).toBe(true);
    expect(svc.isTrusted(mkReq('192.168.5.77'))).toBe(true);
    expect(svc.isTrusted(mkReq('8.8.8.8'))).toBe(false);
  });

  test('EVE_DISABLE_SUBNET_BYPASS=1 disables all trust', () => {
    const svc = new TrustedNetworkService({
      env: { EVE_DISABLE_SUBNET_BYPASS: '1' },
      osModule: { networkInterfaces: () => ({}) },
    });
    expect(svc.isTrusted(mkReq('127.0.0.1'))).toBe(false);
    expect(svc.isTrusted(mkReq('::1'))).toBe(false);
  });

  test('EVE_TRUSTED_SUBNETS override pins the trusted set', () => {
    const svc = new TrustedNetworkService({
      env: { EVE_TRUSTED_SUBNETS: '10.9.9.0/24' },
      osModule: {
        networkInterfaces: () => ({
          en0: [{ family: 'IPv4', address: '192.168.5.10', netmask: '255.255.255.0', internal: false, cidr: '192.168.5.10/24' }],
        }),
      },
    });
    // Override replaces default — so even loopback is not trusted.
    expect(svc.isTrusted(mkReq('127.0.0.1'))).toBe(false);
    expect(svc.isTrusted(mkReq('192.168.5.1'))).toBe(false);
    expect(svc.isTrusted(mkReq('10.9.9.50'))).toBe(true);
  });

  test('spoofed Host header does not grant trust', () => {
    const svc = new TrustedNetworkService({
      env: {},
      osModule: { networkInterfaces: () => ({}) },
    });
    const req = {
      socket: { remoteAddress: '8.8.8.8' },
      headers: { host: 'localhost' },
    };
    expect(svc.isTrusted(req)).toBe(false);
  });

  test('spoofed X-Forwarded-For does not grant trust', () => {
    const svc = new TrustedNetworkService({
      env: {},
      osModule: { networkInterfaces: () => ({}) },
    });
    const req = {
      socket: { remoteAddress: '8.8.8.8' },
      headers: { 'x-forwarded-for': '127.0.0.1' },
    };
    expect(svc.isTrusted(req)).toBe(false);
  });

  test('describe() returns a human-readable summary', () => {
    const svc = new TrustedNetworkService({
      env: { EVE_TRUSTED_SUBNETS: '10.0.0.0/24,127.0.0.0/8' },
      osModule: { networkInterfaces: () => ({}) },
    });
    const d = svc.describe();
    expect(d).toContain('10.0.0.0/24');
    expect(d).toContain('127.0.0.0/8');
  });

  test('warns at startup when the trusted set contains a public range', () => {
    const warnings = [];
    const log = { info: () => {}, warn: (m) => warnings.push(m), child: () => log };
    // Simulate a host whose NIC sits on a provider-shared public /24.
    new TrustedNetworkService({
      log,
      env: {},
      osModule: {
        networkInterfaces: () => ({
          eth0: [{ family: 'IPv4', address: '203.0.113.7', netmask: '255.255.255.0', internal: false, cidr: '203.0.113.7/24' }],
        }),
      },
    });
    expect(warnings.some((w) => /PUBLIC IP range/.test(w))).toBe(true);
    expect(warnings.some((w) => w.includes('203.0.113.0/24'))).toBe(true);
  });

  test('does NOT warn for a purely private/loopback trusted set', () => {
    const warnings = [];
    const log = { info: () => {}, warn: (m) => warnings.push(m), child: () => log };
    new TrustedNetworkService({
      log,
      env: {},
      osModule: {
        networkInterfaces: () => ({
          en0: [{ family: 'IPv4', address: '192.168.5.10', netmask: '255.255.255.0', internal: false, cidr: '192.168.5.10/24' }],
        }),
      },
    });
    expect(warnings.some((w) => /PUBLIC IP range/.test(w))).toBe(false);
  });
});

describe('isPublicV4Cidr', () => {
  test('flags public ranges', () => {
    expect(isPublicV4Cidr(parseCidr('203.0.113.0/24'))).toBe(true);
    expect(isPublicV4Cidr(parseCidr('8.8.8.8/32'))).toBe(true);
  });

  test('treats RFC1918, loopback, link-local, and CGNAT as private', () => {
    expect(isPublicV4Cidr(parseCidr('10.0.0.0/8'))).toBe(false);
    expect(isPublicV4Cidr(parseCidr('172.16.0.0/12'))).toBe(false);
    expect(isPublicV4Cidr(parseCidr('192.168.1.0/24'))).toBe(false);
    expect(isPublicV4Cidr(parseCidr('127.0.0.0/8'))).toBe(false);
    expect(isPublicV4Cidr(parseCidr('169.254.0.0/16'))).toBe(false);
    expect(isPublicV4Cidr(parseCidr('100.64.0.0/10'))).toBe(false);
  });

  test('ignores IPv6 CIDRs', () => {
    expect(isPublicV4Cidr(parseCidr('::1'))).toBe(false);
  });
});

describe('isPublicIp', () => {
  test('treats RFC1918 / loopback / link-local / CGNAT as NOT public', () => {
    for (const ip of ['127.0.0.1', '10.189.176.5', '192.168.76.20', '172.16.4.4', '169.254.1.1', '100.64.0.9']) {
      expect(isPublicIp(ip)).toBe(false);
    }
  });
  test('flags routable IPv4 as public', () => {
    expect(isPublicIp('203.0.113.7')).toBe(true);
    expect(isPublicIp('8.8.8.8')).toBe(true);
  });
  test('handles IPv6 loopback/ULA/link-local vs public', () => {
    expect(isPublicIp('::1')).toBe(false);
    expect(isPublicIp('fe80::1')).toBe(false);
    expect(isPublicIp('fd12:3456::1')).toBe(false);
    expect(isPublicIp('2001:db8::1')).toBe(true);
  });
  test('strips IPv4-mapped IPv6 and classifies the inner address', () => {
    expect(isPublicIp('::ffff:192.168.1.5')).toBe(false);
    expect(isPublicIp('::ffff:8.8.8.8')).toBe(true);
  });
  test('treats empty/unknown as public (fail-safe)', () => {
    expect(isPublicIp('')).toBe(true);
    expect(isPublicIp(null)).toBe(true);
  });
});
