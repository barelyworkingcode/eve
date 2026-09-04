/**
 * A descriptor must never capture a per-connection object (`ws`, `req`,
 * `relayClient`, `fileWatcher`, the inflight id sets) — descriptors are
 * registered once per process, and a captured reference is a cross-connection
 * data leak that nothing in the unit test tier catches. A descriptor's
 * `handle` returns a promise only if the pre-existing call site awaited it,
 * since changing that changes ordering on the wire. See
 * docs/decisions/003-ws-message-registry.md.
 */
class WsMessageRegistry {
  constructor() {
    this._types = new Map();
  }

  register(d) {
    if (!d || !d.type) throw new Error('[WsMessageRegistry] message descriptor needs a type');
    if (typeof d.handle !== 'function') {
      throw new Error(`[WsMessageRegistry] message descriptor '${d.type}' needs a handle function`);
    }
    if (this._types.has(d.type)) {
      throw new Error(`[WsMessageRegistry] duplicate message type: ${d.type}`);
    }
    this._types.set(d.type, d);
    return this;
  }

  get(type) { return this._types.get(type) ?? null; }
  has(type) { return this._types.has(type); }

  types() { return [...this._types.keys()]; }

  // descriptor.expensive is the sole source of rate-limit truth
  // (docs/security-audit-frontend.md).
  expensiveTypes() {
    const s = new Set();
    for (const d of this._types.values()) if (d.expensive) s.add(d.type);
    return s;
  }
}

const messages = new WsMessageRegistry();
for (const mod of [
  require('./session-messages'),
  require('./file-messages'),
  require('./terminal-messages'),
  require('./search-messages'),
  require('./module-messages'),
  require('./voice-messages'),
  require('./diagnostics-messages'),
]) {
  for (const d of mod) messages.register(d);
}

module.exports = { WsMessageRegistry, messages };
