/**
 * WsMessageRegistry - lets ws-handler.js dispatch on message type through
 * descriptors instead of a switch. It composes `PaneRegistry`'s
 * selection-by-key semantics (see public/core/pane-registry.js) at domain
 * granularity: each ws/*-messages.js file exports an array of descriptors for
 * one sub-protocol, and this file requires each by name and registers them.
 *
 * Deliberately no filesystem scan (`readdirSync`) and no `global.*` write —
 * this is Node with real `require`, not a page of <script> tags. See
 * ws/terminal-messages.js for what a descriptor looks like.
 *
 * A few constraints that don't show up in the class itself but that every
 * descriptor file must honour:
 *
 * C1 — a descriptor must never capture connection-scoped state. Descriptor
 * objects are created once per process, at require time, before any socket
 * exists. `ws`, `req`, `relayClient`, `fileWatcher`, `inflightSearchIds` and
 * `inflightAiIds` are per-connection and reach a handler only through the
 * `ctx` argument passed to `handle` at call time. A module-level capture (a
 * `let currentWs`, a `const relay = ctx.relayClient` outside `handle`, a
 * `ctx` stashed on the descriptor) binds the first connection and serves
 * every later one from it — one browser receiving another browser's file
 * contents, terminal output and LLM stream.
 *
 * C2 — `handle` returns a promise only if its `case` arm is awaited today
 * (currently: create_session, module_read_file, module_write_file). The
 * dispatcher does `await descriptor.handle(ctx)` unconditionally; returning a
 * promise for an arm that is fire-and-forget today turns an unhandled
 * rejection into a browser-visible `{type:'error'}` frame — a protocol
 * change, not a refactor.
 *
 * C5 — these files are side-effect-free at require time: descriptor literals
 * and pure helpers only. No service construction, no socket, no filesystem
 * access, no `global.*` writes (a global write leaks across Jest's per-suite
 * module registries and makes test outcomes order-dependent).
 *
 * C6 — registration happens exactly once per process, in the loop below.
 * Never call `register()` from inside `createWsHandler` or a connection
 * handler: duplicates throw, so a second WebSocket connection would kill the
 * process.
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

  // Unknown lookups return null, not undefined and not a throw: this is what
  // lets ws-handler.js do `messages.get(message.type) ?? <switch fallback>`
  // during the incremental migration, exactly as PaneRegistry.type() does.
  get(type) { return this._types.get(type) ?? null; }
  has(type) { return this._types.has(type); }

  // Registration order.
  types() { return [...this._types.keys()]; }

  // The rate-limit membership formerly hardcoded as EXPENSIVE_OPS in
  // ws-handler.js: every registered descriptor with expensive:true. A
  // security control (docs/security-audit-frontend.md M3) — see C4.
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
]) {
  for (const d of mod) messages.register(d);
}

module.exports = { WsMessageRegistry, messages };
