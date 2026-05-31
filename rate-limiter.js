/**
 * Minimal fixed-window rate limiter.
 *
 * Used per browser WebSocket connection to cap expensive operations (search,
 * transcription, TTS, AI invocation, session creation) so a single
 * authenticated/trusted client can't exhaust CPU or memory. Fixed-window is
 * sufficient here — we only need a coarse abuse ceiling, not precise fairness.
 * See docs/security-audit-frontend.md (M3).
 */
class RateLimiter {
  /**
   * @param {object} opts
   * @param {number} opts.windowMs - window length in ms
   * @param {number} opts.max - max allowed calls per window
   * @param {() => number} [opts.now] - clock injection for tests
   */
  constructor({ windowMs, max, now = () => Date.now() }) {
    if (!(windowMs > 0) || !(max > 0)) {
      throw new Error('RateLimiter requires positive windowMs and max');
    }
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.windowStart = now();
    this.count = 0;
  }

  /**
   * Record an attempt. Returns true if it is within the limit, false if it
   * should be rejected.
   */
  allow() {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.max) return false;
    this.count++;
    return true;
  }
}

module.exports = RateLimiter;
