/**
 * Today's part registry and host. Stub: the S1 red specs are written against this
 * surface; the body lands with the parts task (docs/design-today-s1.md, S1-A6).
 */
class TodayRegistry {
  register() {}
  unregister() {}
  partsFor() { return []; }
}

class TodayHost {
  constructor() {}
  mount() {}
  setMode() {}
  refresh() {}
  destroy() {}
}

if (typeof module !== 'undefined' && module.exports) module.exports = { TodayRegistry, TodayHost };
