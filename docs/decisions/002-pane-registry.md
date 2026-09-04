# A pane registry for `public/tab-manager.js`

## The decision

`PaneRegistry` (`public/core/pane-registry.js`) replaces per-pane-type
`switch`/`if` dispatch in `tab-manager.js` with two key-selected registries:
`registerType`/`type()` for `tab.type`, `registerView`/`view()` for view id.
It constructs nothing — there is no `boot()`, because a pane descriptor is a
plain object, not a service.

### Why two descriptor kinds, not one

`tab.type` and *view* are separate axes; a single "one descriptor per pane
type" design can't express their actual relationship:

- `session` has two views (`chat`, `voice`); `file` has two (`editor`,
  `viewer`) and a third, `htmlPreview`, only as a dragged-in second pane.
- `viewer` is shared by two types — both `file` and `image` render into it,
  into the *same* DOM element (`#fileViewer`). That shared identity is what
  stops a viewer and an image tab from ever being split beside each other; a
  per-type descriptor would have nowhere to put it.
- `htmlPreview` belongs to no tab type at all — it exists only as a pane-B
  override produced by `file`'s `prospectiveView`.

A type descriptor's `view()` picks a view id; the view descriptor owns the
DOM element and render/layout/destroy. Views live in their own file
(`public/panes/views.js`) rather than being distributed into the type files,
for the same reason: `viewer` would need two owners and `htmlPreview` would
need none.

### Constraint: resolve through `ctx`, never capture

A `panes/*.js` file runs at `<script>` parse time, before `app.js`
constructs any service. A descriptor that captures a service reference at
file scope, at registration, or in a memoised field gets `undefined` —
silently: nothing throws at load time, and the failure surfaces only the
first time a user exercises that pane type, deep inside a click handler.
Every descriptor must resolve collaborators through `ctx.app.<x>` inside the
function body, at call time (stated in `pane-registry.js`'s file header for
anyone adding a descriptor). No test in this repo would catch a violation —
the unit suite constructs `TabManager` against a fake `document` with no
real `app`. This stays a code-review invariant, not a mechanically-guarded
one.

### Field-specific invariants

- **`ownedBy` (image type).** The LLM cross-project ownership gate —
  `refreshImageTab`/`closeImageTab` may only be called by the actor that
  opened the tab, in its own project. It also stays reachable as
  `TabManager#_ownedBy`: `test/unit/tab-manager-logic.test.js` requires
  `tab-manager.js` in isolation, with no `<script>` order to load
  `image-pane.js` first, so the forwarder is what that test calls. Don't
  delete it as a seeming duplicate of `image-pane.js`'s `ownedBy`.
- **`activateSkipRender` (session type).** `openSession({skipRender: true})`
  bypasses the normal `show()` activation path on purpose (see
  `session-pane.js`'s header comment) — a preserved, pre-existing
  divergence, not something to unify.

## Out of scope

`ws-handler.js`'s message dispatch had the same shape of problem — see
[003-ws-message-registry.md](003-ws-message-registry.md).
