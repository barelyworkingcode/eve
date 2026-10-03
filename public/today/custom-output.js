/**
 * Output schema v1 for a custom Today card: what a script writes, normalised and
 * capped. Pure. Every string is untrusted (it may hold summarised mail): callers
 * set it with textContent only, and a link is built only from safeUrl().
 * Reference for script authors: docs/design-today-custom.md.
 */
const CustomOutput = (() => {
  const LIMITS = { title: 120, detail: 200, label: 60, value: 40, cell: 80, url: 2048 };
  const MAX = { items: 50, columns: 8, rows: 50, metrics: 12 };

  const cap = (v, max) => {
    const s = (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  };
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return cap(s, LIMITS.cell);
  };
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  function safeUrl(s) {
    if (typeof s !== 'string' || s.length > LIMITS.url) return null;
    try {
      const { protocol } = new URL(s);
      return protocol === 'http:' || protocol === 'https:' ? s : null;
    } catch { return null; }
  }

  function isPartTask(task) {
    return !!task && task.sessionType === 'pty' && typeof task.outputFile === 'string' && task.outputFile !== '';
  }

  const SHAPES = {
    list(o) {
      if (!Array.isArray(o.items)) return null;
      const items = [];
      for (const i of o.items) {
        if (!isObject(i)) continue;
        const title = cap(i.title, LIMITS.title);
        if (title) items.push({ title, detail: cap(i.detail, LIMITS.detail), url: safeUrl(i.url) });
        if (items.length === MAX.items) break;
      }
      return { items };
    },
    table(o) {
      if (!Array.isArray(o.columns) || o.columns.length === 0 || !Array.isArray(o.rows)) return null;
      const columns = o.columns.slice(0, MAX.columns).map(cell);
      const rows = o.rows.filter(Array.isArray).slice(0, MAX.rows)
        .map((r) => columns.map((_, i) => cell(r[i])));
      return { columns, rows };
    },
    metrics(o) {
      if (!Array.isArray(o.metrics)) return null;
      const metrics = [];
      for (const m of o.metrics) {
        if (!isObject(m)) continue;
        const label = cap(m.label, LIMITS.label);
        if (label) metrics.push({ label, value: cap(m.value, LIMITS.value), detail: cap(m.detail, LIMITS.detail) });
        if (metrics.length === MAX.metrics) break;
      }
      return { metrics };
    },
  };

  function parse(text) {
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };
    let o;
    try { o = JSON.parse(text); } catch { return { ok: false, reason: 'bad-json' }; }
    if (!isObject(o)) return { ok: false, reason: 'bad-json' };
    if (!Object.hasOwn(SHAPES, o.renderer)) return { ok: false, reason: 'unknown-renderer' };
    const data = SHAPES[o.renderer](o);
    return data ? { ok: true, renderer: o.renderer, data } : { ok: false, reason: 'bad-shape' };
  }

  return { RENDERERS: Object.keys(SHAPES), isPartTask, parse, safeUrl };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CustomOutput;
