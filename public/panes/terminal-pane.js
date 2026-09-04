// Longest-prefix match, not the usual `tab.projectId ?? null`: a terminal's
// tab has no projectId field (only `directory`), and its cwd need not be
// exactly a project root.
function projectIdForDirectory(directory, projects) {
  if (!directory) return null;
  const dir = directory.replace(/\/+$/, '').toLowerCase();
  let bestId = null;
  let bestLen = -1;
  for (const project of projects.values()) {
    if (!project.path) continue;
    const path = project.path.replace(/\/+$/, '').toLowerCase();
    if ((dir === path || dir.startsWith(path + '/')) && path.length > bestLen) {
      bestId = project.id;
      bestLen = path.length;
    }
  }
  return bestId;
}

panes.registerType({
  type: 'terminal',

  // Deliberately does not activate the tab; openTerminal handles the
  // "already open" case plus activation.
  create(spec) {
    return {
      id: spec.terminalId,
      type: 'terminal',
      label: spec.label,
      directory: spec.directory,
    };
  },

  view() { return 'terminal'; },
  ref(tab) { return { terminalId: tab.id }; },

  hash(tab) { return `#terminal/${encodeURIComponent(tab.id)}`; },

  // No `persist`: terminals stay unpersisted, deliberately — a terminal is
  // never restored on reload.

  projectId(tab, ctx) {
    return projectIdForDirectory(tab.directory, ctx.app.projects);
  },

  dispose(tab, ctx) {
    ctx.app.terminalManager?.closeTerminal(tab.id);
  },
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { projectIdForDirectory };
}
