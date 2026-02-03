const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

// Time constants
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 10;

class AuthService {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.authFile = path.join(dataDir, 'auth.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.challenges = new Map();
    this.rateLimits = new Map();

    // RP (Relying Party) settings
    this.rpName = 'Eve Workspace';

    // Load persisted sessions
    this.sessions = this.loadSessions();

    // Start cleanup timer
    this.startCleanupTimer();
  }

  // --- File Operations ---

  loadSessions() {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
        return new Map(Object.entries(data));
      }
    } catch (err) {
      console.error('Failed to load sessions:', err.message);
    }
    return new Map();
  }

  saveSessions() {
    try {
      const data = Object.fromEntries(this.sessions);
      fs.writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2));
      this.setSecurePermissions(this.sessionsFile);
    } catch (err) {
      console.error('Failed to save sessions:', err.message);
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
      console.error('Failed to load auth credentials:', err.message);
      return null;
    }
  }

  saveCredentials(data) {
    try {
      fs.writeFileSync(this.authFile, JSON.stringify(data, null, 2));
      this.setSecurePermissions(this.authFile);
    } catch (err) {
      console.error('Failed to save auth credentials:', err.message);
      throw err;
    }
  }

  // --- Cleanup ---

  startCleanupTimer() {
    setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  cleanup() {
    const now = Date.now();
    let sessionsChanged = false;

    // Clean expired sessions
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
        sessionsChanged = true;
      }
    }

    if (sessionsChanged) {
      this.saveSessions();
    }

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

  // --- Session Management ---

  createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { expiresAt });
    this.saveSessions();
    return token;
  }

  validateSession(token) {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      this.saveSessions();
      return false;
    }
    return true;
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

  // --- RP Configuration ---

  getRpId(req) {
    const host = req.get('host') || 'localhost';
    return host.split(':')[0];
  }

  isLocalhost(req) {
    const host = this.getRpId(req);
    return host === 'localhost' || host === '127.0.0.1';
  }

  getOrigin(req) {
    const protocol = req.secure || req.get('x-forwarded-proto') === 'https' ? 'https' : 'http';
    const host = req.get('host') || 'localhost:3000';
    return `${protocol}://${host}`;
  }

  // --- WebAuthn Operations ---

  async generateEnrollmentOptions(req) {
    const rpId = this.getRpId(req);

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: rpId,
      userName: 'eve-user',
      userDisplayName: 'Eve User',
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
    const expectedChallenge = this.getChallenge(challengeId);
    if (!expectedChallenge) {
      throw new Error('Challenge expired or invalid');
    }

    const rpId = this.getRpId(req);
    const origin = this.getOrigin(req);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
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
    console.log('[Auth] Stored credential ID:', storedId);

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
    const expectedChallenge = this.getChallenge(challengeId);
    if (!expectedChallenge) {
      throw new Error('Challenge expired or invalid');
    }

    const authData = this.loadCredentials();
    if (!authData) {
      throw new Error('No credentials enrolled');
    }

    const credentialId = response.id;
    console.log('[Auth] Login credential ID from response:', credentialId);
    console.log('[Auth] Stored credential IDs:', authData.credentials.map(c => c.id));
    const credential = authData.credentials.find(c => c.id === credentialId);
    if (!credential) {
      throw new Error('Unknown credential');
    }

    // Use the stored RP ID from enrollment, fall back to current request
    const rpId = authData.rpId || this.getRpId(req);
    const origin = this.getOrigin(req);

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
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
