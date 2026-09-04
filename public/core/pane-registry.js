/**
 * PaneRegistry - lets `tab-manager.js` dispatch on pane type and pane view
 * through descriptors instead of switches. See
 * docs/decisions/001-feature-registry.md for the why, and
 * docs/decisions/002-pane-registry.md (once written) for this registry
 * specifically.
 *
 * It is the composition of two existing precedents in this codebase:
 * `ViewerRegistry`'s selection-by-key semantics, and `FeatureRegistry`'s
 * file-scope-singleton, deferred-everything registration. It stores plain
 * objects whose members are functions — there is no `boot()`, because a pane
 * descriptor has no instance to construct.
 *
 * Two descriptor kinds, because `tab.type` and *view* are not the same axis:
 * a type can have more than one view (a session is `chat` or `voice`), a view
 * can be shared by more than one type (`viewer` is shared by `file` and
 * `image`), and a view can belong to no type at all (`htmlPreview` is pane-B
 * only).
 *
 *   panes.registerType({
 *     type: 'file',
 *     create(spec, ctx) { ... },
 *     view(tab, ctx) { ... },
 *     ref(tab) { ... },
 *     ...
 *   });
 *
 *   panes.registerView({
 *     view: 'editor',
 *     elementId: 'editor',
 *     show(ref, ctx) { ... },
 *   });
 *
 * Deliberate: a descriptor must resolve its owner lazily, at call time,
 * through `ctx`. `new TabManager(...)` runs at app.js:75, but the services a
 * descriptor calls (fileEditor, viewerRegistry, terminalManager, moduleHost,
 * voiceChatManager, htmlPreviewPane, messageDispatcher, ...) are constructed
 * afterwards. A descriptor that captures a service at file scope, at
 * registration, or in a memoised field gets `undefined` and fails silently
 * the first time a user exercises it. Every owner lookup belongs inside the
 * function body, reached through `ctx` (see TabManager._ctx()).
 *
 * Also deliberate: `panes/*.js` files run at <script> parse time, before
 * initApp(), before the container exists, before TabManager.initElements()
 * runs. They may contain only `panes.registerType(...)` / `panes.registerView(...)`
 * calls and pure helper functions — no construction, no DOM access. The eight
 * content containers a view's `elementId` names are static markup in
 * index.html, not slot-rendered, so resolving them at initElements() is safe;
 * if a future pane type ever needs its container contributed through a
 * FeatureRegistry slot instead, that slot renders at features.renderSlots()
 * (app.js:54), which runs before `new TabManager` (app.js:75), so it would
 * still work.
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

  // Unknown lookups return null, not undefined and not a throw: this is what
  // lets a caller do `panes.type(tab.type) ?? <switch fallback>` during the
  // incremental migration, and `?? <default>` once it's finished.
  type(name) { return this._types.get(name) ?? null; }
  view(name) { return this._views.get(name) ?? null; }

  hasType(name) { return this._types.has(name); }
  hasView(name) { return this._views.has(name); }

  types() { return [...this._types.values()]; }
  views() { return [...this._views.values()]; }
}

/**
 * The page's registry. `panes/*.js` files call `panes.registerType({...})` /
 * `panes.registerView({...})` at file scope; nothing constructs anything from
 * it in this phase.
 *
 * It has to be created here, not inside initApp(), for exactly the reason
 * `features` is created here in feature-registry.js: a pane descriptor file
 * runs the moment its <script> tag is parsed, long before initApp(), so there
 * must already be something for it to register against.
 */
const panes = new PaneRegistry();

// Node has no <script> tag order, so there is no page to load panes/*.js in
// sequence for whoever `require`s a file that expects them registered. This
// file is the one thing every pane descriptor file needs in scope (`panes`),
// so it is also the one place that loads them, once, for every Node caller —
// tab-manager.js just requires this file instead of one line per pane type.
if (typeof module !== 'undefined' && module.exports) {
  global.panes = panes; // must be set before the scan below: descriptor files reference `panes` at file scope
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname, '..', 'panes');
  for (const f of fs.readdirSync(dir).sort()) if (f.endsWith('.js')) require(path.join(dir, f));
  module.exports = { PaneRegistry, panes };
}
