const express = require('express');
const { getClientIp } = require('../trusted-network');

const { NullLogger } = require('../logger');

function createAuthRoutes(authService, trustedNetwork, log) {
  log = log || new NullLogger();
  const router = express.Router();

  // --- Shared middleware ---

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

  function requireNotEnrolled(req, res, next) {
    if (authService.isEnrolled()) {
      return res.status(400).json({ error: 'Already enrolled' });
    }
    next();
  }

  function validateFinishBody(req, res, next) {
    const { response, challengeId } = req.body;
    if (!response || typeof response !== 'object' || !challengeId || typeof challengeId !== 'string') {
      return res.status(400).json({ error: 'Invalid request body' });
    }
    next();
  }

  // --- Routes ---

  router.get('/auth/status', (req, res) => {
    // Network-layer bypass (trusted subnet) and the global kill-switch both
    // short-circuit the UI's passkey flow. The response field is called
    // `trusted` because this is not specifically about loopback anymore —
    // any client inside the trusted CIDR set gets the same treatment.
    if (trustedNetwork.isTrusted(req) || process.env.EVE_NO_AUTH === '1') {
      return res.json({ enrolled: false, authenticated: true, trusted: true });
    }
    const enrolled = authService.isEnrolled();
    const token = req.headers['x-session-token'];
    const authenticated = enrolled && authService.validateSession(token);
    res.json({ enrolled, authenticated });
  });

  router.post('/auth/enroll/start', rateLimit, requireNotEnrolled, async (req, res) => {
    try {
      const { options, challengeId } = await authService.generateEnrollmentOptions(req);
      res.json({ options, challengeId });
    } catch (err) {
      log.error('Enrollment start failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/auth/enroll/finish', rateLimit, requireNotEnrolled, validateFinishBody, async (req, res) => {
    try {
      const { response, challengeId } = req.body;
      const token = await authService.verifyEnrollment(req, response, challengeId);
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

  // --- Safari passkey flow for iOS native apps ---
  //
  // WKWebView blocks WebAuthn unless the app has a verified Associated
  // Domains entitlement, which requires Apple's CDN to reach the domain —
  // impossible for local hostnames like eve.lan. This route serves a
  // standalone page that runs in ASWebAuthenticationSession (Safari context)
  // where passkeys work natively. After a successful ceremony, it redirects
  // to relayclient://auth-callback?token=<session-token>.

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
