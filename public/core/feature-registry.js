/**
 * See docs/decisions/001-feature-registry.md.
 *
 * register() deliberately constructs nothing: storing the `init` closure and
 * deferring construction to boot() is what makes <script> tag order in
 * index.html not matter, with no bundler.
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

  // Throws on a contribution naming a slot absent from the DOM, rather than
  // dropping it: a silently missing button is what this exists to prevent.
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
        .sort((a, b) => ((a.c.order ?? 0) - (b.c.order ?? 0)) || (a.i - b.i))
        .map(({ c }) => c);
      for (const c of list) {
        const node = c.render(container);
        if (node) el.appendChild(node);
      }
    }
  }
}

// Must exist at file scope: a feature file calls `features.register({...})`
// the moment its <script> tag is parsed, long before app.js boots it.
const features = new FeatureRegistry();
