/**
 * The `image` pane type — LLM-created image tabs (eve-control MCP). The
 * smallest of the five types: no persistence (deliberate — see
 * docs/decisions/001-feature-registry.md's back-compat rules), no confirm-on-
 * close, no dispose, no long-press, and no `_updateHash` arm at all, so
 * activating one *clears* the hash rather than linking to it. That absence is
 * pinned by test/unit/tab-manager-logic.test.js and test/e2e/tab-panes.spec.js
 * — do not add a `hash` field here to "fix" it.
 *
 * `view` renders into `#fileViewer`, shared with the `viewer` view
 * (public/panes/views.js) — deliberate, not this file's concern to enforce:
 * `_containerForView` returning the same element for both is what stops a
 * viewer and an image tab from ever being split beside each other.
 *
 * Two members below (`render`, `ownedBy`) aren't in the `PaneTypeDescriptor`
 * table (spec §D.3) — flagged for review, not slipped in quietly:
 *
 * - `render(tab, ctx)` draws the tab's pixels into the shared `#fileViewer`
 *   canvas. The `image` *view* (panes/views.js) still owns the container
 *   show/hide; this is what it delegates to, via TabManager's
 *   `_renderImageTab` forwarder — the same shape `views.js` already uses for
 *   `viewer` (`_renderViewer`, not yet migrated) and `destroy`
 *   (`destroyActiveViewer`, migrated). D.3's fields describe a tab's
 *   lifecycle (create/dispose/hash/...), not its view's paint step; a type
 *   whose view needs type-specific rendering has nowhere else in the current
 *   shape to put it.
 * - `ownedBy(tab, identity)` is the LLM cross-project ownership gate. It stays
 *   reachable as `TabManager#_ownedBy` too (a thin forwarder — see
 *   tab-manager.js) because test/unit/tab-manager-logic.test.js `require`s
 *   tab-manager.js in isolation, with no `<script>` order to load this file;
 *   tab-manager.js's Node-only require guard pulls this file in explicitly so
 *   that forwarder has something to forward to. A future type whose
 *   unit-tested pure logic moves out here hits the identical wrinkle.
 */

/** Draws `tab`'s image into the shared viewer canvas via the viewer registry,
 *  falling back to the generic image viewer by extension, and cache-busting
 *  the URL after a refresh. Bug-for-bug with the pre-migration body: a
 *  registry miss (no viewer at all, not even the fallback) silently no-ops. */
function renderImageTab(tab, ctx) {
  const registry = ctx.app.viewerRegistry;
  // Strip any cache-bust query before extension matching; keep it on the src.
  const cleanName = String(tab.url).split('?')[0];
  const viewer = registry?.getViewer(cleanName) || registry?.getViewer('image.png');
  if (!viewer) return;
  const url = tab._reloadVersion
    ? `${tab.url}${tab.url.includes('?') ? '&' : '?'}v=${tab._reloadVersion}`
    : tab.url;
  ctx.tabs.viewerPath.textContent = tab.label;
  ctx.tabs.viewerInfo.textContent = '';
  ctx.tabs._activeViewer = viewer;
  viewer.render(ctx.tabs.viewerCanvas, { filename: tab.label, url });
}

/** The LLM may only mutate tabs it opened, and only within its own project. */
function ownedBy(tab, identity) {
  return !!tab.owner && tab.owner.actor === 'llm'
    && identity?.actor === 'llm'
    && !!identity.projectId && tab.owner.projectId === identity.projectId;
}

panes.registerType({
  type: 'image',

  /** Builds the tab object for a brand-new ref. `openImageTab` handles the
   *  "ref already open" case itself (that's a refresh, not a create) and
   *  activation (focus-stealing rule), per D.3: create must not activate. */
  create(spec, ctx) {
    return {
      id: spec.tabRef,
      type: 'image',
      label: spec.title || 'Image',
      projectId: spec.owner?.projectId || null,
      url: spec.imageUrl,
      owner: spec.owner || null,
    };
  },

  view() { return 'image'; },
  ref(tab) { return { imageTabId: tab.id }; },

  // No `persist` — terminals and images stay unpersisted, deliberately (§H.3).
  // No `hash` — see the file header; this is the pinned no-hash behaviour.
  // No `confirmClose` — defaults to true, matching the pre-migration code,
  // which never gated an image tab's close on anything.
  // No `dispose` — closing an image tab has no side effect beyond splicing
  // it out of `this.tabs` (no watcher to release, nothing to persist-remove).
  // No `onCloseLongPress` — that's session-only.

  render: renderImageTab,
  ownedBy,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderImageTab, ownedBy };
}
