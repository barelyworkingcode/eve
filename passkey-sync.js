// The only eve code that knows relay's passkey-mirror routes
// (../relay/docs/eve-passkey-enrolment.md, "Listing and revoking eve
// passkeys"). report() doubles as the acknowledgement of any revocation
// relay applied (decision 12) — there is no separate ack round-trip.

const { NullLogger } = require('./logger');

const DEFAULT_POLL_MS = 30000;

class PasskeySync {
  constructor({ authService, relayTransport, log, pollMs = DEFAULT_POLL_MS } = {}) {
    this.authService = authService;
    this.relayTransport = relayTransport || null;
    this.log = log || new NullLogger();
    this.pollMs = pollMs;
    this.timer = null;
  }

  // PUTs the current credential list and applies whatever revocations relay
  // returns in the same round-trip. No-op with no transport.
  async report() {
    if (!this.relayTransport) return;
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
    if (!this.relayTransport || !Array.isArray(ids) || ids.length === 0) return;
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
    if (removedAny) await this.report();
  }

  // Runs an initial report immediately, then polls. `.unref()`'d so this
  // timer never keeps the process alive.
  start() {
    if (!this.relayTransport || this.timer) return;
    this.report();
    this.timer = setInterval(() => this.report(), this.pollMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

module.exports = PasskeySync;
