// Routines page pane (docs/design-routines.md, S5b-A1). One tab, not
// persisted; the content is built by RoutinesPage (public/routines-page.js),
// reached through ctx at call time.

panes.registerType({
  type: 'routines',

  // Belongs to no project: TabManager draws it, and keeps it active, whatever
  // project is active.
  global: true,

  // Side-effect free, so TabManager#openPane can call it to learn the id.
  create() { return { id: 'routines', type: 'routines', label: 'Routines' }; },

  view() { return 'routines'; },
  ref(tab) { return { tabId: tab.id }; },
  hash() { return '#routines'; },

  // No `persist`: the page is reopened from the palette or a project page.
});

panes.registerView({
  view: 'routines',
  elementId: 'routinesPane',
  splittable: false,
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
    if (ctx.container?.has('routinesPage')) ctx.container.get('routinesPage').show();
  },
});
