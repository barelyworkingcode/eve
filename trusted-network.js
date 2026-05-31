/**
 * TrustedNetworkService — IP-based network trust for Eve's auth bypass.
 *
 * Design rationale: see plans/cozy-honking-toast.md Section A. The previous
 * "localhost bypass" in auth.js and ws-handler.js trusted req.headers.host,
 * which is fully attacker-controllable — any remote client could set
 * `Host: localhost` and skip the passkey entirely. This module replaces that
 * check with one that reads ONLY req.socket.remoteAddress (the raw TCP source
 * address), normalized and compared against a set of trusted CIDR ranges.
 *
 * Never read req.headers.host or X-Forwarded-For here.
 */

const os = require('os');

const { NullLogger } = require('./logger');

// --- Pure helpers (exported for unit tests) ---

/**
 * Parse an IPv4 dotted-quad into a 32-bit unsigned integer.
 * Returns null if the input is not a valid IPv4 literal.
 */
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

/**
 * Normalize a remote address string.
 * - Strips IPv6-mapped IPv4 prefix (`::ffff:1.2.3.4` → `1.2.3.4`)
 * - Lower-cases IPv6 literals
 * - Returns null for empty / undefined inputs
 */
function normalizeIp(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const trimmed = ip.trim();
  if (!trimmed) return null;
  const mapped = trimmed.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (mapped) return mapped[1];
  return trimmed.toLowerCase();
}

/**
 * Parse an IPv4 CIDR ("10.0.0.0/24" or bare "10.0.0.1" == /32) into
 * { kind: 'v4', base, mask, prefix }.
 * Returns null for anything we don't understand — IPv6 CIDRs are
 * passed through as { kind: 'v6', literal } for exact match.
 */
function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const trimmed = cidr.trim();
  if (!trimmed) return null;

  const slash = trimmed.indexOf('/');
  const addr = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const prefixStr = slash === -1 ? null : trimmed.slice(slash + 1);

  // IPv4 branch
  const v4 = ipv4ToInt(addr);
  if (v4 !== null) {
    const prefix = prefixStr === null ? 32 : Number(prefixStr);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { kind: 'v4', base: (v4 & mask) >>> 0, mask, prefix };
  }

  // IPv6 branch — keep a normalized literal. We accept exact matches only
  // (no CIDR math for v6) because the only v6 cases we actually trust are
  // `::1` loopback and link-local addresses enumerated from the NICs.
  if (addr.includes(':')) {
    return { kind: 'v6', literal: addr.toLowerCase() };
  }

  return null;
}

/**
 * Private / non-routable IPv4 ranges. A trusted CIDR whose network base is
 * NOT inside one of these is a *public* range — trusting it grants passwordless
 * access to hosts on the public internet. Used only to warn operators; it does
 * not change trust decisions. See docs/security-audit-frontend.md (C2).
 */
const PRIVATE_V4_RANGES = [
  parseCidr('10.0.0.0/8'),
  parseCidr('172.16.0.0/12'),
  parseCidr('192.168.0.0/16'),
  parseCidr('127.0.0.0/8'),     // loopback
  parseCidr('169.254.0.0/16'),  // link-local
  parseCidr('100.64.0.0/10'),   // CGNAT
];

/**
 * True if a parsed v4 CIDR's network base is a public (internet-routable)
 * address. Non-v4 CIDRs return false (IPv6 trust here is only loopback/
 * link-local literals, handled elsewhere).
 */
function isPublicV4Cidr(cidr) {
  if (!cidr || cidr.kind !== 'v4') return false;
  return !PRIVATE_V4_RANGES.some(
    (r) => r && ((cidr.base & r.mask) >>> 0) === r.base
  );
}

/**
 * True if `ip` is a public (internet-routable) address — i.e. NOT loopback,
 * RFC1918 private, link-local, CGNAT, or an IPv6 loopback/ULA/link-local. Used
 * to HARD-block first-passkey enrollment from the internet. Unparseable/empty
 * input is treated as public (fail-safe: refuse the enrollment).
 */
function isPublicIp(ipRaw) {
  const ip = normalizeIp(ipRaw);
  if (!ip) return true; // unknown source — fail safe
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    return !PRIVATE_V4_RANGES.some((r) => r && ((v4 & r.mask) >>> 0) === r.base);
  }
  // IPv6
  if (ip === '::1') return false;                                 // loopback
  if (ip.startsWith('fe80')) return false;                        // link-local fe80::/10
  if (ip.startsWith('fc') || ip.startsWith('fd')) return false;   // ULA fc00::/7
  return true;
}

/**
 * Test whether an IP address falls inside any of the parsed CIDRs.
 */
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

/**
 * Extract the client's IP from an HTTP/WS request. This is the single
 * trustworthy source of the client's network identity.
 *
 * Do NOT consult req.headers.host or req.headers['x-forwarded-for'] —
 * both are attacker-controlled. If a reverse-proxy topology is added later,
 * gate XFF parsing on an explicit allow-list of trusted proxy IPs.
 */
function getClientIp(req) {
  return normalizeIp(req?.socket?.remoteAddress || '');
}

/**
 * Compute the default trusted CIDR set from the current host's network
 * interfaces. Always includes loopback. Non-internal IPv4 interfaces
 * contribute their network/prefix derived from `address` + `netmask`.
 *
 * If `env.EVE_TRUSTED_SUBNETS` is set, it REPLACES the default set —
 * operators can pin the trusted range explicitly (multi-NIC, VLAN, VPN).
 *
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {typeof os} [deps.osModule]
 */
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
      // Prefer the pre-computed cidr field when present (Node 10+).
      if (iface.cidr) {
        const parsed = parseCidr(iface.cidr);
        if (parsed) cidrs.push(parsed);
        continue;
      }
      // IPv4 fallback: derive prefix from netmask.
      if (iface.family === 'IPv4' && iface.address && iface.netmask) {
        const netInt = ipv4ToInt(iface.netmask);
        const addrInt = ipv4ToInt(iface.address);
        if (netInt === null || addrInt === null) continue;
        // netmask → prefix length via popcount
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

// --- DI-injectable service ---

class TrustedNetworkService {
  /**
   * @param {object} [deps]
   * @param {Logger} [deps.log]
   * @param {NodeJS.ProcessEnv} [deps.env]
   * @param {typeof os} [deps.osModule]
   */
  constructor({ log, env = process.env, osModule = os } = {}) {
    this.log = log || new NullLogger();
    this.disabled = env.EVE_DISABLE_SUBNET_BYPASS === '1';
    this.cidrs = computeTrustedCidrs({ env, osModule });

    if (this.disabled) {
      this.log.info('Subnet bypass disabled via EVE_DISABLE_SUBNET_BYPASS=1');
    } else {
      const summary = this.describe();
      this.log.info(`Trusted subnets: ${summary || '(none)'}`);

      // Loudly flag public ranges in the trusted set — on an internet-facing
      // host the primary NIC's subnet can be a provider-shared public range,
      // which would grant passwordless access (incl. terminal RCE) to unrelated
      // internet hosts. See docs/security-audit-frontend.md (C2).
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

  /**
   * Is the client at the other end of this request on a trusted subnet?
   * Honors EVE_DISABLE_SUBNET_BYPASS — i.e. governs whether trusted clients
   * SKIP the passkey.
   */
  isTrusted(req) {
    if (this.disabled) return false;
    return this.isInTrustedRange(req);
  }

  /**
   * Raw CIDR-membership test, INDEPENDENT of EVE_DISABLE_SUBNET_BYPASS.
   * The bypass flag decides whether trusted networks skip the passkey; it must
   * not also decide who may bootstrap the very first enrollment, or disabling
   * it on an un-enrolled box would lock everyone out. The enrollment gate uses
   * this so the LAN/WireGuard can always reach the enroll flow before a passkey
   * exists. See enrollment-gate.js.
   */
  isInTrustedRange(req) {
    const ip = getClientIp(req);
    if (!ip) return false;
    return isIpInCidrs(ip, this.cidrs);
  }

  /**
   * Human-readable summary of a CIDR list (defaults to the trusted set).
   * Used for startup logging.
   */
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

module.exports = {
  TrustedNetworkService,
  computeTrustedCidrs,
  isIpInCidrs,
  isPublicV4Cidr,
  isPublicIp,
  getClientIp,
  parseCidr,
  normalizeIp,
  ipv4ToInt,
};
