// Read-only git status/diff for the sidebar's Changes panel
// (docs/design-git-changes.md). Handlers stay sync per decision 003 C2.
module.exports = [
  {
    type: 'git_changes',
    // Fans out to several git processes per worktree (GitService caps how
    // many run at once, but not the total) and the client re-requests on
    // every git_changed push; same cost class as search_project. A full
    // request streams one frame per repo after the pending list.
    expensive: true,
    handle(ctx) {
      // An open Changes tab needs the project's recursive watcher running so
      // git_changed pushes arrive, exactly as list_directory does for the tree.
      ctx.fileWatcher.watchProject(ctx.message.projectId);
      ctx.deps.fileHandlers.gitChanges(ctx.ws, ctx.message);
    },
  },

  {
    // One file, a bounded pair of reads capped by maxBytes: comparable to
    // read_file, so not rate-limited.
    type: 'git_file_versions',
    handle(ctx) {
      ctx.deps.fileHandlers.gitFileVersions(ctx.ws, ctx.message);
    },
  },
];
