/**
 * Per-thread activity (running / waiting / failed) derived from the frames eve
 * receives. Stub: the S1 red specs are written against this surface; the body
 * lands with the truth task (docs/design-today-s1.md, S1-A3).
 */
class SessionActivity {
  constructor(bus) { this.bus = bus; }
  observe() {}
  permissionAnswered() {}
  reset() {}
  statusOf() { return undefined; }
  reasonOf() { return undefined; }
}

if (typeof module !== 'undefined' && module.exports) module.exports = SessionActivity;
