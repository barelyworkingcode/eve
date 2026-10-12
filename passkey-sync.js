// The only eve code that knows relay's passkey-mirror routes
// (../relay/docs/eve-passkey-enrolment.md, "Listing and revoking eve
// passkeys"). report() doubles as the acknowledgement of any revocation
// relay applied (decision 12) — there is no separate ack round-trip.
// Revocations arrive as a push on the /ws/files socket; there is no poll.

const { NullLogger } = require('./logger');

class PasskeySync {
  constructor({ authService, relayTransport, files, log, enabled = true } = {}) {
    this.authService = authService;
    this.relayTransport = relayTransport || null;
    this.files = files || null;
    this.log = log || new NullLogger();
    this.enabled = enabled;
    this._onRevocations = (evt) => this.handleRevocations(evt && evt.revocations);
    this._subscribed = false;
  }

  // PUTs the current credential list and applies whatever revocations relay
  // returns in the same round-trip. No-op with no transport or with sync disabled.
  async report() {
    if (!this.enabled || !this.relayTransport) return;
    const passkeys = this.authService.listCredentials();
    try {
      const { status, data } = await this.relayTransport.fetch('PUT', '/api/eve/passkeys', { passkeys });
      if (status !== 200) {
        this.log.error(`Passkey report failed: relay returned ${status}`);
        return;
      }
      if (data && Array.isArray(data.revocations) && data.revocations.length > 0) {
        await this.apply(data.revocations);
      }
    } catch (err) {
      this.log.error('Passkey report failed:', err.message);
    }
  }

  // Fails open (false) on any relay error — a login must not be refused
  // just because relay is unreachable (decision 14).
  async checkRevoked(credentialId) {
    if (!this.relayTransport) return false;
    try {
      const { status, data } = await this.relayTransport.fetch('GET', '/api/eve/passkeys/revocations');
      if (status !== 200 || !data || !Array.isArray(data.revocations)) {
        this.log.error(`checkRevoked failed: relay returned ${status}`);
        return false;
      }
      return data.revocations.includes(credentialId);
    } catch (err) {
      this.log.error('checkRevoked failed:', err.message);
      return false;
    }
  }

  // Removes every id relay reports pending, except one that would empty the
  // credential list (mirrors relay's own last-credential guard — decision
  // 13), then reports once, which is the acknowledgement.
  async apply(ids) {
    if (await this._removeAll(ids)) await this.report();
  }

  // The push entry point. Always ends in exactly one report(), even when
  // nothing was removable: that report is what clears relay's pending list.
  // apply() is not used here, so the report cannot be doubled.
  async handleRevocations(ids) {
    if (!this.enabled || !this.relayTransport) return;
    await this._removeAll(ids);
    await this.report();
  }

  // Resolves true when at least one credential was removed.
  async _removeAll(ids) {
    if (!this.enabled || !this.relayTransport || !Array.isArray(ids) || ids.length === 0) return false;
    const existing = new Set(this.authService.listCredentials().map((c) => c.id));
    let removedAny = false;
    for (const id of ids) {
      if (!existing.has(id) || existing.size <= 1) continue;
      try {
        const { sessionsEnded } = this.authService.removeCredential(id);
        existing.delete(id);
        removedAny = true;
        this.log.info(`Applied revocation for passkey ${id} (${sessionsEnded} session(s) ended)`);
      } catch (err) {
        this.log.error(`Failed to apply revocation for ${id}:`, err.message);
      }
    }
    return removedAny;
  }

  // Reports once, then listens for relay's pushed revocations.
  start() {
    if (!this.enabled || !this.relayTransport || this._subscribed) return;
    this._subscribed = true;
    this.report();
    if (this.files) this.files.on('eve_passkey_revocations', this._onRevocations);
  }

  stop() {
    if (!this._subscribed) return;
    this._subscribed = false;
    if (this.files) this.files.off('eve_passkey_revocations', this._onRevocations);
  }
}

// relay keeps one passkey list for "eve": any second eve instance that
// reports would overwrite it and drop the live eve's pending revocations.
// The live eve itself must never run with sync off, so that pairing refuses.
function passkeySyncMode(env) {
  if (env.EVE_PASSKEY_SYNC !== 'off') return { enabled: true, refuse: null };
  if (env.RELAY_SERVICE_ID === 'eve') {
    return {
      enabled: false,
      refuse: 'EVE_PASSKEY_SYNC=off is not allowed on the live eve service: relay would stop applying its passkey revocations',
    };
  }
  return { enabled: false, refuse: null };
}

module.exports = PasskeySync;
module.exports.passkeySyncMode = passkeySyncMode;
