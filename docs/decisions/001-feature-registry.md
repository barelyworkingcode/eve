# Feature registry and UI slots

## The decision

`FeatureRegistry` (`public/core/feature-registry.js`) lets a feature
contribute a slot-rendered DOM node and bus-event handlers by registering
itself at file scope (`features.register({ id, init, slots, events })`),
instead of `index.html`/`app.js` being hand-edited per feature. `index.html`
exposes named mount points as `<div data-slot="...">`. The class's own file
header states the file-scope/deferred-construction constraint (no bundler,
so `<script>` order would otherwise matter); this doc records the rejected
alternative that constraint ruled out.

### Why not a manifest-driven script loader

Injecting `<script>` tags from a manifest would also fix "editing
`index.html` needs a server restart" (`server.js` caches `index.html` at
startup — see root `CLAUDE.md`). Deliberately rejected: it moves the
ordering problem into JS without removing it, and the restart requirement is
an irritation, not a defect worth a loader to fix.

## Consequence

A feature's button and handlers live in one file instead of being spread
across `index.html`/`app.js`. The cost is one indirection: you can no longer
find a button by grepping `index.html` for its id — grep the slot name
(`data-slot="..."`) instead.
