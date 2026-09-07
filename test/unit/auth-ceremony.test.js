const os = require('os');
const fs = require('fs');
const path = require('path');

// WebAuthn crypto is mocked: these tests pin AuthService's own logic, not the
// library's signature math.
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
      expect(auth.getChallenge(id)).toBeNull();
    });

    it('returns null for an unknown challenge id', () => {
      expect(auth.getChallenge('does-not-exist')).toBeNull();
    });

    it('drops an expired challenge', () => {
      const id = auth.storeChallenge('chal-old');
      auth.challenges.get(id).expiresAt = Date.now() - 1;
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
      auth.rateLimits.get('3.3.3.3').resetAt = Date.now() - 1;
      expect(auth.checkRateLimit('3.3.3.3')).toBe(true);
      expect(auth.rateLimits.get('3.3.3.3').attempts).toBe(1);
    });
  });

  describe('verifyEnrollment (verification only — does not persist)', () => {
    function attestationResponse(transports) {
      return { id: 'attestation', response: transports ? { transports } : {} };
    }

    it('returns the verified credential without writing auth.json', async () => {
      swa.verifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: { credential: { id: 'new-cred', publicKey: Buffer.from('pk-bytes'), counter: 0 } },
      });
      const challengeId = auth.storeChallenge('enroll-chal');

      const pending = await auth.verifyEnrollment(req, attestationResponse(['internal']), challengeId);

      expect(swa.verifyRegistrationResponse).toHaveBeenCalledWith(
        expect.objectContaining({ expectedChallenge: 'enroll-chal', expectedRPID: 'localhost' })
      );
      expect(pending).toMatchObject({
        rpId: 'localhost',
        id: 'new-cred',
        publicKey: Buffer.from('pk-bytes').toString('base64url'),
        counter: 0,
        transports: ['internal'],
      });
      expect(typeof pending.createdAt).toBe('string');
      expect(fs.existsSync(path.join(dataDir, 'auth.json'))).toBe(false);
    });

    it('base64url-encodes a binary credential id (simplewebauthn version compat)', async () => {
      const binId = Buffer.from([1, 2, 3, 4]);
      swa.verifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: { credential: { id: binId, publicKey: Buffer.from('pk'), counter: 0 } },
      });
      const pending = await auth.verifyEnrollment(req, attestationResponse(['internal']), auth.storeChallenge('c'));
      expect(pending.id).toBe(binId.toString('base64url'));
    });

    it('falls back to ["internal"] transports when the authenticator omits them', async () => {
      swa.verifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: { credential: { id: 'c', publicKey: Buffer.from('pk'), counter: 0 } },
      });
      const pending = await auth.verifyEnrollment(req, attestationResponse(null), auth.storeChallenge('c'));
      expect(pending.transports).toEqual(['internal']);
    });

    it('captures a sanitized User-Agent as the label', async () => {
      swa.verifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: { credential: { id: 'c', publicKey: Buffer.from('pk'), counter: 0 } },
      });
      const uaReq = { ...req, get: (h) => (h === 'user-agent' ? 'Mozilla/5.0 \x07(evil)\n'.padEnd(140, 'x') : req.get(h)) };
      const pending = await auth.verifyEnrollment(uaReq, attestationResponse(['internal']), auth.storeChallenge('c'));
      expect(pending.label).not.toMatch(/[\x00-\x1F\x7F]/);
      expect(pending.label.length).toBeLessThanOrEqual(120);
    });

    it('rejects (and saves nothing) when the verifier reports not verified', async () => {
      swa.verifyRegistrationResponse.mockResolvedValue({ verified: false });
      await expect(auth.verifyEnrollment(req, attestationResponse(['internal']), auth.storeChallenge('c')))
        .rejects.toThrow('Verification failed');
      expect(fs.existsSync(path.join(dataDir, 'auth.json'))).toBe(false);
    });

    it('rejects when the verifier returns no registrationInfo', async () => {
      swa.verifyRegistrationResponse.mockResolvedValue({ verified: true, registrationInfo: null });
      await expect(auth.verifyEnrollment(req, attestationResponse(['internal']), auth.storeChallenge('c')))
        .rejects.toThrow('Verification failed');
    });

    it('rejects an invalid/consumed challenge before calling the verifier', async () => {
      await expect(auth.verifyEnrollment(req, attestationResponse(['internal']), 'bogus-challenge'))
        .rejects.toThrow('Challenge expired or invalid');
      expect(swa.verifyRegistrationResponse).not.toHaveBeenCalled();
    });
  });

  describe('addCredential (persistence, dedupe, multi-credential file shape)', () => {
    it('persists a first credential with a fresh random userId and a session token', async () => {
      const session = auth.addCredential({
        rpId: 'localhost', id: 'cred-1', publicKey: 'pk1', counter: 0,
        transports: ['internal'], label: 'Browser A', createdAt: '2026-01-01T00:00:00.000Z',
      });

      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
      expect(persisted.rpId).toBe('localhost');
      expect(persisted.createdAt).toBe('2026-01-01T00:00:00.000Z');
      expect(typeof persisted.userId).toBe('string');
      expect(persisted.userId.length).toBeGreaterThan(0);
      expect(persisted.credentials).toEqual([{
        id: 'cred-1', publicKey: 'pk1', counter: 0, transports: ['internal'],
        label: 'Browser A', createdAt: '2026-01-01T00:00:00.000Z',
      }]);
      expect(typeof session).toBe('string');
    });

    it('appends a second credential, keeps the first, and reuses the stable userId', async () => {
      auth.addCredential({
        rpId: 'localhost', id: 'cred-1', publicKey: 'pk1', counter: 0,
        transports: ['internal'], label: 'Browser A', createdAt: '2026-01-01T00:00:00.000Z',
      });
      const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));

      auth.addCredential({
        rpId: 'localhost', id: 'cred-2', publicKey: 'pk2', counter: 0,
        transports: ['internal', 'hybrid'], label: 'Browser B', createdAt: '2026-01-02T00:00:00.000Z',
      });
      const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));

      expect(after.userId).toBe(before.userId);
      expect(after.createdAt).toBe(before.createdAt); // file-level createdAt is set once
      expect(after.credentials.map((c) => c.id)).toEqual(['cred-1', 'cred-2']);
    });

    it('mints the session with the new credential\'s id as its parent', async () => {
      const token = auth.addCredential({
        rpId: 'localhost', id: 'cred-1', publicKey: 'pk1', counter: 0,
        transports: ['internal'], label: 'Browser A', createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(auth.sessionStore.sessions.get(token).credentialId).toBe('cred-1');
    });

    it('dedupes by credential id instead of appending a duplicate', async () => {
      auth.addCredential({
        rpId: 'localhost', id: 'cred-1', publicKey: 'pk1', counter: 0,
        transports: ['internal'], label: 'Browser A', createdAt: '2026-01-01T00:00:00.000Z',
      });
      auth.addCredential({
        rpId: 'localhost', id: 'cred-1', publicKey: 'pk1-updated', counter: 0,
        transports: ['internal'], label: 'Browser A (again)', createdAt: '2026-01-03T00:00:00.000Z',
      });

      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
      expect(persisted.credentials).toHaveLength(1);
      expect(persisted.credentials[0].publicKey).toBe('pk1-updated');
    });
  });

  describe('generateEnrollmentOptions (userID / excludeCredentials / rpId reuse)', () => {
    beforeEach(() => {
      swa.generateRegistrationOptions.mockResolvedValue({
        challenge: 'chal', rp: {}, user: { id: 'x', name: '', displayName: '' },
        pubKeyCredParams: [], excludeCredentials: [],
      });
    });

    it('passes no excludeCredentials and a fresh userID when nothing is enrolled yet', async () => {
      await auth.generateEnrollmentOptions(req);
      const opts = swa.generateRegistrationOptions.mock.calls[0][0];
      expect(opts.excludeCredentials).toEqual([]);
      expect(Buffer.isBuffer(opts.userID) || opts.userID instanceof Uint8Array).toBe(true);
      expect(opts.userID.length).toBe(32);
    });

    it('excludes existing credential ids/transports and reuses the recorded userId + rpId', async () => {
      auth.addCredential({
        rpId: 'eve.lan', id: 'cred-1', publicKey: 'pk1', counter: 0,
        transports: ['internal'], label: 'Browser A', createdAt: '2026-01-01T00:00:00.000Z',
      });
      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));

      // A different hostname than `req` resolves to — the recorded rpId must win.
      await auth.generateEnrollmentOptions(req);
      const opts = swa.generateRegistrationOptions.mock.calls[0][0];

      expect(opts.rpID).toBe('eve.lan');
      expect(opts.excludeCredentials).toEqual([{ id: 'cred-1', transports: ['internal'] }]);
      expect(Buffer.from(opts.userID).toString('base64url')).toBe(persisted.userId);
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
      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
      expect(persisted.credentials[0].counter).toBe(6);
      expect(typeof session).toBe('string');
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

    it('stamps lastUsedAt on the asserted credential', async () => {
      enroll(auth, 5);
      const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
      expect(before.credentials[0].lastUsedAt).toBeUndefined();

      await auth.verifyLogin(req, { id: 'cred-1' }, auth.storeChallenge('c'));

      const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
      expect(typeof after.credentials[0].lastUsedAt).toBe('string');
    });

    it('mints the session with the asserted credential\'s id as its parent', async () => {
      enroll(auth, 5);
      const token = await auth.verifyLogin(req, { id: 'cred-1' }, auth.storeChallenge('c'));
      expect(auth.sessionStore.sessions.get(token).credentialId).toBe('cred-1');
    });

    it('back-fills userId on a pre-existing (legacy) file on its next save', async () => {
      // Written directly (bypassing saveCredentials, which now always
      // backfills) to simulate a file from before userId existed.
      const legacy = {
        rpId: 'localhost',
        credentials: [{ id: 'cred-1', publicKey: Buffer.from('public-key-bytes').toString('base64url'), counter: 5, transports: ['internal'] }],
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(path.join(dataDir, 'auth.json'), JSON.stringify(legacy));
      expect(legacy.userId).toBeUndefined();

      await auth.verifyLogin(req, { id: 'cred-1' }, auth.storeChallenge('c'));

      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8')).userId).toEqual(expect.any(String));
    });
  });

  function enrollTwo(a) {
    a.saveCredentials({
      rpId: 'localhost',
      credentials: [
        { id: 'cred-1', publicKey: 'pk1', counter: 0, transports: ['internal'], label: 'Browser A', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'cred-2', publicKey: 'pk2', counter: 0, transports: ['internal'], label: 'Browser B', createdAt: '2026-01-02T00:00:00.000Z' },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }

  describe('removeCredential', () => {
    it('deletes the credential, ends its sessions, and reports how many', () => {
      enrollTwo(auth);
      const s1 = auth.createSession('cred-1');
      const s2 = auth.createSession('cred-1');
      const other = auth.createSession('cred-2');

      const result = auth.removeCredential('cred-1');

      expect(result).toEqual({ removed: true, sessionsEnded: 2 });
      expect(auth.validateSession(s1)).toBe(false);
      expect(auth.validateSession(s2)).toBe(false);
      expect(auth.validateSession(other)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8'));
      expect(persisted.credentials.map((c) => c.id)).toEqual(['cred-2']);
    });

    it('refuses to remove the last credential, and writes nothing', () => {
      auth.saveCredentials({
        rpId: 'localhost',
        credentials: [{ id: 'cred-1', publicKey: 'pk1', counter: 0, transports: ['internal'], createdAt: '2026-01-01T00:00:00.000Z' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      const before = fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8');

      expect(() => auth.removeCredential('cred-1')).toThrow(/last passkey/);
      expect(fs.readFileSync(path.join(dataDir, 'auth.json'), 'utf8')).toBe(before);
    });

    it('throws on an unknown credential id', () => {
      enrollTwo(auth);
      expect(() => auth.removeCredential('does-not-exist')).toThrow('Unknown credential');
    });

    it('throws when nothing is enrolled', () => {
      expect(() => auth.removeCredential('cred-1')).toThrow('Not enrolled');
    });
  });

  describe('listCredentials (public metadata only)', () => {
    it('returns id/label/created/last_used in relay\'s snake_case shape', () => {
      enrollTwo(auth);
      expect(auth.listCredentials()).toEqual([
        { id: 'cred-1', label: 'Browser A', created: '2026-01-01T00:00:00.000Z', last_used: null },
        { id: 'cred-2', label: 'Browser B', created: '2026-01-02T00:00:00.000Z', last_used: null },
      ]);
    });

    it('never includes publicKey or counter', () => {
      enrollTwo(auth);
      for (const entry of auth.listCredentials()) {
        expect(entry).not.toHaveProperty('publicKey');
        expect(entry).not.toHaveProperty('counter');
      }
    });

    it('reflects lastUsedAt once a credential has logged in', async () => {
      enroll(auth, 5);
      await auth.verifyLogin(req, { id: 'cred-1' }, auth.storeChallenge('c'));
      const [entry] = auth.listCredentials();
      expect(typeof entry.last_used).toBe('string');
    });

    it('returns an empty array when nothing is enrolled', () => {
      expect(auth.listCredentials()).toEqual([]);
    });
  });

  describe('credentialIdFromAssertion', () => {
    it('reads the id off the assertion response before verification runs', () => {
      expect(auth.credentialIdFromAssertion({ id: 'cred-1' })).toBe('cred-1');
    });

    it('returns undefined for a malformed/missing response', () => {
      expect(auth.credentialIdFromAssertion(undefined)).toBeUndefined();
      expect(auth.credentialIdFromAssertion({})).toBeUndefined();
    });
  });
});
