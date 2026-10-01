/**
 * Home | Work. A project is visible in a mode when its mode is that mode or
 * `both` (missing or unknown means `both`). Presentation only: relay enforces
 * what each mode can reach. Design: docs/design-today-s1.md (S1-A4).
 */
const Mode = {
  KEY: 'eve-mode',
  MODES: ['home', 'work'],

  normalizeProjectMode(value) {
    return value === 'home' || value === 'work' ? value : 'both';
  },

  visible(project, mode) {
    const m = Mode.normalizeProjectMode(project && project.mode);
    return m === 'both' || m === mode;
  },

  // Work is the default; anything stored that is not a mode is ignored.
  load(storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    try {
      const v = storage && storage.getItem(Mode.KEY);
      return Mode.MODES.includes(v) ? v : 'work';
    } catch {
      return 'work';
    }
  },

  save(mode, storage = (typeof localStorage !== 'undefined' ? localStorage : null)) {
    try { storage && storage.setItem(Mode.KEY, mode); } catch {}
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Mode;
