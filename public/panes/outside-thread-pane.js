// Outside session thread pane. One tab per outside session, global (it belongs
// to no project), not persisted: a reload does not reopen it. The content is
// built by OutsideThreadPage (public/outside-thread.js), reached through ctx at
// call time.

function outsideThreadPageFrom(ctx) {
  return ctx.container?.has('outsideThread') ? ctx.container.get('outsideThread') : null;
}

panes.registerType({
  type: 'outside-thread',

  global: true,

  // Side-effect free, so TabManager#openPane can call it to learn the id.
  create({ sessionId, name }) {
    return { id: `outside-thread:${sessionId}`, type: 'outside-thread', sessionId, label: name };
  },

  view() { return 'outside-thread'; },
  ref(tab) { return { tabId: tab.id, sessionId: tab.sessionId }; },
  hash(tab) { return `#outside/${encodeURIComponent(tab.sessionId)}`; },

  // Closing the tab stops its timer and drops what it held.
  dispose(tab, ctx) { outsideThreadPageFrom(ctx)?.dispose(tab.sessionId); },

  // No `persist` and no app.js hash route: the rail row reopens it.
});

panes.registerView({
  view: 'outside-thread',
  elementId: 'outsideThreadPane',
  splittable: false,
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
    outsideThreadPageFrom(ctx)?.show(ref.sessionId);
  },
});
