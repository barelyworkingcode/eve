# Feature registry and UI slots

## The problem

Adding a feature with a UI surface means hand-editing ten to twelve places.
Measured on the current tree:

| where | what you edit |
|---|---|
| `public/index.html` | a `<script>` tag, in correct dependency order (65 today) |
| `public/index.html` | hand-written markup for the button/panel/modal |
| `app.js` `initElements()` | a `getElementById` into `this.elements` (67 entries) |
| `app.js` `initApp()` | `new X(container)` + `container.register(...)` |
| `app.js` `initEventListeners()` | the click handler |
| `app.js` `_initBusListeners()` | bus subscriptions |
| `core/constants.js` | `EVT.*` names |
| `tab-manager.js` | up to 7 of its 30 `case` arms, if it needs a document pane |
| `ws-handler.js` | a `case` in a 44-arm switch, plus a 13th injected dependency |
| `server.js` | construct the service, thread it into `createWsHandler({...})` |
| `styles.css` / `apple/*.css` | styling |
| `settings-dialog.js` | its settings section |

Nothing enforces that a feature's pieces stay together, so they drift apart.
The clearest symptom: `tts-manager.js` does not touch its own button. The
button is markup in `index.html`, cached in `app.js`, and wired — including its
long-press gesture — in `app.js`. Removing or relocating TTS is a twelve-file
change. There are 314 `this.app.*` reach-throughs across the client, and
`container.get('app')` is the single most-requested DI service, which means the
legacy escape hatch outranks the architecture that replaced it.

## What we already have

Three pieces of the answer exist and work:

- `Container` (`public/core/container.js`) — service locator, register by name.
- `EventBus` (`public/core/event-bus.js`) — pub/sub, ~130 named events.
- `ViewerRegistry` (`public/viewers/viewer-registry.js`) — a real strategy
  registry. Four viewers self-describe via `canHandle(ext)`; nothing else in
  the codebase knows they exist. This is the shape we want, scoped to one job.

What is missing is a way for a feature to contribute **DOM** — a button in the
right place, a settings section — without something else knowing about it.

## The decision

Generalise `ViewerRegistry` into a `FeatureRegistry`, and give `index.html`
named **slots** that features render into.

```js
FeatureRegistry.register({
  id: 'tts',
  init: (container) => new TTSManager(container),   // registered as container 'tts'
  slots: [
    { slot: 'chat-input-trailing', order: 20, render: (ctx) => buildTtsButton(ctx) },
  ],
  settings: { section: 'Voice', order: 10, render: (el, ctx) => renderTtsSettings(el, ctx) },
  events: { [EVT.CHAT_ASSISTANT_FINISH]: (d, ctx) => ctx.tts.speak(d.text) },
});
```

`index.html` carries `<div data-slot="chat-input-trailing"></div>` instead of a
hardcoded button row. At boot the registry constructs each feature, renders its
slot contributions in `order`, and subscribes its handlers to the bus.

### Why registration at file scope, with deferred construction

There is no bundler and no module system — 65 `<script>` tags put classes on
`window`, so load order is load-bearing today. A `register()` call at file scope
that only stores an `init` **closure** defers all construction to boot. File
order then stops mattering, as long as every file has loaded before boot runs.
That removes the ordering hazard without introducing a build step.

It also means migration is incremental. A feature that has not been converted
keeps working exactly as it does today; the registry is additive until the last
one moves.

### Why not a manifest-driven script loader

Injecting `<script>` tags from a manifest would also fix the "editing
index.html needs a server restart" problem, since `server.js` caches
`index.html` at startup. It is deliberately out of scope for now: it moves the
ordering problem into JS without removing it, and the restart requirement is an
irritation rather than a defect. Revisit once the registry has proved itself.

## Consequences

- A feature's button, settings, events and lifecycle live in one file.
- `app.js` loses its wiring glue — currently ~495 lines, 32% of the file.
- Deleting a feature becomes deleting a file plus its script tag.
- The cost is one indirection: you can no longer find a button by grepping
  `index.html` for its id. Grep the slot name instead.

## Out of scope for the first pass

`tab-manager.js` (30 `case` arms on pane type) and `ws-handler.js` (44-arm
switch, 13 injected dependencies) have the same shape of problem on the
document-pane and server sides. Both should eventually take a registry rather
than a switch. Neither is needed to prove the pattern, and bundling them would
make the first change unreviewable.
