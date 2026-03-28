const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class SessionStore {
  constructor(dataDir) {
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
      console.error('Failed to load sessions:', err.message);
    }
    return new Map();
  }

  _save() {
    try {
      const data = Object.fromEntries(this.sessions);
      fs.writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2));
      try { fs.chmodSync(this.sessionsFile, 0o600); } catch (_) {}
    } catch (err) {
      console.error('Failed to save sessions:', err.message);
    }
  }

  create() {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(token, { expiresAt });
    this._save();
    return token;
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
