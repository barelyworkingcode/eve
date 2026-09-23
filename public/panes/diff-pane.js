// Git diff pane (docs/design-git-changes.md, "Opening a file: the diff pane").
// The descriptors only route; state, Monaco and WS traffic live in
// DiffViewer (public/diff-viewer.js), reached through ctx at call time.

function diffViewerFrom(ctx) {
  return ctx.container?.has('diffViewer') ? ctx.container.get('diffViewer') : null;
}

panes.registerType({
  type: 'diff',

  // Side-effect free, so TabManager#openPane can call it to learn the id.
  // The id carries projectId as well as the design's `diff:<repo>:<path>`
  // key: two projects can both have a root repo with the same file.
  create(spec) {
    return {
      id: `diff:${spec.projectId}:${spec.repo}:${spec.path}`,
      type: 'diff',
      label: spec.path.split('/').pop(),
      title: [spec.repoName, spec.branch].filter(Boolean).join(' · '),
      projectId: spec.projectId,
      repo: spec.repo,
      path: spec.path,
    };
  },

  view() { return 'diff'; },
  ref(tab) { return { tabId: tab.id }; },

  // No `persist` and no `hash`: a diff is a transient view of git state and
  // is reopened from the Changes panel, not restored on reload.

  dispose(tab, ctx) {
    diffViewerFrom(ctx)?.close(tab.id);
  },
});

panes.registerView({
  view: 'diff',
  elementId: 'diffPane',
  splittable: true,
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
    diffViewerFrom(ctx)?.show(ref.tabId);
  },
  layout(ctx) {
    diffViewerFrom(ctx)?.layout();
  },
});
