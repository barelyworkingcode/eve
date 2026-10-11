// `TabManager#openSession({skipRender: true})` calls `activateSkipRender`
// directly rather than through a view's `show` — a deliberate, documented
// divergence from the normal activation path; unifying the two is a
// behaviour change and out of scope here.
//
// `eve-session-meta` and its accessors deliberately stay on TabManager: they
// are session metadata, not tab bookkeeping, and are called directly from
// message-dispatcher.js. `create`/`dispose` below
// reach them through `ctx.tabs`.
panes.registerType({
  type: 'session',

  // The session itself is created elsewhere, by relayLLM; this only builds
  // the tab, and deliberately does not activate it. `openSession` handles
  // the "already open" case plus persisting + activation.
  create(spec, ctx) {
    const session = ctx.app.sessions.get(spec.sessionId);
    let label;
    if (session?.name) {
      label = ctx.app.getSessionDisplayName(spec.sessionId);
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

  view() { return 'chat'; },
  ref(tab) { return { sessionId: tab.id }; },

  hash(tab) { return `#session/${encodeURIComponent(tab.id)}`; },

  // Entry is a bare `Date.now()` number, not an object like `file`'s —
  // pinned by test/e2e/tab-panes.spec.js against a pre-refactor fixture.
  // `_getRecentEntries` keeps tolerating both forms.
  persist: {
    key: 'eve-open-sessions', // == TabManager.SESSION_STORAGE_KEY
    entryId(tab) { return tab.id; },
    entry() { return Date.now(); },
  },

  onCloseLongPress(tab, ctx) {
    ctx.app.deleteSession(tab.id);
  },

  dispose(tab, ctx) {
    ctx.app.wsClient.send({ type: 'leave_session', sessionId: tab.id });
    if (ctx.app.messageDispatcher) {
      ctx.app.messageDispatcher.backgroundBuffers.delete(tab.id);
      ctx.app.messageDispatcher.streamingSessions.delete(tab.id);
    }
    ctx.tabs._removeSessionMeta(tab.id);
  },

  activateSkipRender(tab, ctx) {
    const { tabs, app } = ctx;
    tabs.activeTabId = tab.id;
    tabs._rememberActive(tab);
    app.showChatScreen();
    tabs.chatContent.classList.remove('hidden');
    app.currentSessionId = tab.id;
    tabs._syncProjectToActiveTab();
    tabs.render();
  },
});
