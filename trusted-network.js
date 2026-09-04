/**
 * Never read req.headers.host or X-Forwarded-For for authorization here; the
 * only safe network identity is req.socket.remoteAddress.
 * See docs/security-review-auth-transport.md.
 */

const os = require('os');

const { NullLogger } = require('./logger');

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    value = (value * 256) + n;
  }
  return value >>> 0;
}

function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;
  const mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  return trimmed.toLowerCase();
}

function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const trimmed = cidr.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf('/');
  const addr = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixStr = slash === -1 ? null : trimmed.slice(slash + 1);

  const v4 = ipv4ToInt(addr);
  if (v4 !== null) {
    const prefix = prefixStr === null ? 32 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { kind: 'v4', base: (v4 & mask) >>> 0, mask, prefix };
  }

  // IPv6: exact-match only (no CIDR math) — only loopback and link-local
  // literals are trusted here.
  if (addr.includes(':')) {
    return { kind: 'v6', literal: addr.toLowerCase() };
  }

  return null;
}

// A trusted CIDR whose base falls outside these ranges is public — trusting
// it grants passwordless access from the internet. Warn-only; does not change
// trust decisions. See docs/security-audit-frontend.md (C2).
const PRIVATE_V4_RANGES = [
  parseCidr('10.0.0.0/8'),
  parseCidr('172.16.0.0/12'),
  parseCidr('192.168.0.0/16'),
  parseCidr('127.0.0.0/8'),     // loopback
  parseCidr('169.254.0.0/16'),  // link-local
  parseCidr('100.64.0.0/10'),   // CGNAT
];

function isPublicV4Cidr(cidr) {
  if (!cidr || cidr.kind !== 'v4') return false;
  return !PRIVATE_V4_RANGES.some(
    (r) => r && ((cidr.base & r.mask) >>> 0) === r.base
  );
}

// Used to hard-block first-passkey enrollment from the internet (see
// enrollment-gate.js). Unparseable/empty input is treated as public — fail
// safe, refuse the enrollment.
function isPublicIp(ipRaw) {
  const ip = normalizeIp(ipRaw);
  if (!ip) return true; // unknown source — fail safe
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return !PRIVATE_V4_RANGES.some((r) => r && ((v4 & r.mask) >>> 0) === r.base);
  }
  if (ip === '::1') return false;                                 // loopback
  if (ip.startsWith('fe80')) return false;                        // link-local fe80::/10
  if (ip.startsWith('fc') || ip.startsWith('fd')) return false;   // ULA fc00::/7
  return true;
}

function isIpInCidrs(ip, cidrs) {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;

  const v4Int = ipv4ToInt(normalized);

  for (const cidr of cidrs) {
    if (!cidr) continue;
    if (cidr.kind === 'v4' && v4Int !== null) {
      if (((v4Int & cidr.mask) >>> 0) === cidr.base) return true;
    } else if (cidr.kind === 'v6' && v4Int === null) {
      if (normalized === cidr.literal) return true;
    }
  }
  return false;
}

// The only trustworthy source of client identity. Never consult
// req.headers.host or req.headers['x-forwarded-for'] — both are
// attacker-controlled. If reverse-proxy support is added, gate XFF parsing on
// an explicit trusted-proxy allowlist.
function getClientIp(req) {
  return normalizeIp(req?.socket?.remoteAddress || '');
}

function computeTrustedCidrs({ env = process.env, osModule = os } = {}) {
  const override = env.EVE_TRUSTED_SUBNETS;
  if (override && override.trim()) {
    return override
      .split(',')
      .map((s) => parseCidr(s))
      .filter((c) => c !== null);
  }

  const cidrs = [
    parseCidr('127.0.0.0/8'),
    parseCidr('::1'),
  ];

  let interfaces;
  try {
    interfaces = osModule.networkInterfaces();
  } catch {
    return cidrs.filter((c) => c !== null);
  }

  for (const list of Object.values(interfaces || {})) {
    if (!Array.isArray(list)) continue;
    for (const iface of list) {
      if (!iface || iface.internal) continue;
      if (iface.cidr) {
        const parsed = parseCidr(iface.cidr);
        if (parsed) cidrs.push(parsed);
        continue;
      }
      if (iface.family === 'IPv4' && iface.address && iface.netmask) {
        const netInt = ipv4ToInt(iface.netmask);
        const addrInt = ipv4ToInt(iface.address);
        if (netInt === null || addrInt === null) continue;
        let prefix = 0;
        let m = netInt;
        while (m) { prefix += m & 1; m >>>= 1; }
        const parsed = parseCidr(`${iface.address}/${prefix}`);
        if (parsed) {
          parsed.base = (addrInt & parsed.mask) >>> 0;
          cidrs.push(parsed);
        }
      }
    }
  }

  return cidrs.filter((c) => c !== null);
}

class TrustedNetworkService {
  constructor({ log, env = process.env, osModule = os } = {}) {
    this.log = log || new NullLogger();
    this.disabled = env.EVE_DISABLE_SUBNET_BYPASS === '1';
    this.cidrs = computeTrustedCidrs({ env, osModule });

    if (this.disabled) {
      this.log.info('Subnet bypass disabled via EVE_DISABLE_SUBNET_BYPASS=1');
    } else {
      const summary = this.describe();
      this.log.info(`Trusted subnets: ${summary || '(none)'}`);

      // A provider-shared public subnet on the primary NIC would grant
      // passwordless access (incl. terminal RCE) to unrelated internet hosts.
      // See docs/security-audit-frontend.md (C2).
      const publicCidrs = this.cidrs.filter(isPublicV4Cidr);
      if (publicCidrs.length) {
        this.log.warn(
          `Trusted subnet set includes PUBLIC IP range(s): ${this.describe(publicCidrs)}. ` +
          `This grants passwordless access to those addresses. For internet-facing ` +
          `deployments set EVE_DISABLE_SUBNET_BYPASS=1 or pin EVE_TRUSTED_SUBNETS to a range you control.`
        );
      }
    }
  }

  isTrusted(req) {
    if (this.disabled) return false;
    return this.isInTrustedRange(req);
  }

  // Independent of EVE_DISABLE_SUBNET_BYPASS: that flag governs whether
  // trusted networks skip the passkey, but must not also gate first-passkey
  // enrollment — disabling it on an un-enrolled box would lock everyone out.
  // enrollment-gate.js uses this for that reason.
  isInTrustedRange(req) {
    const ip = getClientIp(req);
    if (!ip) return false;
    return isIpInCidrs(ip, this.cidrs);
  }

  describe(cidrs = this.cidrs) {
    return cidrs
      .map((c) => {
        if (c.kind === 'v4') {
          const a = (c.base >>> 24) & 0xff;
          const b = (c.base >>> 16) & 0xff;
          const d = (c.base >>> 8) & 0xff;
          const e = c.base & 0xff;
          return `${a}.${b}.${d}.${e}/${c.prefix}`;
        }
        return c.literal;
      })
      .join(', ');
  }
}

const LOOPBACK_CIDRS = [parseCidr('127.0.0.0/8'), parseCidr('::1')];

// `localhost` is checked by name because it never reaches ipv4ToInt: callers
// pass a listen address (which may be a hostname), not a peer IP.
function isLoopbackHost(host) {
  const normalized = normalizeIp(host);
  if (!normalized) return false;
  if (normalized === 'localhost') return true;
  return isIpInCidrs(normalized, LOOPBACK_CIDRS);
}

module.exports = {
  TrustedNetworkService,
  computeTrustedCidrs,
  isLoopbackHost,
  isIpInCidrs,
  isPublicV4Cidr,
  isPublicIp,
  getClientIp,
  parseCidr,
  normalizeIp,
  ipv4ToInt,
};
