// Until a passkey is enrolled, `/api/auth/enroll/*` is reachable by anyone;
// un-enrolled requests are allowed ONLY from a bootstrap-trusted client
// (loopback, a trusted subnet, or the explicit escape hatch) — everyone else
// gets a 404.
//
// Lockout-proofing: the trust check is `isInTrustedRange` (raw CIDR
// membership), NOT `isTrusted` — so it still works when
// EVE_DISABLE_SUBNET_BYPASS=1 disables the auth bypass.
//
// HARD RULE: a public (internet) source IP can NEVER bootstrap the first
// passkey, even with EVE_ALLOW_ENROLLMENT — that escape hatch only broadens
// to private networks. This assumes Eve sees the real client IP (NAT
// forward), not a loopback-terminating reverse proxy.
const { getClientIp, isPublicIp } = require('./trusted-network');

function canBootstrapEnrollment(req, { trustedNetwork, env = process.env } = {}) {
  const ip = getClientIp(req);
  if (isPublicIp(ip)) {
    return false;
  }
  if (env.EVE_ALLOW_ENROLLMENT === '1') return true;
  return !!trustedNetwork && trustedNetwork.isInTrustedRange(req);
}

// Shared by the HTTP gate and the WS upgrade check. No-op when auth is
// globally disabled (EVE_NO_AUTH=1).
function isEnrollmentBlocked(req, { authService, trustedNetwork, env = process.env } = {}) {
  if (env.EVE_NO_AUTH === '1') return false;
  if (authService.isEnrolled()) return false;
  return !canBootstrapEnrollment(req, { trustedNetwork, env });
}

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
