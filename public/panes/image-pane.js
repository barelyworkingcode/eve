function ownedBy(tab, identity) {
  return !!tab.owner && tab.owner.actor === 'llm'
    && identity?.actor === 'llm'
    && !!identity.projectId && tab.owner.projectId === identity.projectId;
}

panes.registerType({
  type: 'image',

  // Deliberately does not activate the tab; openImageTab handles the
  // "ref already open" (refresh) case plus activation.
  create(spec, ctx) {
    return {
      id: spec.tabRef,
      type: 'image',
      label: spec.title || 'Image',
      projectId: spec.owner?.projectId || null,
      url: spec.imageUrl,
      owner: spec.owner || null,
    };
  },

  view() { return 'image'; },
  ref(tab) { return { imageTabId: tab.id }; },

  // No `persist`: terminals and images stay unpersisted, deliberately.
  // No `hash`: activating an image tab clears the hash rather than linking
  // to it — pinned by test/unit/tab-manager-logic.test.js and
  // test/e2e/tab-panes.spec.js; do not add one to "fix" it.

  ownedBy,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ownedBy };
}
