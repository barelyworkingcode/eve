/**
 * The `session` pane type — a chat (or voice) conversation bound to relayLLM.
 * Last of the five types migrated onto PaneRegistry; after this file, no
 * pane type remains in `tab-manager.js`'s switches (spec §F step 8).
 *
 * Two views, not one: `view()` picks `chat` or `voice` per-tab, by asking
 * `ctx.app.sessions` (the live session map) whether `sessionType === 'voice'`
 * — reached through `ctx` inside the function body, never captured, per
 * core/pane-registry.js's header. `voice` is `splittable: false`
 * (public/panes/views.js); `chat` is the only migrated view whose `show`
 * still reaches into `messageDispatcher` (constructed at app.js:139, long
 * after `new TabManager` at app.js:75) — moved there verbatim in handoff 3,
 * unchanged here.
 *
 * `activateSkipRender` is not in the `PaneTypeDescriptor` table (spec §D.3)
 * — flagged for review, like `file`'s `watchFile` and `image`'s `ownedBy`
 * before it. `TabManager#openSession({skipRender: true})` re-implements a
 * slice of the `chat`/`voice` views' own activation logic inline, bypassing
 * `_showContentForRef` on purpose — a documented latent divergence (spec
 * §B.5, §F). `create` can't hold it (§D.3: create must not activate), and it
 * isn't a view's `show` either, since `openSession` calls it directly. Moved
 * verbatim; unifying it with the views' `show` is a behaviour change and is
 * out of scope.
 *
 * Persisted entries (`eve-open-sessions` -> a **bare number**, not an object)
 * are a back-compat gate: test/e2e/tab-panes.spec.js test 15 restores a
 * fixture captured from the pre-refactor build, so the shape is reproduced
 * verbatim (spec §H.2), not "cleaned up" into an object like `file`/`module`.
 *
 * `eve-session-meta` and its three methods (`getSessionMeta`,
 * `_saveSessionMeta`, `_removeSessionMeta`) deliberately stay on
 * `TabManager`, unmoved (spec §H.6) — they're session metadata, not tab
 * bookkeeping, and are called from `message-dispatcher.js` and
 * `voice-chat-manager.js` directly. `create` and `dispose` below reach them
 * through `ctx.tabs`, the same way a view's `show` reaches `ctx.tabs.viewerCanvas`.
 */
panes.registerType({
  type: 'session',

  /** Builds the tab object for a session already known to `ctx.app.sessions`
   *  (the session itself is created elsewhere, by relayLLM; this only builds
   *  the tab). `openSession` handles the "already open" case itself and does
   *  the persisting + activation, per D.3: create must not activate. */
  create(spec, ctx) {
    const session = ctx.app.sessions.get(spec.sessionId);
    let label;
    if (session?.name) {
      label = session.name;
    } else if (session?.projectId) {
      const project = ctx.app.projects.get(session.projectId);
      label = project?.name || session.directory;
    } else {
      label = session?.directory?.split('/').filter(p => p).pop() || session?.directory || 'Session';
    }
    return {
      id: spec.sessionId,
      type: 'session',
      label,
      projectId: session?.projectId,
    };
  },

  view(tab, ctx) {
    const session = ctx.app.sessions.get(tab.id);
    return session?.sessionType === 'voice' ? 'voice' : 'chat';
  },
  ref(tab) { return { sessionId: tab.id }; },

  hash(tab) { return `#session/${encodeURIComponent(tab.id)}`; },

  // Entry shape and key are exactly what `_saveSessionTab` wrote pre-
  // migration — a bare `Date.now()` number, not an object like `file`/
  // `module`. Do not change either (spec §H.1/§H.2); `_getRecentEntries`
  // keeps tolerating both forms.
  persist: {
    key: 'eve-open-sessions', // == TabManager.SESSION_STORAGE_KEY
    entryId(tab) { return tab.id; },
    entry() { return Date.now(); }, // deliberate: bare number (spec §H.2)
  },

  // No `confirmClose` — defaults to true, matching pre-migration (a session
  // tab never gated its close on anything).

  /** A 500 ms press on a session tab's close button deletes the session from
   *  the server — session only, the one type with a long-press. */
  onCloseLongPress(tab, ctx) {
    ctx.app.deleteSession(tab.id);
  },

  /** Unbinds from relayLLM and clears the message-dispatcher's per-session
   *  buffering state. `messageDispatcher` is reached through `ctx`, never
   *  captured (spec §E.1) — constructed at app.js:139, long after `new
   *  TabManager` (app.js:75). `_removeSessionMeta` stays a real TabManager
   *  method (spec §H.6); this only calls it through `ctx.tabs`. */
  dispose(tab, ctx) {
    ctx.app.wsClient.send({ type: 'leave_session', sessionId: tab.id });
    if (ctx.app.messageDispatcher) {
      ctx.app.messageDispatcher.backgroundBuffers.delete(tab.id);
      ctx.app.messageDispatcher.streamingSessions.delete(tab.id);
    }
    ctx.tabs._removeSessionMeta(tab.id);
  },

  /** See the file header: `openSession({skipRender: true})`'s duplicate,
   *  documented-divergent activation path. Verbatim body of the
   *  pre-migration inline block — reaches `TabManager` internals through
   *  `ctx.tabs` the same way a view's `show` does. */
  activateSkipRender(tab, ctx) {
    const { tabs, app } = ctx;
    const session = app.sessions.get(tab.id);
    tabs.activeTabId = tab.id;
    tabs._rememberActive(tab);
    app.showChatScreen();
    if (session?.sessionType === 'voice') {
      tabs.voiceChatContent?.classList.remove('hidden');
      app.voiceChatManager?.activateForSession(tab.id);
    } else {
      tabs.chatContent.classList.remove('hidden');
    }
    app.currentSessionId = tab.id;
    tabs._syncProjectToActiveTab();
    tabs.render();
  },
});
