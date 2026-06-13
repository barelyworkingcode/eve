/**
 * Integration test for the WebAuthn HTTP routes (routes/auth.js). The status
 * short-circuits, the rate-limit / enrollment-gate middleware, and the body
 * validation all live in the router, so they need a real Express app. The
 * AuthService itself is faked — its ceremony logic is covered in
 * auth-ceremony.test.js.
 */
const http = require('http');
const express = require('express');
const createAuthRoutes = require('../../routes/auth');

describe('auth routes', () => {
  let server;
  let baseUrl;
  let authService;
  let trustedNetwork;

  beforeAll((done) => {
    authService = {
      isEnrolled: jest.fn(() => false),
      validateSession: jest.fn(() => false),
      checkRateLimit: jest.fn(() => true),
      generateEnrollmentOptions: jest.fn(),
      verifyEnrollment: jest.fn(),
      generateLoginOptions: jest.fn(),
      verifyLogin: jest.fn(),
    };
    trustedNetwork = { isTrusted: jest.fn(() => false) };

    const app = express();
    app.use(express.json());
    app.use('/api', createAuthRoutes(authService, trustedNetwork, null));
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    authService.isEnrolled.mockReturnValue(false);
    authService.validateSession.mockReturnValue(false);
    authService.checkRateLimit.mockReturnValue(true);
    trustedNetwork.isTrusted.mockReturnValue(false);
    delete process.env.EVE_NO_AUTH;
  });

  const post = (p, body) => fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  describe('GET /auth/status', () => {
    it('reports authenticated+trusted for a trusted client without consulting credentials', async () => {
      trustedNetwork.isTrusted.mockReturnValue(true);
      const res = await fetch(`${baseUrl}/api/auth/status`);
      expect(await res.json()).toEqual({ enrolled: false, authenticated: true, trusted: true });
      expect(authService.validateSession).not.toHaveBeenCalled();
    });

    it('reports authenticated+trusted when EVE_NO_AUTH=1', async () => {
      process.env.EVE_NO_AUTH = '1';
      const res = await fetch(`${baseUrl}/api/auth/status`);
      expect(await res.json()).toMatchObject({ authenticated: true, trusted: true });
    });

    it('authenticates an enrolled client with a valid session token', async () => {
      authService.isEnrolled.mockReturnValue(true);
      authService.validateSession.mockReturnValue(true);
      const res = await fetch(`${baseUrl}/api/auth/status`, { headers: { 'x-session-token': 'tok' } });
      expect(authService.validateSession).toHaveBeenCalledWith('tok');
      expect(await res.json()).toEqual({ enrolled: true, authenticated: true });
    });

    it('reports not-authenticated for an enrolled client with an invalid token', async () => {
      authService.isEnrolled.mockReturnValue(true);
      authService.validateSession.mockReturnValue(false);
      const res = await fetch(`${baseUrl}/api/auth/status`, { headers: { 'x-session-token': 'bad' } });
      expect(await res.json()).toEqual({ enrolled: true, authenticated: false });
    });
  });

  describe('middleware gating', () => {
    it('returns 429 when the rate limit is exceeded', async () => {
      authService.checkRateLimit.mockReturnValue(false);
      const res = await post('/api/auth/enroll/start');
      expect(res.status).toBe(429);
      expect(authService.generateEnrollmentOptions).not.toHaveBeenCalled();
    });

    it('blocks enrollment when already enrolled (400 Already enrolled)', async () => {
      authService.isEnrolled.mockReturnValue(true);
      const res = await post('/api/auth/enroll/start');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Already enrolled');
    });

    it('blocks login when not enrolled (400 Not enrolled)', async () => {
      authService.isEnrolled.mockReturnValue(false);
      const res = await post('/api/auth/login/start');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Not enrolled');
    });

    it('rejects a finish call with a malformed body (400 Invalid request body)', async () => {
      authService.isEnrolled.mockReturnValue(true);
      const res = await post('/api/auth/login/finish', { response: 'not-an-object' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Invalid request body');
      expect(authService.verifyLogin).not.toHaveBeenCalled();
    });
  });

  describe('ceremony plumbing', () => {
    it('enroll/start returns options + challengeId', async () => {
      authService.generateEnrollmentOptions.mockResolvedValue({ options: { challenge: 'c' }, challengeId: 'cid' });
      const res = await post('/api/auth/enroll/start');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ options: { challenge: 'c' }, challengeId: 'cid' });
    });

    it('enroll/finish returns the session token on success', async () => {
      authService.verifyEnrollment.mockResolvedValue('session-token');
      const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: 'session-token' });
    });

    it('enroll/finish maps a verification failure to 400', async () => {
      authService.verifyEnrollment.mockRejectedValue(new Error('Verification failed'));
      const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Verification failed');
    });

    it('login/start maps an internal failure to 500', async () => {
      authService.isEnrolled.mockReturnValue(true);
      authService.generateLoginOptions.mockRejectedValue(new Error('No credentials enrolled'));
      const res = await post('/api/auth/login/start');
      expect(res.status).toBe(500);
    });

    it('login/finish returns the session token on success', async () => {
      authService.isEnrolled.mockReturnValue(true);
      authService.verifyLogin.mockResolvedValue('login-token');
      const res = await post('/api/auth/login/finish', { response: {}, challengeId: 'cid' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: 'login-token' });
    });
  });

  describe('GET /auth/safari-login', () => {
    it('serves the standalone passkey page', async () => {
      const res = await fetch(`${baseUrl}/api/auth/safari-login`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Sign In with Passkey');
      expect(html).toContain('relayclient://auth-callback');
    });
  });
});
