// The status short-circuits, rate-limit/enrollment-gate middleware, and body
// validation all live in the router, so they need a real Express app. AuthService
// itself is faked here — its ceremony logic is covered in auth-ceremony.test.js.
const http = require('http');
const express = require('express');
const createAuthRoutes = require('../../routes/auth');

const ENROLLMENT_CLOSED_MESSAGE =
  'Enrollment is not open. Open it from the Relay tray or with `relay eve enrol`.';

function startApp(router) {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    app.use('/api', router);
    const server = http.createServer(app).listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('auth routes', () => {
  let server;
  let baseUrl;
  let authService;
  let trustedNetwork;

  beforeAll(async () => {
    authService = {
      isEnrolled: jest.fn(() => false),
      validateSession: jest.fn(() => false),
      checkRateLimit: jest.fn(() => true),
      generateEnrollmentOptions: jest.fn(),
      verifyEnrollment: jest.fn(),
      addCredential: jest.fn(),
      generateLoginOptions: jest.fn(),
      verifyLogin: jest.fn(),
      credentialIdFromAssertion: jest.fn((r) => r?.id),
    };
    trustedNetwork = { isTrusted: jest.fn(() => false) };

    // No `enrollmentWindow` or `passkeySync` passed — the legacy positional-signature call.
    // requireEnrollable must fail closed in this mode (see routes/auth.js
    // CLOSED_WINDOW), so every "already enrolled" case here is the
    // window-closed case.
    ({ server, baseUrl } = await startApp(createAuthRoutes(authService, trustedNetwork, null)));
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    authService.isEnrolled.mockReturnValue(false);
    authService.validateSession.mockReturnValue(false);
    authService.checkRateLimit.mockReturnValue(true);
    authService.generateEnrollmentOptions.mockReset();
    authService.verifyEnrollment.mockReset();
    authService.addCredential.mockReset();
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

    it('omits enrollmentOpen for a fresh box (not enrolled)', async () => {
      const res = await fetch(`${baseUrl}/api/auth/status`);
      expect(await res.json()).toEqual({ enrolled: false, authenticated: false });
    });

    it('authenticates an enrolled client with a valid session token, and omits enrollmentOpen', async () => {
      authService.isEnrolled.mockReturnValue(true);
      authService.validateSession.mockReturnValue(true);
      const res = await fetch(`${baseUrl}/api/auth/status`, { headers: { 'x-session-token': 'tok' } });
      expect(authService.validateSession).toHaveBeenCalledWith('tok');
      expect(await res.json()).toEqual({ enrolled: true, authenticated: true });
    });

    it('reports not-authenticated for an enrolled client with an invalid token, and enrollmentOpen: false', async () => {
      authService.isEnrolled.mockReturnValue(true);
      authService.validateSession.mockReturnValue(false);
      const res = await fetch(`${baseUrl}/api/auth/status`, { headers: { 'x-session-token': 'bad' } });
      expect(await res.json()).toEqual({ enrolled: true, authenticated: false, enrollmentOpen: false });
    });
  });

  describe('middleware gating', () => {
    it('returns 429 when the rate limit is exceeded', async () => {
      authService.checkRateLimit.mockReturnValue(false);
      const res = await post('/api/auth/enroll/start');
      expect(res.status).toBe(429);
      expect(authService.generateEnrollmentOptions).not.toHaveBeenCalled();
    });

    it('blocks enroll/start when enrolled and the window is closed (403, nothing called)', async () => {
      authService.isEnrolled.mockReturnValue(true);
      const res = await post('/api/auth/enroll/start');
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(ENROLLMENT_CLOSED_MESSAGE);
      expect(authService.generateEnrollmentOptions).not.toHaveBeenCalled();
    });

    it('blocks enroll/finish when enrolled and the window is closed (403, nothing saved)', async () => {
      authService.isEnrolled.mockReturnValue(true);
      const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe(ENROLLMENT_CLOSED_MESSAGE);
      expect(authService.verifyEnrollment).not.toHaveBeenCalled();
      expect(authService.addCredential).not.toHaveBeenCalled();
    });

    it('allows enroll/start when not enrolled, regardless of the window', async () => {
      authService.generateEnrollmentOptions.mockResolvedValue({ options: {}, challengeId: 'cid' });
      const res = await post('/api/auth/enroll/start');
      expect(res.status).toBe(200);
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

  describe('ceremony plumbing (first enrolment — not enrolled)', () => {
    it('enroll/start returns options + challengeId', async () => {
      authService.generateEnrollmentOptions.mockResolvedValue({ options: { challenge: 'c' }, challengeId: 'cid' });
      const res = await post('/api/auth/enroll/start');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ options: { challenge: 'c' }, challengeId: 'cid' });
    });

    it('enroll/finish verifies then persists (addCredential), and returns the session token', async () => {
      authService.verifyEnrollment.mockResolvedValue({ id: 'cred-1', label: 'ua' });
      authService.addCredential.mockReturnValue('session-token');

      const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: 'session-token' });
      expect(authService.addCredential).toHaveBeenCalledWith({ id: 'cred-1', label: 'ua' });
    });

    it('enroll/finish maps a verification failure to 400 and never calls addCredential', async () => {
      authService.verifyEnrollment.mockRejectedValue(new Error('Verification failed'));
      const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('Verification failed');
      expect(authService.addCredential).not.toHaveBeenCalled();
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

describe('auth routes — additional enrolment (window open)', () => {
  let server;
  let baseUrl;
  let authService;
  let trustedNetwork;
  let enrollmentWindow;

  beforeAll(async () => {
    authService = {
      isEnrolled: jest.fn(() => true), // this whole suite is "already owned"
      validateSession: jest.fn(() => false),
      checkRateLimit: jest.fn(() => true),
      generateEnrollmentOptions: jest.fn(),
      verifyEnrollment: jest.fn(),
      addCredential: jest.fn(),
      generateLoginOptions: jest.fn(),
      verifyLogin: jest.fn(),
    };
    trustedNetwork = { isTrusted: jest.fn(() => false) };
    enrollmentWindow = { isOpen: jest.fn(), consume: jest.fn() };

    ({ server, baseUrl } = await startApp(
      createAuthRoutes(authService, trustedNetwork, null, { enrollmentWindow })
    ));
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    authService.generateEnrollmentOptions.mockReset();
    authService.verifyEnrollment.mockReset();
    authService.addCredential.mockReset();
    enrollmentWindow.isOpen.mockReset().mockResolvedValue({ open: true, expires: '2026-09-07T10:15:00Z' });
    enrollmentWindow.consume.mockReset();
  });

  const post = (p, body) => fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  it('GET /auth/status reports enrollmentOpen + enrollmentExpires while unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/api/auth/status`);
    expect(await res.json()).toEqual({
      enrolled: true, authenticated: false,
      enrollmentOpen: true, enrollmentExpires: '2026-09-07T10:15:00Z',
    });
  });

  it('enroll/start proceeds while the window is open', async () => {
    authService.generateEnrollmentOptions.mockResolvedValue({ options: { challenge: 'c' }, challengeId: 'cid' });
    const res = await post('/api/auth/enroll/start');
    expect(res.status).toBe(200);
  });

  it('enroll/finish verifies before consuming, then consumes before saving', async () => {
    const callOrder = [];
    authService.verifyEnrollment.mockImplementation(async () => { callOrder.push('verify'); return { id: 'c', label: 'ua' }; });
    enrollmentWindow.consume.mockImplementation(async () => { callOrder.push('consume'); return true; });
    authService.addCredential.mockImplementation(() => { callOrder.push('save'); return 'tok'; });

    const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'tok' });
    expect(callOrder).toEqual(['verify', 'consume', 'save']);
    expect(enrollmentWindow.consume).toHaveBeenCalledWith({ ip: expect.any(String), label: 'ua' });
  });

  it('enroll/finish: a false consume (slot taken/expired) returns 403 and saves nothing', async () => {
    authService.verifyEnrollment.mockResolvedValue({ id: 'c', label: 'ua' });
    enrollmentWindow.consume.mockResolvedValue(false);

    const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(ENROLLMENT_CLOSED_MESSAGE);
    expect(authService.addCredential).not.toHaveBeenCalled();
  });

  it('enroll/finish: a failed ceremony never consumes the window', async () => {
    authService.verifyEnrollment.mockRejectedValue(new Error('Verification failed'));

    const res = await post('/api/auth/enroll/finish', { response: {}, challengeId: 'cid' });

    expect(res.status).toBe(400);
    expect(enrollmentWindow.consume).not.toHaveBeenCalled();
    expect(authService.addCredential).not.toHaveBeenCalled();
  });

  it('enroll/start refuses once the window closes (403, matches the enrolled-and-closed message)', async () => {
    enrollmentWindow.isOpen.mockResolvedValue({ open: false });
    const res = await post('/api/auth/enroll/start');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(ENROLLMENT_CLOSED_MESSAGE);
  });
});

describe('auth routes — passkey revocation check (login)', () => {
  let server;
  let baseUrl;
  let authService;
  let trustedNetwork;
  let passkeySync;

  beforeAll(async () => {
    authService = {
      isEnrolled: jest.fn(() => true),
      validateSession: jest.fn(() => false),
      checkRateLimit: jest.fn(() => true),
      generateLoginOptions: jest.fn(),
      verifyLogin: jest.fn(),
      credentialIdFromAssertion: jest.fn((r) => r?.id),
    };
    trustedNetwork = { isTrusted: jest.fn(() => false) };
    passkeySync = { checkRevoked: jest.fn(), apply: jest.fn(), report: jest.fn() };

    ({ server, baseUrl } = await startApp(
      createAuthRoutes(authService, trustedNetwork, null, { passkeySync })
    ));
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    authService.verifyLogin.mockReset();
    passkeySync.checkRevoked.mockReset().mockResolvedValue(false);
    passkeySync.apply.mockReset().mockResolvedValue();
    passkeySync.report.mockReset().mockResolvedValue();
  });

  const post = (p, body) => fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  it('refuses a revoked credential with 401 before verifyLogin ever runs, and applies the revocation', async () => {
    passkeySync.checkRevoked.mockResolvedValue(true);

    const res = await post('/api/auth/login/finish', { response: { id: 'revoked-cred' }, challengeId: 'cid' });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('This passkey has been revoked.');
    expect(passkeySync.checkRevoked).toHaveBeenCalledWith('revoked-cred');
    expect(passkeySync.apply).toHaveBeenCalledWith(['revoked-cred']);
    expect(authService.verifyLogin).not.toHaveBeenCalled();
  });

  it('proceeds to verifyLogin and reports afterward when the credential is not revoked', async () => {
    authService.verifyLogin.mockResolvedValue('tok');

    const res = await post('/api/auth/login/finish', { response: { id: 'good-cred' }, challengeId: 'cid' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: 'tok' });
    expect(passkeySync.checkRevoked).toHaveBeenCalledWith('good-cred');
    expect(authService.verifyLogin).toHaveBeenCalled();
    expect(passkeySync.apply).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r)); // fire-and-forget report() microtask
    expect(passkeySync.report).toHaveBeenCalled();
  });
});
