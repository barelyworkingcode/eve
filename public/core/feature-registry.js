/**
 * FeatureRegistry - lets a feature own its own DOM, services and subscriptions.
 *
 * Why: see docs/decisions/001-feature-registry.md. In short, adding a feature
 * with a UI surface currently means hand-editing a dozen places, and nothing
 * keeps a feature's pieces together.
 *
 * A feature is a plain descriptor:
 *
 *   FeatureRegistry.register({
 *     id: 'tts',                                   // unique; also the container key
 *     init: (container) => new TTSManager(container),
 *     slots: [{ slot: 'chat-input-trailing', order: 20, render: (c) => el }],
 *     events: { [EVT.CHAT_ASSISTANT_FINISH]: (data, container) => {} },
 *   });
 *
 * register() deliberately constructs NOTHING. Storing an `init` closure and
 * deferring construction to boot() is what makes the 65 <script> tags in
 * index.html order-insensitive without introducing a build step: a file may
 * register before the classes it names exist, as long as they exist by boot.
 */
class FeatureRegistry {
  constructor() {
    this._features = [];
    this._byId = new Map();
  }

  register(feature) {
    if (!feature || !feature.id) throw new Error('[FeatureRegistry] feature needs an id');
    if (this._byId.has(feature.id)) {
      throw new Error(`[FeatureRegistry] duplicate feature id: ${feature.id}`);
    }
    this._byId.set(feature.id, feature);
    this._features.push(feature);
    return this;
  }

  has(id) { return this._byId.has(id); }
  ids() { return this._features.map((f) => f.id); }

  /**
   * Construct every feature in registration order, register each result in the
   * container under its id, and subscribe its event handlers to the bus.
   */
  boot(container) {
    for (const feature of this._features) {
      if (typeof feature.init === 'function') {
        const instance = feature.init(container);
        if (instance !== undefined) container.register(feature.id, instance);
      }
    }
    const bus = container.has('bus') ? container.get('bus') : null;
    if (bus) {
      for (const feature of this._features) {
        for (const [event, handler] of Object.entries(feature.events || {})) {
          bus.on(event, (data) => handler(data, container));
        }
      }
    }
  }

  /**
   * Fill every [data-slot] under `root` with its contributions, ordered.
   *
   * A contribution naming a slot that isn't in the DOM throws rather than
   * disappearing: a silently missing button is the exact failure this design
   * exists to prevent.
   */
  renderSlots(root, container) {
    const contributions = new Map();
    for (const feature of this._features) {
      for (const c of feature.slots || []) {
        if (!contributions.has(c.slot)) contributions.set(c.slot, []);
        contributions.get(c.slot).push({ ...c, featureId: feature.id });
      }
    }

    const present = new Set();
    const nodes = root.querySelectorAll('[data-slot]');
    for (const el of nodes) present.add(el.dataset.slot);

    for (const [slot, list] of contributions) {
      if (!present.has(slot)) {
        const who = [...new Set(list.map((c) => c.featureId))].join(', ');
        throw new Error(
          `[FeatureRegistry] no [data-slot="${slot}"] in the DOM, contributed by: ${who}`,
        );
      }
    }

    for (const el of nodes) {
      const list = (contributions.get(el.dataset.slot) || [])
        .map((c, i) => ({ c, i }))
        // Stable: equal orders fall back to registration order.
        .sort((a, b) => ((a.c.order ?? 0) - (b.c.order ?? 0)) || (a.i - b.i))
        .map(({ c }) => c);
      for (const c of list) {
        const node = c.render(container);
        if (node) el.appendChild(node);
      }
    }
  }
}

/**
 * The page's registry. Feature files call `features.register({...})` at file
 * scope; app.js boots it once the container exists.
 *
 * It has to be created here, not in app.js, because that is the whole point of
 * deferred construction: a feature file runs the moment its <script> tag is
 * parsed, long before initApp(), so there must already be something for it to
 * register against. A top-level `const` in a classic script is visible to every
 * script parsed after it — the same way `EVT` in core/constants.js is.
 */
const features = new FeatureRegistry();
