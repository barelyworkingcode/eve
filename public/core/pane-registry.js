/**
 * See docs/decisions/001-feature-registry.md and 002-pane-registry.md.
 *
 * A descriptor must resolve its collaborators through `ctx` at call time and
 * never capture one at file scope, at registration, or in a memoised field:
 * TabManager is constructed before the services a descriptor calls into
 * exist, so a captured reference is `undefined` and fails silently with
 * nothing to catch it.
 *
 * `viewer` and `image` deliberately share one DOM element; the split-pane
 * guard depends on that.
 */
class PaneRegistry {
  constructor() {
    this._types = new Map();
    this._views = new Map();
  }

  registerType(d) {
    if (!d || !d.type) throw new Error('[PaneRegistry] pane type descriptor needs a type');
    if (this._types.has(d.type)) {
      throw new Error(`[PaneRegistry] duplicate pane type: ${d.type}`);
    }
    this._types.set(d.type, d);
    return this;
  }

  registerView(d) {
    if (!d || !d.view) throw new Error('[PaneRegistry] pane view descriptor needs a view');
    if (this._views.has(d.view)) {
      throw new Error(`[PaneRegistry] duplicate pane view: ${d.view}`);
    }
    this._views.set(d.view, d);
    return this;
  }

  type(name) { return this._types.get(name) ?? null; }
  view(name) { return this._views.get(name) ?? null; }

  hasType(name) { return this._types.has(name); }
  hasView(name) { return this._views.has(name); }

  types() { return [...this._types.values()]; }
  views() { return [...this._views.values()]; }
}

// Must exist at file scope: a pane descriptor file calls
// `panes.registerType(...)` / `panes.registerView(...)` the moment its
// <script> tag is parsed, long before initApp().
const panes = new PaneRegistry();

// Node has no <script> tag order, so this loads panes/*.js once, here, for
// any Node caller (tab-manager.js requires this file instead of one require
// per pane type).
if (typeof module !== 'undefined' && module.exports) {
  global.panes = panes; // must be set before the scan below: descriptor files reference `panes` at file scope
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'panes');
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.js')) require(path.join(dir, f));
  module.exports = { PaneRegistry, panes };
}
