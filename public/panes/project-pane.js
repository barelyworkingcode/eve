// Project page pane (docs/design-workbench.md, S5a-A1). The descriptors only
// route; the content is built by ProjectPage (public/project-page.js),
// reached through ctx at call time.

function projectPageFrom(ctx) {
  return ctx.container?.has('projectPage') ? ctx.container.get('projectPage') : null;
}

panes.registerType({
  type: 'project',

  // Side-effect free, so TabManager#openPane can call it to learn the id.
  create({ projectId }, ctx) {
    const project = ctx?.app?.projects?.get(projectId);
    return {
      id: `project:${projectId}`,
      type: 'project',
      projectId,
      label: project?.name || 'Project',
    };
  },

  view() { return 'project'; },
  ref(tab) { return { tabId: tab.id, projectId: tab.projectId }; },

  hash(tab) { return `#project/${encodeURIComponent(tab.projectId)}`; },

  // No `persist`: a project page is reopened from the panel, not restored.
});

panes.registerView({
  view: 'project',
  elementId: 'projectPane',
  splittable: false,
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
    projectPageFrom(ctx)?.show(ref.projectId);
  },
});
