const express = require('express');

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.socket?.remoteAddress ||
         'unknown';
}

function createAuthRoutes(authService) {
  const router = express.Router();

  // --- Shared middleware ---

  function rateLimit(req, res, next) {
    const ip = getClientIp(req);
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
    if (authService.isLocalhost(req)) {
      return res.json({ enrolled: false, authenticated: true, localhost: true });
    }
    const enrolled = authService.isEnrolled();
    const token = req.headers['x-session-token'];
    const authenticated = enrolled && authService.validateSession(token);
    res.json({ enrolled, authenticated });
  });

  router.post('/auth/enroll/start', rateLimit, requireNotEnrolled, async (req, res) => {
    try {
      const { options, challengeId } = await authService.generateEnrollmentOptions(req);
      console.log('[Auth] Enrollment started - rpId:', options.rp.id, 'origin:', authService.getOrigin(req));
      res.json({ options, challengeId });
    } catch (err) {
      console.error('Enrollment start failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/auth/enroll/finish', rateLimit, requireNotEnrolled, validateFinishBody, async (req, res) => {
    try {
      const { response, challengeId } = req.body;
      console.log('[Auth] Enrollment finish - credential.id from client:', response.id);
      console.log('[Auth] Enrollment finish - credential.rawId from client:', response.rawId);
      const token = await authService.verifyEnrollment(req, response, challengeId);
      res.json({ token });
    } catch (err) {
      console.error('Enrollment finish failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/auth/login/start', rateLimit, requireEnrolled, async (req, res) => {
    try {
      const { options, challengeId } = await authService.generateLoginOptions(req);
      console.log('[Auth] Login started - rpId:', options.rpId, 'origin:', authService.getOrigin(req));
      console.log('[Auth] Stored credential rpId from auth.json:', authService.loadCredentials()?.rpId || '(not stored)');
      console.log('[Auth] allowCredentials:', JSON.stringify(options.allowCredentials));
      res.json({ options, challengeId });
    } catch (err) {
      console.error('Login start failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/auth/login/finish', rateLimit, requireEnrolled, validateFinishBody, async (req, res) => {
    try {
      const { response, challengeId } = req.body;
      const token = await authService.verifyLogin(req, response, challengeId);
      res.json({ token });
    } catch (err) {
      console.error('Login finish failed:', err);
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = createAuthRoutes;
