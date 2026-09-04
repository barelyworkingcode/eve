// Plan projects have no file watcher; viewer files are marked binary so the
// server omits content from watch updates.
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

  // Deliberately does not activate the tab; openFile handles the
  // "already open" case plus persisting + activation.
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

  // Sidesteps the editor-vs-editor singleton block when dragged in as a second pane.
  prospectiveView(tab, ctx) {
    if (/\.html?$/i.test(tab.path)) return 'htmlPreview';
    return this.view(tab, ctx);
  },

  hash(tab) { return `#file/${encodeURIComponent(tab.projectId)}/${encodeURIComponent(tab.path)}`; },

  // Shape and key are pinned by test/e2e/tab-panes.spec.js against a
  // pre-refactor fixture — do not change either.
  persist: {
    key: 'eve-open-files', // == TabManager.FILE_STORAGE_KEY
    entryId(tab) { return `${tab.projectId}:${tab.path}`; },
    entry(tab) { return { projectId: tab.projectId, path: tab.path, ts: Date.now() }; },
  },

  // The only pane type that gates close on unsaved changes.
  confirmClose(tab) {
    if (!tab.modified) return true;
    return confirm(`"${tab.label}" has unsaved changes. Close anyway?`);
  },

  dispose(tab, ctx) {
    if (isPlanProject(tab.projectId)) return;
    ctx.app.ws?.send(JSON.stringify({
      type: 'unwatch_file',
      projectId: tab.projectId,
      path: tab.path,
    }));
  },

  // Called by TabManager#reestablishFileWatches after a WS reconnect.
  watchFile: sendWatchFile,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sendWatchFile };
}
