const os = require('os');
const fs = require('fs');
const path = require('path');

// WebAuthn crypto is mocked: these tests pin AuthService's own logic
// (counter persistence, challenge lifecycle, rate limiting), not the library's
// signature math.
jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(),
  verifyRegistrationResponse: jest.fn(),
  generateAuthenticationOptions: jest.fn(),
  verifyAuthenticationResponse: jest.fn(),
}));
const swa = require('@simplewebauthn/server');
const AuthService = require('../../auth');

const req = { get: (h) => (h === 'host' ? 'localhost:3000' : undefined), secure: false };

function enroll(auth, counter = 5) {
  auth.saveCredentials({
    rpId: 'localhost',
    credentials: [{
      id: 'cred-1',
      publicKey: Buffer.from('public-key-bytes').toString('base64url'),
      counter,
      transports: ['internal'],
    }],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('AuthService', () => {
  let dataDir;
  let auth;

  beforeEach(() => {
    delete process.env.EVE_PUBLIC_ORIGIN;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-auth-test-'));
    auth = new AuthService(dataDir);
    swa.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 6 } });
  });

  afterEach(() => {
    auth.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  describe('challenge lifecycle', () => {
    it('returns a stored challenge exactly once (one-time use)', () => {
      const id = auth.storeChallenge('chal-abc');
      expect(auth.getChallenge(id)).toBe('chal-abc');
      expect(auth.getChallenge(id)).toBeNull(); // consumed
    });

    it('returns null for an unknown challenge id', () => {
      expect(auth.getChallenge('does-not-exist')).toBeNull();
    });

    it('drops an expired challenge', () => {
      const id = auth.storeChallenge('chal-old');
      auth.challenges.get(id).expiresAt = Date.now() - 1; // force past expiry
      expect(auth.getChallenge(id)).toBeNull();
      expect(auth.challenges.has(id)).toBe(false);
    });

    it('consumeChallenge throws when the challenge is missing or expired', () => {
      expect(() => auth.consumeChallenge('missing')).toThrow('Challenge expired or invalid');
    });
  });

  describe('checkRateLimit', () => {
    it('allows up to the max attempts then blocks', () => {
      for (let i = 0; i < 10; i++) expect(auth.checkRateLimit('1.1.1.1')).toBe(true);
      expect(auth.checkRateLimit('1.1.1.1')).toBe(false);
    });

    it('tracks limits per IP independently', () => {
      for (let i = 0; i < 10; i++) auth.checkRateLimit('1.1.1.1');
      expect(auth.checkRateLimit('1.1.1.1')).toBe(false);
      expect(auth.checkRateLimit('2.2.2.2')).toBe(true);
    });

    it('resets the window once it has elapsed', () => {
      expect(auth.checkRateLimit('3.3.3.3')).toBe(true);
      auth.rateLimits.get('3.3.3.3').resetAt = Date.now() - 1; // force window expiry
      expect(auth.checkRateLimit('3.3.3.3')).toBe(true);
      expect(auth.rateLimits.get('3.3.3.3').attempts).toBe(1);
    });
  });

  describe('verifyLogin (signature-counter replay defense)', () => {
    it('passes the stored counter to the verifier and persists the advanced counter', async () => {
      enroll(auth, 5);
      const challengeId = auth.storeChallenge('login-chal');

      const session = await auth.verifyLogin(req, { id: 'cred-1' }, challengeId);

      // The stored counter must be handed to the verifier (else replay is undetectable).
      expect(swa.verifyAuthenticationResponse).toHaveBeenCalledWith(
        expect.objectContaining({ credential: expect.objectContaining({ counter: 5 }) })
      );
      // The advanced counter must be written back to disk.
      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
      expect(persisted.credentials[0].counter).toBe(6);
      expect(typeof session).toBe('string'); // a fresh session token
    });

    it('rejects an unknown credential id', async () => {
      enroll(auth, 5);
      await expect(auth.verifyLogin(req, { id: 'someone-else' }, auth.storeChallenge('c')))
        .rejects.toThrow('Unknown credential');
    });

    it('rejects when the verifier reports the assertion is not verified', async () => {
      enroll(auth, 5);
      swa.verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false });
      await expect(auth.verifyLogin(req, { id: 'cred-1' }, auth.storeChallenge('c')))
        .rejects.toThrow('Verification failed');
    });

    it('rejects when the challenge is invalid (consumed before credential lookup)', async () => {
      enroll(auth, 5);
      await expect(auth.verifyLogin(req, { id: 'cred-1' }, 'bogus-challenge'))
        .rejects.toThrow('Challenge expired or invalid');
    });
  });
});
