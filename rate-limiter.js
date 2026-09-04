// Used per browser WebSocket connection to cap expensive operations (search,
// transcription, TTS, AI invocation, session creation) so a single
// authenticated/trusted client can't exhaust CPU or memory. Fixed-window is a
// coarse abuse ceiling, not precise fairness. See docs/security-audit-frontend.md (M3).
class RateLimiter {
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
