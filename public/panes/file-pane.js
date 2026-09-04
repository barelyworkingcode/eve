/**
 * The `file` pane type — the largest of the five, and the one with the most
 * back-compat surface (spec §H): its persisted entries
 * (`eve-open-files` -> `{projectId, path, ts}`) are restored by
 * test/e2e/tab-panes.spec.js test 15 against a fixture captured from the
 * pre-refactor build, so the shape below is reproduced verbatim, not
 * "cleaned up".
 *
 * Two views, not one: `view()` picks `viewer` or `editor` per-tab, by asking
 * `viewerRegistry` (constructed after `new TabManager`, app.js:95 — reached
 * through `ctx`, never captured, per core/pane-registry.js's header) whether
 * the path is a viewer file. `viewer`'s paint step (public/panes/views.js)
 * is the same function that used to be `TabManager#_renderViewer` — moved
 * there, not into a `render` field here, because `viewer` is produced by
 * exactly `file` alone; there's nothing left to select between (spec §M0.1).
 *
 * `prospectiveView` is the one true per-type override of that rule: an
 * `.html`/`.htm` file previews (`htmlPreview`) rather than opening its own
 * source when dragged in as a second pane — the only pane type that differs
 * from its own `view()` here.
 *
 * `watchFile` is not in the `PaneTypeDescriptor` table (spec §D.3) — flagged
 * for review, like `image`'s `ownedBy` was. `create` (open) and
 * `TabManager#reestablishFileWatches` (WS reconnect) both need to (re)send
 * the same `watch_file` frame, so the frame-building logic lives here once
 * and both callers reach it through the descriptor rather than tab-manager.js
 * re-deciding "is this a plan project / a binary viewer file" itself.
 * `dispose` is its mirror image for `unwatch_file` on close.
 */

/** Skips plan-project files (no watcher, no confirm) and marks viewer files
 *  binary so the server omits content from watch updates. */
function sendWatchFile(tab, ctx) {
  if (isPlanProject(tab.projectId)) return;
  const isViewer = !!ctx.app.viewerRegistry?.isViewerFile(tab.path);
  ctx.app.ws?.send(JSON.stringify({
    type: 'watch_file',
    projectId: tab.projectId,
    path: tab.path,
    binary: isViewer,
  }));
}

panes.registerType({
  type: 'file',

  /** Builds the tab object for a brand-new file and sends its initial
   *  `watch_file` frame. `openFile` handles the "already open" case itself
   *  and does the persisting + activation, per D.3: create must not
   *  activate. */
  create(spec, ctx) {
    const tab = {
      id: `${spec.projectId}:${spec.path}`,
      type: 'file',
      label: spec.label || spec.path.split('/').pop(),
      projectId: spec.projectId,
      path: spec.path,
      modified: false,
    };
    sendWatchFile(tab, ctx);
    return tab;
  },

  view(tab, ctx) {
    return ctx.app.viewerRegistry?.isViewerFile(tab.path) ? 'viewer' : 'editor';
  },
  ref(tab) { return { projectId: tab.projectId, path: tab.path, label: tab.label }; },

  // An HTML file docks as a live preview rather than its editor source when
  // dragged in as a second pane (also sidesteps the editor-vs-editor
  // singleton block) — every other type's prospective view is just its own
  // `view()`, so this is the one real override.
  prospectiveView(tab, ctx) {
    if (/\.html?$/i.test(tab.path)) return 'htmlPreview';
    return this.view(tab, ctx);
  },

  hash(tab) { return `#file/${encodeURIComponent(tab.projectId)}/${encodeURIComponent(tab.path)}`; },

  // Entry shape and key are exactly what `_saveFileTab`/`_removeFileTab` wrote
  // pre-migration — do not change either (spec §H.1/§H.2).
  persist: {
    key: 'eve-open-files', // == TabManager.FILE_STORAGE_KEY
    entryId(tab) { return `${tab.projectId}:${tab.path}`; },
    entry(tab) { return { projectId: tab.projectId, path: tab.path, ts: Date.now() }; },
  },

  /** Gates close on unsaved changes — the only type that does. Defaults to
   *  true (no gate) when `modified` is falsy, matching pre-migration. */
  confirmClose(tab) {
    if (!tab.modified) return true;
    return confirm(`"${tab.label}" has unsaved changes. Close anyway?`);
  },

  // No `onCloseLongPress` — that's session-only.

  /** Unregisters the file watcher, unless the project is a plan project
   *  (which never had one — see `sendWatchFile`). */
  dispose(tab, ctx) {
    if (isPlanProject(tab.projectId)) return;
    ctx.app.ws?.send(JSON.stringify({
      type: 'unwatch_file',
      projectId: tab.projectId,
      path: tab.path,
    }));
  },

  /** Re-sends `watch_file` for an already-open file tab, e.g. after a WS
   *  reconnect (`TabManager#reestablishFileWatches`). Same frame `create`
   *  sends on first open — see the file header. */
  watchFile: sendWatchFile,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sendWatchFile };
}
