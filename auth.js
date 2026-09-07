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
const LABEL_MAX_LENGTH = 120;

const { NullLogger } = require('./logger');

// Enrolling browser's User-Agent, kept only as a display label for a future
// credential-listing surface — never used for any security decision.
function sanitizeLabel(userAgent) {
  if (!userAgent) return '';
  // eslint-disable-next-line no-control-regex
  return userAgent.replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, LABEL_MAX_LENGTH);
}

class AuthService {
  constructor(dataDir, log) {
    this.log = log || new NullLogger();
    this.dataDir = dataDir;
    this.authFile = path.join(dataDir, 'auth.json');
    this.sessionStore = new SessionStore(dataDir, this.log.child('Sessions'));
    this.challenges = new Map();
    this.rateLimits = new Map();

    this.rpName = 'Home|Work'; // RP (Relying Party) display name

    // When EVE_PUBLIC_ORIGIN is set, the WebAuthn RP ID and expected origin
    // come from it instead of the request Host header, which is
    // attacker-controllable. See docs/security-audit-frontend.md (M1).
    this.pinnedOrigin = this._parsePinnedOrigin(process.env);
    if (this.pinnedOrigin) {
      this.log.info(`WebAuthn origin pinned to: ${this.pinnedOrigin.origin}`);
    }

    this.startCleanupTimer();
  }

  // Reads process.env fresh on every call to support runtime config changes.
  _getPinnedOrigin() {
    const raw = process.env.EVE_PUBLIC_ORIGIN;
    if (!raw || !raw.trim()) return null;
    try {
      const u = new URL(raw.trim());
      return { origin: u.origin, rpId: u.hostname };
    } catch {
      this.log.warn(`Ignoring invalid EVE_PUBLIC_ORIGIN: ${raw}`);
      return null;
    }
  }

  // Called once at startup for logging only; requests read fresh via _getPinnedOrigin().
  _parsePinnedOrigin(env) {
    const raw = env.EVE_PUBLIC_ORIGIN;
    if (!raw || !raw.trim()) return null;
    try {
      const u = new URL(raw.trim());
      return { origin: u.origin, rpId: u.hostname };
    } catch {
      this.log.warn(`Ignoring invalid EVE_PUBLIC_ORIGIN: ${raw}`);
      return null;
    }
  }

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

  // Back-fills `userId` on any pre-existing file that predates it (one user
  // handle for every credential — see verifyEnrollment/addCredential) so a
  // legacy single-passkey file gets one on its very next save, not just the
  // next enrolment.
  saveCredentials(data) {
    if (!data.userId) {
      data.userId = crypto.randomBytes(32).toString('base64url');
    }
    try {
      fs.writeFileSync(this.authFile, JSON.stringify(data, null, 2));
      this.setSecurePermissions(this.authFile);
    } catch (err) {
      this.log.error('Failed to save credentials:', err.message);
      throw err;
    }
  }

  startCleanupTimer() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Don't keep the event loop alive solely for cleanup (and let tests exit).
    this.cleanupTimer.unref?.();
  }

  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  cleanup() {
    const now = Date.now();

    this.sessionStore.cleanup();

    for (const [id, challenge] of this.challenges) {
      if (now > challenge.expiresAt) {
        this.challenges.delete(id);
      }
    }

    for (const [ip, limit] of this.rateLimits) {
      if (now > limit.resetAt) {
        this.rateLimits.delete(ip);
      }
    }
  }

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

  createSession() {
    return this.sessionStore.create();
  }

  validateSession(token) {
    return this.sessionStore.validate(token);
  }

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

  consumeChallenge(challengeId) {
    const challenge = this.getChallenge(challengeId);
    if (!challenge) {
      throw new Error('Challenge expired or invalid');
    }
    return challenge;
  }

  // getRpId/getOrigin deliberately derive from the request host — WebAuthn
  // binds credentials by hostname, so that's the correct RP ID value. They
  // MUST NOT be used for authorization decisions; network-layer trust (the
  // subnet bypass) lives in TrustedNetworkService and reads only
  // req.socket.remoteAddress. See trusted-network.js.

  getRpId(req) {
    const pinned = this._getPinnedOrigin();
    if (pinned) return pinned.rpId;
    const host = req.get('host') || 'localhost';
    return host.split(':')[0];
  }

  getOrigin(req) {
    const pinned = this._getPinnedOrigin();
    if (pinned) return pinned.origin;
    // req.secure only, never x-forwarded-proto — the latter is
    // attacker-controllable on a direct connection. Behind a reverse proxy,
    // set EVE_PUBLIC_ORIGIN instead.
    const protocol = req.secure ? 'https' : 'http';
    const host = req.get('host') || 'localhost:3000';
    return `${protocol}://${host}`;
  }

  async generateEnrollmentOptions(req) {
    // Reuse the recorded RP ID / user handle once one exists — a second
    // browser may reach eve by a different hostname than the first did, and
    // every credential must belong to the one WebAuthn user (see
    // ../relay/docs/eve-passkey-enrolment.md decisions 5-6).
    const existing = this.loadCredentials();
    const rpId = existing?.rpId || this.getRpId(req);
    const userID = existing?.userId
      ? Buffer.from(existing.userId, 'base64url')
      : crypto.randomBytes(32);
    const excludeCredentials = (existing?.credentials || []).map((c) => ({
      id: c.id,
      transports: c.transports || ['internal']
    }));

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: rpId,
      userName: 'eve-user',
      userID,
      userDisplayName: 'Home|Work User',
      attestationType: 'none',
      excludeCredentials,
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

  // Verifies the WebAuthn ceremony only — does not persist. Callers append
  // the result with addCredential() once any additional-enrolment window has
  // been consumed, so a failed or refused enrolment writes nothing (see
  // ../relay/docs/eve-passkey-enrolment.md decision 3: verify -> consume -> save).
  async verifyEnrollment(req, response, challengeId) {
    const expectedChallenge = this.consumeChallenge(challengeId);

    const existing = this.loadCredentials();
    const rpId = existing?.rpId || this.getRpId(req);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.getOrigin(req),
      expectedRPID: rpId
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('Verification failed');
    }

    const { credential } = verification.registrationInfo;

    // credential.id may be Uint8Array or already base64url string depending on simplewebauthn version
    const storedId = typeof credential.id === 'string'
      ? credential.id
      : Buffer.from(credential.id).toString('base64url');

    return {
      rpId,
      id: storedId,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: response.response.transports || ['internal'],
      label: sanitizeLabel(req.get('user-agent')),
      createdAt: new Date().toISOString()
    };
  }

  // Persists a credential returned by verifyEnrollment and mints a session.
  // Dedupes by id so a retried finish (or an authenticator that ignored
  // excludeCredentials) can't create a duplicate entry. The file's top-level
  // createdAt is set once, at first enrolment, and never touched again.
  addCredential(pending) {
    const { rpId, ...credential } = pending;
    let data = this.loadCredentials();
    if (!data) {
      data = { rpId, credentials: [], createdAt: credential.createdAt };
    }

    const idx = data.credentials.findIndex((c) => c.id === credential.id);
    if (idx === -1) {
      data.credentials.push(credential);
    } else {
      data.credentials[idx] = { ...data.credentials[idx], ...credential };
    }

    this.saveCredentials(data);
    return this.createSession();
  }

  async generateLoginOptions(req) {
    const authData = this.loadCredentials();
    if (!authData || !authData.credentials.length) {
      throw new Error('No credentials enrolled');
    }

    // Recomputing from the current request could resolve a different
    // hostname than the credential was bound to (e.g. EVE_PUBLIC_ORIGIN
    // added/changed since), failing verification.
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
    const credential = authData.credentials.find(c => c.id === credentialId);
    if (!credential) {
      throw new Error('Unknown credential');
    }

    // Prefer the RP ID recorded at enrollment — see generateLoginOptions().
    const rpId = authData.rpId || this.getRpId(req);

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.getOrigin(req),
      expectedRPID: rpId,
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
