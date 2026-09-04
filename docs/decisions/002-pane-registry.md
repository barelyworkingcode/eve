# A pane registry for `public/tab-manager.js`

## The problem

`tab-manager.js` dispatched on pane type (`session`/`file`/`terminal`/`module`/
`image`) and on pane view (`chat`/`voice`/`editor`/`viewer`/`image`/`terminal`/
`module`/`htmlPreview`) by hand, in switches and `if` chains scattered across
the file. [001-feature-registry.md](001-feature-registry.md) named this file
as the next target and cited "30 `case` arms" as the size of the problem.
Measuring it properly, on `pm/tab-manager-registry` before any production
change, found that number was an undercount and wrong in a way that mattered:

> **28 `case` labels + 3 pane-type `default:` arms + 20 `if`/ternary
> comparisons = 51 pane-type or pane-view branch arms, across 18 sites.**

(`grep -c "case '"` returns 30 because two lines each carry two labels —
`case 'chat': case 'console':` and `case 'viewer': case 'image':` — and 4 of
the 32 occurrences belong to `_edgeToDir`, drop-edge logic that has nothing to
do with pane types.) 70% more branching than the doc's figure, and the extra
was all in `if` chains rather than `switch`es, which is why grepping for
`case` alone missed it.

Beyond the branches themselves, six places hardcoded the same five-or-eight-
element list by hand (`initElements`, `_hideAllContent`, `_allContentEls`, the
five public constructors, three persistence writers, three persistence
readers) — the reason "add a pane type" was a seven-place edit and none of it
showed up in a `case` count at all.

## What already existed

Two precedents, no third style needed:

- **`ViewerRegistry`** — strategy objects selected by a key, one registry
  instance, nothing else knows the strategies exist.
- **`FeatureRegistry`** ([001](001-feature-registry.md)) — registration at
  file scope into a page-level singleton, storing only closures so `<script>`
  order stops mattering, plus deferred construction.

## The decision

`PaneRegistry` (`public/core/pane-registry.js`) is the composition of both:
`ViewerRegistry`'s selection-by-key semantics, `FeatureRegistry`'s
file-scope-singleton and deferred-everything registration. It stores plain
objects whose members are functions. It constructs nothing, ever — there is no
`boot()`, because a pane descriptor has no instance.

### Why two descriptor kinds, not one

`tab.type` and *view* are separate axes, and a single "one descriptor per pane
type" design cannot express their actual relationship:

- `session` has two views (`chat`, `voice`); `file` has two (`editor`,
  `viewer`) and a third only as a dragged-in second pane (`htmlPreview`).
- `viewer` is shared by two types: both `file` and `image` render into it.
- `htmlPreview` belongs to no tab type at all — it exists only as a pane-B
  override, produced by `file`'s `prospectiveView` for `.html`/`.htm` files.
- `viewer` and `image` render into the **same** element (`#fileViewer`),
  which is load-bearing: `_containerForView` returning that one element for
  both is what stops a viewer and an image tab from ever being split beside
  each other. A per-type descriptor would have nowhere to put that shared
  identity.

So there are two registries, one for each axis: `registerType`/`type` for
`tab.type`, `registerView`/`view` for view id. A type descriptor's `view()`
picks a view id; a view descriptor owns the DOM element and the render/layout/
destroy behaviour. Splitting the views into their own file
(`public/panes/views.js`) rather than distributing them into the type files
follows from the same fact: `viewer` would otherwise need two owners and
`htmlPreview` would need none.

### The interface, as built

```js
class PaneRegistry {
  registerType(d)   // requires d.type; throws on missing or duplicate
  registerView(d)   // requires d.view; throws on missing or duplicate
  type(name)        // → descriptor or null
  view(name)        // → descriptor or null
  types() / views() // → descriptors, registration order
  hasType(n) / hasView(n)
}
const panes = new PaneRegistry(); // file-scope singleton, same reason as `features`
```

`PaneTypeDescriptor`:

| member | required | replaces |
|---|---|---|
| `type` | yes | the `case` label |
| `create(spec, ctx)` | yes | the body of `openSession`/`openFile`/`openTerminal`/`openModule`/`openImageTab` |
| `view(tab, ctx)` | yes | `_viewForTab` arm |
| `ref(tab)` | yes | `_refForTab` arm |
| `prospectiveView(tab, ctx)` | no, defaults to `view` | `_prospectiveView`'s HTML arm |
| `projectId(tab, ctx)` | no, defaults to `tab.projectId ?? null` | `_tabProjectId`'s terminal arm |
| `hash(tab)` | no, defaults to `''` | `_updateHash` arm |
| `persist` | no, absent = never persisted | `_saveSessionTab`/`_saveFileTab`/`_saveModuleTab` |
| `confirmClose(tab, ctx)` | no, defaults to `true` | `closeTab`'s modified-file arm |
| `dispose(tab, ctx)` | no | `closeTab`'s five per-type arms |
| `onCloseLongPress(tab, ctx)` | no, absent = no long-press | `render()`'s `type !== 'session'` guard |
| `ownedBy(tab, identity)` | no, absent = no actor gate | `_ownedBy`, the LLM cross-project gate |
| `watchFile(tab, ctx)` | no | `reestablishFileWatches`'s per-tab re-send |
| `activateSkipRender(tab, ctx)` | no | `openSession({skipRender})`'s inline activation |

`PaneViewDescriptor`:

| member | required | replaces |
|---|---|---|
| `view` | yes | the `case` label |
| `elementId` | yes | `initElements` entry + `_containerForView` arm |
| `show(ref, ctx, containerEl)` | yes | `_showContentForRef` arm |
| `hide(el, ctx)` | no, defaults to `el.classList.add('hidden')` | `_hideAllContent` |
| `layout(ctx)` | no | `_layoutPanes` arm |
| `destroy(ctx)` | no | `_destroyActiveViewer` |
| `splittable` | no, defaults to `true` | `_canSplit`'s voice guard |

There is deliberately no `render` field on a type descriptor. A type's paint
step is not dispatch — `image` and `file`/`viewer` each produce their view from
exactly one type, so nothing is ever selected between; the paint belongs in
that view's `show`. An early version of the `image` migration added a `render`
field; the checkpoint review after that handoff removed it, and every type
migrated since has kept the paint step out of the type descriptor.

### The three fields beyond the original table

Three descriptor members were added during migration that the original design
table (the phase spec's §D.3) didn't list. Each earned its place the same way:
a real behaviour had nowhere else honest to live.

- **`ownedBy` (image).** The LLM cross-project ownership gate —
  `refreshImageTab`/`closeImageTab` may only be called by the actor that
  opened the tab, in its own project. It is pure and unit-testable, and it
  stays reachable as `TabManager#_ownedBy` too: `test/unit/tab-manager-logic
  .test.js` `require`s `tab-manager.js` in isolation, with no `<script>` order
  to load `panes/image-pane.js` first, so the forwarder exists for that test
  to have something to call. This was already flagged as binding by the
  handoff-4 checkpoint (a real descriptor field, not an improvisation) — this
  doc is where it earns a permanent home in the interface table above.

- **`watchFile` (file).** Opening a file and reconnecting the WebSocket both
  need to send the same `watch_file` frame (project scoping, plan-project
  skip, binary flag for viewer files). Without this field, either
  `create()` and `reestablishFileWatches()` duplicate that decision, or
  `reestablishFileWatches` has to reach back into the type descriptor's
  private internals. `watchFile` names the shared frame-building logic once;
  `create` calls it on first open, `TabManager#reestablishFileWatches` calls
  it again per open file tab after a reconnect.

- **`activateSkipRender` (session).** `openSession({skipRender: true})`
  re-implements a slice of the `chat`/`voice` views' own activation logic
  inline, bypassing `_showContentForRef` on purpose — a documented, pre-
  existing divergence (spec §B.5) that this phase was explicitly told to
  preserve verbatim, not unify. It isn't `create` (which must not activate,
  by the contract every type descriptor follows) and it isn't a view's `show`
  either, since `openSession` calls it directly rather than going through
  `_showContentForRef`. `activateSkipRender` is where that inline block lives
  now, moved character-for-character.

None of the three appear on any other type's descriptor. That is expected —
they are each one type's escape hatch for a constraint the other four don't
share, not a general-purpose extension point to reach for by default.

### The constraint the phase proved: resolve through `ctx`, never capture

**A descriptor must resolve its owning service lazily, at call time, through
`ctx` — never capture one at file scope, at registration, or in a memoised
field.**

`new TabManager(this.container)` runs at `app.js:75`. Every service a
descriptor calls is constructed *after* that:

| service | constructed at |
|---|---|
| `fileEditor` | app.js:79 |
| `htmlPreviewPane` | app.js:81 |
| `moduleHost` | app.js:87 |
| `viewerRegistry` | app.js:95 |
| `terminalManager` | app.js:118 |
| `voiceChatManager` | app.js:131 |
| `messageDispatcher` | app.js:139 |

A `panes/*.js` file runs at `<script>` parse time — before `initApp()`, before
the container exists, before any of the services above exist. A descriptor
that does `const ed = container.get('fileEditor')` at file scope, at
registration, or in a memoised field gets `undefined`, and the failure is
silent: nothing throws at load time, the tab opens, and the descriptor's call
into that `undefined` either no-ops behind an optional-chain or throws deep
inside a click handler the first time a user exercises that pane type. No test
in this repo catches a captured service — the unit suite constructs
`TabManager` against a fake `document` with no real `app`, and the e2e suite
exercises real behaviour but has no way to distinguish "resolved late,
correctly" from "resolved early, would have been undefined" once the app has
finished booting.

The fix already existed in the code before this phase gave it a name:
`_ctx()` is rebuilt on every call —

```js
_ctx() {
  return { container: this.container, app: this.app, tabs: this, bus: this.bus };
}
```

— and every descriptor function reaches a service through `ctx.app.<x>`
inside its own body, evaluated at call time. `core/pane-registry.js`'s file
header states this constraint for anyone writing the next descriptor; this
document is where the *why* lives.

## Consequences

- Adding a pane type is now: one `panes/*.js` file, one `<script>` tag, no
  edit to any switch in `tab-manager.js`. Views migrated first (handoffs 2-3)
  specifically because `viewer` is shared and `htmlPreview` has no owning
  type — migrating per-type first would have deadlocked on those two.
- `tab-manager.js` went from 32 `case` occurrences / 4 `default:` arms / 20
  pane-type comparisons / 1187 lines to 4 `case` labels (all `_edgeToDir`'s
  drop edges) / 1 `default:` (same) / 0 pane-type comparisons / 971 lines.
  `public/core/pane-registry.js` plus five `public/panes/*.js` type files plus
  `public/panes/views.js` add 761 lines elsewhere. Net lines across the
  client went up; that was never the goal. Locality was: the file that used
  to know all five pane types' business now knows none of it.
- `TabManager`'s imperative public surface (`openImageTab`, `refreshImageTab`,
  `closeImageTab`, and — unmoved by this phase — `setFileModified`,
  `handleViewerFileChanged`, `reestablishFileWatches`) stays on `TabManager`,
  thin, delegating each per-type decision to the descriptor. Nobody selects
  between five `refreshImageTab`s, so modelling the public API itself as
  descriptor members would turn a closed shape into an open union for no
  reduction in branching. This was settled at the handoff-4 checkpoint and
  held through all four remaining types.
- Two dead-code artefacts, found by measurement rather than by reading, were
  deleted in the final cleanup handoff: the `console` view id (nothing in
  `public/` ever produced it — dropped from `public/panes/views.js` rather
  than migrated) and `TabManager#getTab` (zero callers anywhere in the repo,
  including `test/`). The two switch statements left behind by the last two
  migrations (`_viewForTab`, `_refForTab`) had degenerated to a bare
  `default:` arm with no case left to fall through from — real dead
  scaffolding, not a type still to migrate — and were collapsed to direct
  calls in the same handoff.

## Out of scope

Everything [the phase spec](/tmp/eve-phase4-tab-manager-spec.md) named out of
scope stayed out of scope: `ws-handler.js`'s 44-arm switch (same shape,
separate phase — see "Next step" in `docs/handoff.md`), `app.js`'s restore
loop and hash router (a real scope increase over this phase, deferred as an
optional follow-on), the `app.js` forwarder debt (`showStopButton`/
`hideStopButton` are genuine one-line forwarders; `showSessionStarting`/
`clearSessionStarting` are not — see `docs/handoff.md`), `eve-session-meta`
and its three methods (session metadata, not tab bookkeeping, left on
`TabManager` unmoved), and `PaneDnd` (talks to `TabManager` only through
`tabBar`/`contentArea`/`_canSplit`/`commitSplit`, knows nothing about pane
types). No behaviour change and no appearance change were goals throughout:
every migration handoff landed with all four suites green, and the visual
suite's 24 screenshots stayed at 0.0000% end to end.
