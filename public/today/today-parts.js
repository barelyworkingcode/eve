/**
 * Today's parts. A part is { id, modes, order, mount(el, ctx), refresh(), destroy() }:
 * it owns its DOM subtree, its data fetch and its error state, subscribes to its
 * own bus events through ctx.on, and patches its own subtree. The host lays out
 * whatever is registered for the current mode in `order` and contains every part's
 * failures, so one part throwing (or its source failing) never reaches another.
 * Design: docs/design-today-s1.md.
 */
class TodayRegistry {
  constructor() {
    this._parts = new Map();
  }

  register(part) {
    this._parts.set(part.id, part);
  }

  unregister(id) {
    this._parts.delete(id);
  }

  partsFor(mode) {
    return [...this._parts.values()]
      .filter(p => !p.modes || p.modes.includes(mode))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }
}

function todayClear(el) {
  if (el.replaceChildren) el.replaceChildren();
  else { el.children = []; el.textContent = ''; }
}

/** One line with Retry; shared by the host (a throw) and TodayPart (a failed load). */
function todayErrorLine(doc, partId, message, onRetry) {
  const wrap = doc.createElement('div');
  wrap.className = 'today__error';
  const line = doc.createElement('span');
  line.dataset.testid = `today-error-${partId}`;
  line.textContent = message;
  wrap.appendChild(line);
  const retry = doc.createElement('button');
  retry.type = 'button';
  retry.className = 'today__retry';
  retry.dataset.testid = `today-retry-${partId}`;
  retry.textContent = 'Retry';
  retry.addEventListener('click', onRetry);
  wrap.appendChild(retry);
  return wrap;
}

class TodayHost {
  /**
   * @param {object} o
   * @param {TodayRegistry} o.registry
   * @param {Document} [o.doc]
   * @param {(part, on) => object} [o.ctxFor] builds a part's ctx; `on` subscribes and is undone at destroy
   * @param {{on: Function}} [o.bus]
   */
  constructor({ registry, doc = document, ctxFor = () => ({}), bus = null }) {
    this.registry = registry;
    this.doc = doc;
    this.ctxFor = ctxFor;
    this.bus = bus;
    this.root = null;
    this.mode = null;
    this._mounted = new Map(); // id -> { part, el, unsubs }
  }

  mount(root, mode) {
    this.root = root;
    this.mode = mode;
    this._sync();
  }

  setMode(mode) {
    if (mode !== undefined) this.mode = mode;
    this._sync();
  }

  refresh(id) {
    const entry = this._mounted.get(id);
    if (!entry) return;
    this._guard(entry, () => entry.part.refresh());
  }

  destroy() {
    for (const entry of [...this._mounted.values()]) this._drop(entry);
  }

  _sync() {
    if (!this.root) return;
    const desired = this.registry.partsFor(this.mode);
    for (const entry of [...this._mounted.values()]) {
      if (!desired.includes(entry.part)) this._drop(entry);
    }
    for (const part of desired) {
      if (!this._mounted.has(part.id)) this._add(part);
    }
    const want = desired.map(p => p.id);
    const have = [...this.root.children].map(c => c.dataset.partId);
    if (want.join() !== have.join()) {
      for (const id of want) this.root.appendChild(this._mounted.get(id).el);
    }
  }

  _add(part) {
    const el = this.doc.createElement('section');
    el.className = 'home__section';
    el.dataset.partId = part.id;
    el.dataset.testid = `today-part-${part.id}`;
    el.dataset.state = 'ready';
    const unsubs = [];
    const on = (evt, fn) => { if (this.bus) unsubs.push(this.bus.on(evt, fn)); };
    const entry = { part, el, unsubs, ctx: null };
    this._mounted.set(part.id, entry);
    this.root.appendChild(el);
    this._guard(entry, () => {
      entry.ctx = this.ctxFor(part, on);
      part.mount(el, entry.ctx);
    });
  }

  _drop(entry) {
    this._mounted.delete(entry.part.id);
    this._guard(entry, () => entry.part.destroy(), { quiet: true });
    for (const off of entry.unsubs) { try { off(); } catch {} }
    entry.el.remove();
  }

  // A throw becomes that part's own error line; nothing else is touched.
  _guard(entry, fn, { quiet = false } = {}) {
    try {
      fn();
    } catch (err) {
      if (typeof console !== 'undefined') console.error(`[Today] part "${entry.part.id}" failed:`, err);
      if (quiet) return;
      todayClear(entry.el);
      entry.el.dataset.state = 'error';
      entry.el.appendChild(todayErrorLine(this.doc, entry.part.id, `Couldn't show ${entry.part.title || entry.part.id}.`,
        () => this._retryAfterThrow(entry)));
    }
  }

  _retryAfterThrow(entry) {
    todayClear(entry.el);
    entry.el.dataset.state = 'ready';
    this._guard(entry, () => entry.part.mount(entry.el, entry.ctx));
  }
}

/**
 * Base class for a part with data. Subclasses set `id`, `modes`, `order`, `title`,
 * `sources` (names from ctx.sources), implement `render(root)` (synchronous, reads
 * ctx.state and the sources) and call `subscribe(evt)` for the bus events that
 * should repaint this part only. The base owns the three states on the part root
 * (data-state loading|ready|error), the skeleton and the error line with Retry.
 */
class TodayPart {
  constructor() {
    this.sources = [];
    this.el = null;
    this.ctx = null;
  }

  mount(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.onMount?.();
    for (const name of this.sources) ctx.on(`today:source:${name}`, () => this.paint());
    for (const evt of this.events || []) ctx.on(evt, () => this.paint());
    for (const name of this.sources) ctx.sources[name].ensure();
    this.paint();
  }

  refresh() {
    for (const name of this.sources) this.ctx.sources[name].reload();
    this.paint();
  }

  destroy() {
    this.onDestroy?.();
    this.el = null;
  }

  paint() {
    if (!this.el) return;
    const states = this.sources.map(n => this.ctx.sources[n]);
    const failed = states.find(s => s.status === 'error');
    const doc = this.el.ownerDocument || document;
    if (failed) {
      todayClear(this.el);
      this.el.dataset.state = 'error';
      this.el.appendChild(todayErrorLine(doc, this.id, failed.describe(), () => this.refresh()));
      return;
    }
    if (states.some(s => s.status !== 'ready')) {
      if (this.el.dataset.state !== 'loading') {
        todayClear(this.el);
        this.el.dataset.state = 'loading';
        const sk = doc.createElement('div');
        sk.className = 'today__skeleton';
        sk.dataset.testid = `today-skeleton-${this.id}`;
        this.el.appendChild(sk);
      }
      return;
    }
    todayClear(this.el);
    this.el.dataset.state = 'ready';
    this.render(this.el);
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { TodayRegistry, TodayHost, TodayPart, todayErrorLine };
