const express = require('express');
const { getClientIp } = require('../trusted-network');

const { NullLogger } = require('../logger');

// Enrolled-and-closed response for both enroll routes and a refused
// enrolment-window consume — same text so a browser sees one message
// regardless of which check caught it.
const ENROLLMENT_CLOSED_MESSAGE =
  'Enrollment is not open. Open it from the Relay tray or with `relay eve enrol`.';

// No enrollmentWindow (legacy positional call, or eve started without relay)
// means the additional-enrolment path can never be confirmed open — fail
// closed, same as a null-transport EnrollmentWindow.
const CLOSED_WINDOW = { isOpen: async () => ({ open: false }) };

function createAuthRoutes(authService, trustedNetwork, log, { enrollmentWindow } = {}) {
  log = log || new NullLogger();
  const window = enrollmentWindow || CLOSED_WINDOW;
  const router = express.Router();

  function rateLimit(req, res, next) {
    const ip = getClientIp(req) || 'unknown';
    if (!authService.checkRateLimit(ip)) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    next();
  }

  function requireEnrolled(req, res, next) {
    if (!authService.isEnrolled()) {
      return res.status(400).json({ error: 'Not enrolled' });
    }
    next();
  }

  // Not enrolled -> proceed (the pre-enrollment gate already applied its
  // network rules upstream). Enrolled -> only proceed while relay's
  // enrolment window is open; a second browser adding itself ignores the
  // first-passkey network rules entirely (see
  // ../relay/docs/eve-passkey-enrolment.md decision 4).
  async function requireEnrollable(req, res, next) {
    if (!authService.isEnrolled()) return next();
    const { open } = await window.isOpen();
    if (open) return next();
    return res.status(403).json({ error: ENROLLMENT_CLOSED_MESSAGE });
  }

  function validateFinishBody(req, res, next) {
    const { response, challengeId } = req.body;
    if (!response || typeof response !== 'object' || !challengeId || typeof challengeId !== 'string') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    next();
  }

  router.get('/auth/status', async (req, res) => {
    if (trustedNetwork.isTrusted(req) || process.env.EVE_NO_AUTH === '1') {
      return res.json({ enrolled: false, authenticated: true, trusted: true });
    }
    const enrolled = authService.isEnrolled();
    const token = req.headers['x-session-token'];
    const authenticated = enrolled && authService.validateSession(token);
    const status = { enrolled, authenticated };
    // Only an unauthenticated-but-enrolled tab needs this — an authenticated
    // tab (or a fresh box with no owner yet) never has a reason to ask relay.
    if (enrolled && !authenticated) {
      const { open, expires } = await window.isOpen();
      status.enrollmentOpen = open;
      if (open) status.enrollmentExpires = expires;
    }
    res.json(status);
  });

  router.post('/auth/enroll/start', rateLimit, requireEnrollable, async (req, res) => {
    try {
      const { options, challengeId } = await authService.generateEnrollmentOptions(req);
      res.json({ options, challengeId });
    } catch (err) {
      log.error('Enrollment start failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/auth/enroll/finish', rateLimit, requireEnrollable, validateFinishBody, async (req, res) => {
    try {
      const { response, challengeId } = req.body;
      // Captured before verification: an additional enrolment (as opposed to
      // the very first) is the one case that must consume relay's window
      // before the credential is written. See
      // ../relay/docs/eve-passkey-enrolment.md decision 3: verify -> consume -> save.
      const additionalEnrollment = authService.isEnrolled();

      const pending = await authService.verifyEnrollment(req, response, challengeId);

      if (additionalEnrollment) {
        const consumed = await window.consume({ ip: getClientIp(req), label: pending.label });
        if (!consumed) {
          return res.status(403).json({ error: ENROLLMENT_CLOSED_MESSAGE });
        }
      }

      const token = authService.addCredential(pending);
      res.json({ token });
    } catch (err) {
      log.error('Enrollment finish failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/auth/login/start', rateLimit, requireEnrolled, async (req, res) => {
    try {
      const { options, challengeId } = await authService.generateLoginOptions(req);
      res.json({ options, challengeId });
    } catch (err) {
      log.error('Login start failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/auth/login/finish', rateLimit, requireEnrolled, validateFinishBody, async (req, res) => {
    try {
      const { response, challengeId } = req.body;
      const token = await authService.verifyLogin(req, response, challengeId);
      res.json({ token });
    } catch (err) {
      log.error('Login finish failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

  // WKWebView blocks WebAuthn unless the app has a verified Associated
  // Domains entitlement, which requires Apple's CDN to reach the domain —
  // impossible for local hostnames like eve.lan. This route serves a
  // standalone page that runs in ASWebAuthenticationSession (Safari context)
  // where passkeys work natively.
  router.get('/auth/safari-login', (req, res) => {
    res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Home|Work – Sign In</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a1a; color: #e0e0e0;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #2a2a2a; border-radius: 16px; padding: 32px; text-align: center; max-width: 320px; }
  .card h1 { font-size: 20px; margin: 0 0 8px; }
  .card p { color: #999; font-size: 14px; margin: 0 0 24px; }
  button { background: #3b82f6; color: #fff; border: none; border-radius: 10px; padding: 14px 32px;
           font-size: 16px; width: 100%; cursor: pointer; }
  button:disabled { opacity: 0.5; }
  .error { color: #f87171; font-size: 13px; margin-top: 16px; }
  .success { color: #4ade80; font-size: 14px; margin-top: 16px; }
</style>
</head><body>
<div class="card">
  <h1>Home|Work</h1>
  <p>Authenticate with your passkey.</p>
  <button id="btn" onclick="doLogin()">Sign In with Passkey</button>
  <div id="status"></div>
</div>
<script>
function b64url2buf(b) {
  var s = b.replace(/-/g,'+').replace(/_/g,'/');
  s += '='.repeat((4 - s.length % 4) % 4);
  var r = atob(s), a = new Uint8Array(r.length);
  for (var i = 0; i < r.length; i++) a[i] = r.charCodeAt(i);
  return a.buffer;
}
function buf2b64url(b) {
  var a = new Uint8Array(b), s = '';
  for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'');
}
async function doLogin() {
  var btn = document.getElementById('btn'), st = document.getElementById('status');
  btn.disabled = true; st.textContent = '';
  try {
    var r1 = await fetch('/api/auth/login/start', {method:'POST'});
    if (!r1.ok) throw new Error('Server error');
    var d1 = await r1.json();
    var cred = await navigator.credentials.get({
      publicKey: {
        ...d1.options,
        challenge: b64url2buf(d1.options.challenge),
        allowCredentials: (d1.options.allowCredentials||[]).map(function(c) {
          return {...c, id: b64url2buf(c.id)};
        })
      }
    });
    var body = {
      response: {
        id: cred.id,
        rawId: buf2b64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: buf2b64url(cred.response.clientDataJSON),
          authenticatorData: buf2b64url(cred.response.authenticatorData),
          signature: buf2b64url(cred.response.signature),
          userHandle: cred.response.userHandle ? buf2b64url(cred.response.userHandle) : null
        },
        clientExtensionResults: cred.getClientExtensionResults()
      },
      challengeId: d1.challengeId
    };
    var r2 = await fetch('/api/auth/login/finish', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
    });
    if (!r2.ok) throw new Error('Verification failed');
    var d2 = await r2.json();
    st.className = 'success'; st.textContent = 'Success! Returning to app…';
    setTimeout(function() { window.location.href = 'relayclient://auth-callback?token=' + encodeURIComponent(d2.token); }, 300);
  } catch(e) {
    st.className = 'error'; st.textContent = e.message || 'Authentication failed';
    btn.disabled = false;
  }
}
// Auto-trigger on load so the passkey prompt appears immediately in the Safari sheet
setTimeout(doLogin, 500);
</script>
</body></html>`);
  });

  return router;
}

module.exports = createAuthRoutes;
