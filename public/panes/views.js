/**
 * View descriptors — the view -> element map `tab-manager.js` used to
 * hardcode as a `case` statement (`_containerForView`) plus three duplicated
 * element lists (`initElements`, `_hideAllContent`, `_allContentEls`).
 *
 * One row per rendering surface, not per pane type: `session` has two views
 * (`chat`/`voice`); `file` has two (`editor`/`viewer`) plus a third that
 * belongs to no type at all (`htmlPreview`, pane-B only); and `viewer` /
 * `image` share one element (`#fileViewer`) — deliberately, since
 * `_containerForView` returning the same element for both is what stops a
 * viewer and an image tab from ever being split beside each other. The dead
 * `console` view (nothing in public/ ever produces it) is dropped here rather
 * than migrated.
 *
 * `elementId` names static markup in index.html (not slot-rendered), so
 * resolving it at TabManager.initElements() — once, at construction — is
 * safe; see core/pane-registry.js for the ordering rule this depends on.
 *
 * This file only registers `view` + `elementId` + `splittable`. `show` /
 * `layout` / `destroy` are added to these same descriptors in a later
 * handoff, once `_showContentForRef` itself moves onto the registry.
 */
panes.registerView({ view: 'chat', elementId: 'chat', splittable: true });
panes.registerView({ view: 'voice', elementId: 'voiceChat', splittable: false });
panes.registerView({ view: 'editor', elementId: 'editor', splittable: true });
panes.registerView({ view: 'viewer', elementId: 'fileViewer', splittable: true });
panes.registerView({ view: 'image', elementId: 'fileViewer', splittable: true });
panes.registerView({ view: 'terminal', elementId: 'terminal', splittable: true });
panes.registerView({ view: 'module', elementId: 'moduleContent', splittable: true });
panes.registerView({ view: 'htmlPreview', elementId: 'htmlPreview', splittable: true });
