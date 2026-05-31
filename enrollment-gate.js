/**
 * Pre-enrollment gate — refuse REMOTE traffic until a passkey is enrolled.
 *
 * Eve's first-visitor-becomes-owner enrollment means `/api/auth/enroll/*` is
 * reachable until someone enrolls. On an internet-exposed instance a bot could
 * race you for ownership, and every scanner gets to poke the auth code. This
 * gate makes the app invisible from the network until the first passkey exists:
 * un-enrolled requests are allowed ONLY from a bootstrap-trusted client
 * (loopback, a trusted subnet, or the explicit escape hatch). Everyone else
 * gets a boring 404.
 *
 * Lockout-proofing: the trust check is `isInTrustedRange` (raw CIDR membership),
 * NOT `isTrusted` — so it works even when EVE_DISABLE_SUBNET_BYPASS=1 disables
 * the auth bypass. Loopback is always allowed, and EVE_ALLOW_ENROLLMENT=1 forces
 * the door open if DNS/trust isn't wired yet. You can never truly brick the box.
 *
 * HARD RULE: a public (internet) source IP can NEVER bootstrap the first passkey,
 * even with EVE_ALLOW_ENROLLMENT — the escape hatch only broadens to private
 * networks. The first passkey comes only from LAN / WireGuard / loopback. This
 * assumes Eve sees the real client IP (Firewalla NAT forward), NOT a loopback-
 * terminating reverse proxy.
 *
 * Once enrolled, the gate is a no-op and normal passkey auth takes over.
 */
const { getClientIp, isPublicIp } = require('./trusted-network');

/**
 * May this request bootstrap the first enrollment?
 *  - loopback                → always (local backstop)
 *  - public / internet IP    → NEVER (hard rule, even with the escape hatch)
 *  - EVE_ALLOW_ENROLLMENT=1  → yes for any PRIVATE source (escape hatch)
 *  - within a trusted CIDR   → yes (LAN / WireGuard), independent of the bypass flag
 */
function canBootstrapEnrollment(req, { trustedNetwork, env = process.env } = {}) {
  const ip = getClientIp(req);
  // isPublicIp returns false for loopback and private addresses, true only for internet IPs
  if (isPublicIp(ip)) {
    // The internet can never enroll the first passkey, hatch or not
    return false;
  }
  // Not public (loopback, private, or unparseable):
  // - Always allow loopback (local backstop)
  // - Check escape hatch for private networks
  if (env.EVE_ALLOW_ENROLLMENT === '1') return true;
  return !!trustedNetwork && trustedNetwork.isInTrustedRange(req);
}

/**
 * True if Eve should refuse this request because no passkey is enrolled yet and
 * the client isn't allowed to bootstrap. Shared by the HTTP gate and the WS
 * upgrade check. A no-op when auth is globally disabled (EVE_NO_AUTH=1).
 */
function isEnrollmentBlocked(req, { authService, trustedNetwork, env = process.env } = {}) {
  if (env.EVE_NO_AUTH === '1') return false;
  if (authService.isEnrolled()) return false;
  return !canBootstrapEnrollment(req, { trustedNetwork, env });
}

/** Express middleware form of the gate. */
function enrollmentGate({ authService, trustedNetwork, log, env = process.env }) {
  return function (req, res, next) {
    if (isEnrollmentBlocked(req, { authService, trustedNetwork, env })) {
      log?.warn?.(`Pre-enrollment request refused from ${getClientIp(req) || 'unknown'} (${req.method} ${req.url})`);
      res.status(404).set('Cache-Control', 'no-store').type('txt').send('Not found');
      return;
    }
    next();
  };
}

module.exports = { enrollmentGate, isEnrollmentBlocked, canBootstrapEnrollment };
