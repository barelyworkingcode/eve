const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL_DAYS = (() => {
  const raw = process.env.EVE_SESSION_TTL_DAYS;
  if (raw === undefined || raw === '') return 7;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 7;
})();
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

const { NullLogger } = require('./logger');

class SessionStore {
  constructor(dataDir, log) {
    this.log = log || new NullLogger();
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.sessions = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const data = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
        return new Map(Object.entries(data));
      }
    } catch (err) {
      this.log.error('Failed to load sessions:', err.message);
    }
    return new Map();
  }

  _save() {
    try {
      const data = Object.fromEntries(this.sessions);
      fs.writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2));
      try { fs.chmodSync(this.sessionsFile, 0o600); } catch (_) {}
    } catch (err) {
      this.log.error('Failed to save sessions:', err.message);
    }
  }

  // credentialId is the passkey that minted this token — absent for tokens
  // minted before that field existed. It's what lets revokeByCredential()
  // sign a device out when its passkey is revoked (see
  // ../relay/docs/eve-passkey-enrolment.md decision 11).
  create(credentialId) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    const entry = { expiresAt };
    if (credentialId) entry.credentialId = credentialId;
    this.sessions.set(token, entry);
    this._save();
    return token;
  }

  // Deletes every token minted by credentialId. A session with no
  // credentialId (minted before this field existed) is never touched.
  revokeByCredential(credentialId) {
    let count = 0;
    for (const [token, session] of this.sessions) {
      if (session.credentialId === credentialId) {
        this.sessions.delete(token);
        count++;
      }
    }
    if (count > 0) this._save();
    return count;
  }

  validate(token) {
    if (!token) return false;
    const session = this.sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      this._save();
      return false;
    }
    return true;
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [token, session] of this.sessions) {
      if (now > session.expiresAt) {
        this.sessions.delete(token);
        changed = true;
      }
    }
    if (changed) this._save();
  }
}

module.exports = SessionStore;
