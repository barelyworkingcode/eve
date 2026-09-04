/**
 * The `terminal` pane type — a proxied PTY (relayLLM owns the process;
 * `terminalManager` is the local xterm/WS bridge to it, constructed after
 * `new TabManager` at app.js:118 — reached through `ctx` inside every
 * function body below, never captured, per core/pane-registry.js's header).
 *
 * Smallest type along with `image`: no persistence (deliberate — a terminal
 * is never restored on reload, spec §H.3/§C), no confirm-on-close, no
 * long-press, no `ownedBy` (not an LLM-owned tab). Unlike `image` it does
 * have a hash (`#terminal/<id>`) — a terminal is deep-linkable even though
 * it isn't restored.
 *
 * `projectId` is the one thing here worth a second look: a terminal has no
 * `projectId` field (its tab only carries `directory`), so the default
 * "tab.projectId ?? null" behaviour every other migrated type relies on is
 * wrong for it. Project scoping instead resolves by longest-prefix match of
 * `directory` against every known project's path — a terminal's cwd need
 * not be exactly a project root. `projectIdForDirectory` is pure and
 * reachable under Node (core/pane-registry.js's directory scan requires this
 * file), but `test/unit/tab-manager-logic.test.js` calls it as
 * `TabManager#_projectIdForDirectory(directory)`, a single-argument method
 * with no `ctx` — that method stays on TabManager as a thin forwarder that
 * hands this file's pure function a synthetic `{directory}` tab.
 *
 * `view()` renders into `#terminal` (public/panes/views.js), which owns the
 * paint step (`terminalManager.showTerminal`) and the xterm relayout
 * (`terminalManager.fitActive`, via the view's `layout`) — nothing to select
 * between, so there is no `render` field here (spec §M0.1).
 */

/** Longest-prefix match of a directory against known project paths. */
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

  /** Builds the tab object for a brand-new terminal. `openTerminal` handles
   *  the "already open" case itself and activation, per D.3: create must not
   *  activate. */
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

  // No `persist` — terminals stay unpersisted, deliberately (§H.3).
  // No `confirmClose` — defaults to true, matching the pre-migration code,
  // which never gated a terminal tab's close on anything.
  // No `onCloseLongPress` — that's session-only.
  // No `ownedBy` — no actor gate; terminals aren't LLM-owned tabs.

  projectId(tab, ctx) {
    return projectIdForDirectory(tab.directory, ctx.app.projects);
  },

  /** Tears down the PTY-backed xterm instance. `terminalManager` is reached
   *  through `ctx`, never captured (spec §E.1). */
  dispose(tab, ctx) {
    ctx.app.terminalManager?.closeTerminal(tab.id);
  },
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { projectIdForDirectory };
}
