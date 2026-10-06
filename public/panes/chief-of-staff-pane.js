// Chief of Staff thread pane. One tab, not persisted; the content is built by
// ChiefOfStaffPage (public/chief-of-staff-page.js), reached through ctx at call time.

panes.registerType({
  type: 'chief-of-staff',

  // Side-effect free, so TabManager#openPane can call it to learn the id.
  create() { return { id: 'chief-of-staff', type: 'chief-of-staff', label: 'Chief of Staff' }; },

  view() { return 'chief-of-staff'; },
  ref(tab) { return { tabId: tab.id }; },
  hash() { return '#chief-of-staff'; },

  // No `persist`: the rail and bottom-bar buttons reopen it.
});

panes.registerView({
  view: 'chief-of-staff',
  elementId: 'chiefOfStaffPane',
  splittable: false,
  show(ref, ctx, el) {
    el?.classList.remove('hidden');
    if (ctx.container?.has('chiefOfStaffPage')) ctx.container.get('chiefOfStaffPage').show();
  },
});
