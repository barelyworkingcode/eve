const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');
const SessionStore = require('./session-store');

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 10;

const { NullLogger } = require('./logger');

class AuthService {
  constructor(dataDir, log) {
    this.log = log || new NullLogger();
    this.dataDir = dataDir;
    this.authFile = path.join(dataDir, 'auth.json');
    this.sessionStore = new SessionStore(dataDir, this.log.child('Sessions'));
    this.challenges = new Map();
    this.rateLimits = new Map();

    // RP (Relying Party) settings
    this.rpName = 'Home|Work';

    // Optional pinned origins (EVE_PUBLIC_ORIGIN). When set, WebAuthn RP ID and
    // expected origin come from here instead of the request Host header, which
    // is attacker-controllable. See docs/security-audit-frontend.md (M1).
    this.pinnedOrigins = this._parsePinnedOrigins(process.env);
    if (this.pinnedOrigins) {
      this.log.info(`WebAuthn origin pinned to: ${this.pinnedOrigins.map(o => o.origin).join(', ')}`);
    }

    // Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Parse EVE_PUBLIC_ORIGIN (comma-separated) into [{ origin, rpId }] or null.
   * Invalid entries are skipped with a warning.
   */
  _parsePinnedOrigins(env) {
    const raw = env.EVE_PUBLIC_ORIGIN;
    if (!raw || !raw.trim()) return null;
    const out = [];
    for (const part of raw.split(',').map(s => s.trim()).filter(Boolean)) {
      try {
        const u = new URL(part);
        out.push({ origin: u.origin, rpId: u.hostname });
      } catch {
        this.log.warn(`Ignoring invalid EVE_PUBLIC_ORIGIN entry: ${part}`);
      }
    }
    return out.length ? out : null;
  }

  // --- Credential Persistence ---

  setSecurePermissions(filePath) {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (err) {
      // Ignore on Windows or if permissions can't be set
    }
  }

  isEnrolled() {
    return fs.existsSync(this.authFile);
  }

  loadCredentials() {
    if (!this.isEnrolled()) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
    } catch (err) {
      this.log.error('Failed to load credentials:', err.message);
      return null;
    }
  }

  saveCredentials(data) {
    try {
      fs.writeFileSync(this.authFile, JSON.stringify(data, null, 2));
      this.setSecurePermissions(this.authFile);
    } catch (err) {
      this.log.error('Failed to save credentials:', err.message);
      throw err;
    }
  }

  // --- Cleanup ---

  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Don't keep the event loop alive solely for cleanup (and let tests exit).
    this.cleanupTimer.unref?.();
  }

  /** Stop the background cleanup timer. */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  cleanup() {
    const now = Date.now();

    this.sessionStore.cleanup();

    // Clean expired challenges
    for (const [id, challenge] of this.challenges) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(id);
      }
    }

    // Clean expired rate limits
    for (const [ip, limit] of this.rateLimits) {
      if (now > limit.resetAt) {
        this.rateLimits.delete(ip);
      }
    }
  }

  // --- Rate Limiting ---

  checkRateLimit(ip) {
    const now = Date.now();
    const limit = this.rateLimits.get(ip);

    if (!limit || now > limit.resetAt) {
      this.rateLimits.set(ip, { attempts: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }

    if (limit.attempts >= RATE_LIMIT_MAX_ATTEMPTS) {
      return false;
    }

    limit.attempts++;
    return true;
  }

  // --- Session Management (delegates to SessionStore) ---

  createSession() {
    return this.sessionStore.create();
  }

  validateSession(token) {
    return this.sessionStore.validate(token);
  }

  // --- Challenge Management ---

  storeChallenge(challenge) {
    const id = crypto.randomBytes(16).toString('hex');
    this.challenges.set(id, {
      challenge,
      expiresAt: Date.now() + CHALLENGE_TTL_MS
    });
    return id;
  }

  getChallenge(id) {
    const stored = this.challenges.get(id);
    if (!stored) return null;
    if (Date.now() > stored.expiresAt) {
      this.challenges.delete(id);
      return null;
    }
    this.challenges.delete(id); // One-time use
    return stored.challenge;
  }

  /**
   * Get, validate, and consume a challenge in one call.
   * Throws if the challenge is missing or expired.
   */
  consumeChallenge(challengeId) {
    const challenge = this.getChallenge(challengeId);
    if (!challenge) {
      throw new Error('Challenge expired or invalid');
    }
    return challenge;
  }

  // --- RP Configuration ---
  //
  // These helpers derive the WebAuthn RP ID / origin from the request host.
  // This is intentional — WebAuthn binds credentials by hostname, so the
  // hostname the browser used to reach us is the correct RP ID value. They
  // MUST NOT be used for authorization decisions. Network-layer trust
  // (the subnet bypass) lives in TrustedNetworkService and reads the raw
  // TCP source address; see trusted-network.js and
  // plans/cozy-honking-toast.md Section A.

  getRpId(req) {
    if (this.pinnedOrigins) return this.pinnedOrigins[0].rpId;
    const host = req.get('host') || 'localhost';
    return host.split(':')[0];
  }

  getOrigin(req) {
    if (this.pinnedOrigins) return this.pinnedOrigins[0].origin;
    const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const host = req.get('host') || 'localhost:3000';
    return `${protocol}://${host}`;
  }

  /**
   * Expected origin(s) for verification. When pinned, returns the full
   * allowlist (simplewebauthn accepts a string[] here); otherwise the single
   * request-derived origin (unchanged legacy behavior).
   */
  _expectedOrigins(req) {
    return this.pinnedOrigins ? this.pinnedOrigins.map(o => o.origin) : this.getOrigin(req);
  }

  /**
   * Expected RP ID(s) for verification. When pinned, returns the pinned
   * hostnames plus the credential's stored rpId (so a credential enrolled
   * before pinning still validates); otherwise the stored-or-derived id.
   */
  _expectedRpIds(req, storedRpId) {
    if (this.pinnedOrigins) {
      const ids = this.pinnedOrigins.map(o => o.rpId);
      if (storedRpId && !ids.includes(storedRpId)) ids.push(storedRpId);
      return ids;
    }
    return storedRpId || this.getRpId(req);
  }

  // --- WebAuthn Operations ---

  async generateEnrollmentOptions(req) {
    const rpId = this.getRpId(req);

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: rpId,
      userName: 'eve-user',
      userDisplayName: 'Home|Work User',
      attestationType: 'none',
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'preferred'
      }
    });

    const challengeId = this.storeChallenge(options.challenge);

    return {
      options,
      challengeId
    };
  }

  async verifyEnrollment(req, response, challengeId) {
    const expectedChallenge = this.consumeChallenge(challengeId);

    const rpId = this.getRpId(req);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this._expectedOrigins(req),
      expectedRPID: this.pinnedOrigins ? this.pinnedOrigins.map(o => o.rpId) : rpId
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Verification failed');
    }

    const { credential } = verification.registrationInfo;

    // credential.id may be Uint8Array or already base64url string depending on simplewebauthn version
    const storedId = typeof credential.id === 'string'
      ? credential.id
      : Buffer.from(credential.id).toString('base64url');
    this.log.debug('Stored credential ID:', storedId);

    const credentialData = {
      rpId: rpId, // Store the RP ID used during enrollment
      credentials: [{
        id: storedId,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: response.response.transports || ['internal']
      }],
      createdAt: new Date().toISOString()
    };

    this.saveCredentials(credentialData);
    return this.createSession();
  }

  async generateLoginOptions(req) {
    const authData = this.loadCredentials();
    if (!authData || !authData.credentials.length) {
      throw new Error('No credentials enrolled');
    }

    // Use the stored RP ID from enrollment, fall back to current request
    const rpId = authData.rpId || this.getRpId(req);

    const options = await generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: [],
      userVerification: 'preferred'
    });

    const challengeId = this.storeChallenge(options.challenge);

    return {
      options,
      challengeId
    };
  }

  async verifyLogin(req, response, challengeId) {
    const expectedChallenge = this.consumeChallenge(challengeId);

    const authData = this.loadCredentials();
    if (!authData) {
      throw new Error('No credentials enrolled');
    }

    const credentialId = response.id;
    this.log.debug('Login credential ID from response:', credentialId);
    this.log.debug('Stored credential IDs:', authData.credentials.map(c => c.id));
    const credential = authData.credentials.find(c => c.id === credentialId);
    if (!credential) {
      throw new Error('Unknown credential');
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this._expectedOrigins(req),
      expectedRPID: this._expectedRpIds(req, authData.rpId),
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, 'base64url'),
        counter: credential.counter
      }
    });

    if (!verification.verified) {
      throw new Error('Verification failed');
    }

    credential.counter = verification.authenticationInfo.newCounter;
    this.saveCredentials(authData);

    return this.createSession();
  }
}

module.exports = AuthService;
