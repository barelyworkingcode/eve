/**
 * The `module` pane type — an iframe-hosted mini-app (see docs/modules.md),
 * one per `<project>/modules/<name>/`. Persisted, unlike `image`: reload
 * restore reopens whatever module tabs were open, via `eve-open-modules`
 * (spec §H). The entry shape (`{projectId, moduleName, ts}`) is a back-compat
 * gate — test/e2e/tab-panes.spec.js test 15 restores a fixture captured from
 * the pre-refactor build and must keep working, so it is reproduced here
 * verbatim rather than "cleaned up".
 *
 * Pinned: a restored tab's label is the raw `moduleName`, not the manifest's
 * `displayName` — `app.js`'s restore loop passes `mod.moduleName` as the
 * label (it doesn't have the manifest at restore time), and `create` below
 * mirrors that fallback (`spec.label || spec.moduleName`). Do not "fix" this
 * by reaching for a manifest here; the characterisation suite pins it.
 *
 * `view()` renders into `#moduleContent` (public/panes/views.js), which owns
 * the paint step (`moduleHost.activate`) — nothing to select between, so
 * there is no `render` field here (spec §M0.1).
 */
panes.registerType({
  type: 'module',

  /** Builds the tab object for a brand-new module. `openModule` handles the
   *  "already open" case itself and does the persisting + activation, per
   *  D.3: create must not activate. */
  create(spec, ctx) {
    return {
      id: `module:${spec.projectId}:${spec.moduleName}`,
      type: 'module',
      label: spec.label || spec.moduleName,
      projectId: spec.projectId,
      moduleName: spec.moduleName,
    };
  },

  view() { return 'module'; },
  ref(tab) { return { projectId: tab.projectId, moduleName: tab.moduleName }; },

  hash(tab) { return `#module/${encodeURIComponent(tab.projectId)}/${encodeURIComponent(tab.moduleName)}`; },

  // Entry shape and key are exactly what `_saveModuleTab`/`_removeModuleTab`
  // wrote pre-migration — do not change either (spec §H.2).
  persist: {
    key: 'eve-open-modules', // == TabManager.MODULE_STORAGE_KEY
    entryId(tab) { return `${tab.projectId}:${tab.moduleName}`; },
    entry(tab) { return { projectId: tab.projectId, moduleName: tab.moduleName, ts: Date.now() }; },
  },

  // No `confirmClose` — defaults to true, matching pre-migration (a module
  // tab never gated its close on anything).
  // No `onCloseLongPress` — that's session-only.

  /** Tears down the iframe. `moduleHost` is constructed after `new
   *  TabManager` (app.js:87) — reached through `ctx`, never captured
   *  (spec §E.1). */
  dispose(tab, ctx) {
    ctx.app.moduleHost?.destroy(tab.id);
  },
});
