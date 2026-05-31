const { ipHostGuard, isBareIpHost, hostOnly } = require('../../ip-host-guard');

function mockRes() {
  return {
    statusCode: null, headers: {}, body: null,
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.body = b; return this; },
  };
}
function run(guard, hostHeader) {
  const res = mockRes();
  let nexted = false;
  guard({ headers: { host: hostHeader } }, res, () => { nexted = true; });
  return { res, nexted };
}

describe('hostOnly', () => {
  it('strips the port from host:port', () => {
    expect(hostOnly('eve.lan:3000')).toBe('eve.lan');
    expect(hostOnly('1.2.3.4:443')).toBe('1.2.3.4');
  });
  it('unwraps bracketed IPv6', () => {
    expect(hostOnly('[::1]:3000')).toBe('::1');
    expect(hostOnly('[2001:db8::1]:443')).toBe('2001:db8::1');
  });
  it('returns bare hostnames untouched', () => {
    expect(hostOnly('eve.lan')).toBe('eve.lan');
  });
});

describe('isBareIpHost', () => {
  it('flags non-loopback IPv4 and IPv6', () => {
    expect(isBareIpHost('192.168.1.50:3000')).toBe(true);
    expect(isBareIpHost('203.0.113.7')).toBe(true);
    expect(isBareIpHost('[2001:db8::5]:443')).toBe(true);
  });
  it('does not flag hostnames', () => {
    expect(isBareIpHost('eve.lan')).toBe(false);
    expect(isBareIpHost('home.firewalla.net:443')).toBe(false);
    expect(isBareIpHost('localhost:3000')).toBe(false);
  });
  it('exempts loopback IPs', () => {
    expect(isBareIpHost('127.0.0.1:3000')).toBe(false);
    expect(isBareIpHost('[::1]:3000')).toBe(false);
  });
});

describe('ipHostGuard middleware', () => {
  const origins = ['https://eve.lan', 'https://home.firewalla.net'];

  it('is a no-op when no origins are configured', () => {
    const { nexted } = run(ipHostGuard({ origins: [] }), '192.168.1.50');
    expect(nexted).toBe(true);
  });

  it('passes hostname requests through', () => {
    const { nexted, res } = run(ipHostGuard({ origins }), 'eve.lan');
    expect(nexted).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('blocks a bare-IP request with 421 and lists the hostnames', () => {
    const { nexted, res } = run(ipHostGuard({ origins }), '192.168.1.50:3000');
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(421);
    expect(res.body).toContain('https://eve.lan');
    expect(res.body).toContain('https://home.firewalla.net');
  });

  it('still allows loopback IP (local tooling/health checks)', () => {
    const { nexted } = run(ipHostGuard({ origins }), '127.0.0.1:3000');
    expect(nexted).toBe(true);
  });
});
