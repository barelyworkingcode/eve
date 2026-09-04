panes.registerType({
  type: 'module',

  // Label deliberately falls back to the raw moduleName: app.js's restore
  // loop passes mod.moduleName as the label because it has no manifest at
  // restore time, and this mirrors that fallback. Do not swap in the
  // manifest displayName here without checking the restore path.
  //
  // Deliberately does not activate the tab; openModule handles the
  // "already open" case plus persisting + activation.
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

  // Shape and key are pinned by test/e2e/tab-panes.spec.js against a
  // pre-refactor fixture — do not change either.
  persist: {
    key: 'eve-open-modules', // == TabManager.MODULE_STORAGE_KEY
    entryId(tab) { return `${tab.projectId}:${tab.moduleName}`; },
    entry(tab) { return { projectId: tab.projectId, moduleName: tab.moduleName, ts: Date.now() }; },
  },

  dispose(tab, ctx) {
    ctx.app.moduleHost?.destroy(tab.id);
  },
});
