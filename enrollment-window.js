// The only eve code that knows relay's passkey-enrolment routes
// (../relay/docs/eve-passkey-enrolment.md). isOpen() caches its answer for
// EVE_ENROLMENT_CACHE_MS so a login-screen poll and an enrol request racing
// within the same couple of seconds don't double-hit relay.

const { NullLogger } = require('./logger');

const CACHE_TTL_MS = 2000;

class EnrollmentWindow {
  constructor({ relayTransport, log } = {}) {
    this.relayTransport = relayTransport || null;
    this.log = log || new NullLogger();
    this._cache = null; // { open, expires, at }
  }

  // Resolves { open, expires } — expires is present only when open. Fails
  // closed on a null transport or a relay error: an enrolment window that
  // can't be confirmed open must behave as closed.
  async isOpen() {
    if (!this.relayTransport) return { open: false };

    const now = Date.now();
    if (this._cache && now - this._cache.at < CACHE_TTL_MS) {
      return { open: this._cache.open, expires: this._cache.expires };
    }

    try {
      const { status, data } = await this.relayTransport.fetch('GET', '/api/eve/passkey-enrolment');
      const open = status === 200 && !!data?.open;
      this._cache = { open, expires: open ? data.expires : undefined, at: now };
    } catch (err) {
      this.log.error('Failed to check enrolment window:', err.message);
      this._cache = { open: false, expires: undefined, at: now };
    }

    return { open: this._cache.open, expires: this._cache.expires };
  }

  // true on 200 (consumed), false on 409 (closed); throws on anything else —
  // an ambiguous relay response must not silently look like "closed" to a
  // caller deciding whether to persist a credential.
  async consume({ ip, label }) {
    if (!this.relayTransport) return false;

    const { status } = await this.relayTransport.fetch('POST', '/api/eve/passkey-enrolment/consume', { ip, label });
    if (status === 200) {
      this._cache = null; // the slot just closed; don't serve a stale "open" for up to 2s
      return true;
    }
    if (status === 409) return false;
    throw new Error(`Enrolment consume failed: relay returned ${status}`);
  }
}

module.exports = EnrollmentWindow;
