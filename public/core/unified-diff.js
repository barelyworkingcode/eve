// Pure: a unified diff of one file from Monaco's line changes (ILineChange[]),
// for "Ask about this" on the diff pane (docs/design-workbench.md, S5a-A4).
// The changes come from the editor's own diff, so what is sent matches what is shown.
const UnifiedDiff = {
  // Monaco's line model: a text ending in a newline has a last, empty line. The line
  // changes count it, so it stays in the array (the ranges must line up) and is
  // never printed.
  _lines(text) {
    return (text || '').split('\n');
  },

  // Monaco counts a pure insertion as original lines [n+1, 0] after line n (and a
  // pure deletion the same way on the modified side): an end of 0 means none.
  _range(start, end) {
    return end === 0 ? { at: start, n: 0 } : { at: start - 1, n: end - start + 1 };
  },

  // original/modified: the two texts (null: the file does not exist on that side).
  format(path, original, modified, lineChanges, context = 3) {
    const a = this._lines(original);
    const b = this._lines(modified);
    const aEnd = a.length - 1; // the phantom line, when it is empty
    const bEnd = b.length - 1;
    const real = (lines, i, end) => i < lines.length && !(i === end && lines[i] === '');
    const changes = (lineChanges || []).map((c) => ({
      o: this._range(c.originalStartLineNumber, c.originalEndLineNumber),
      m: this._range(c.modifiedStartLineNumber, c.modifiedEndLineNumber),
    })).sort((x, y) => x.o.at - y.o.at);
    if (changes.length === 0) return '';

    // Changes closer than two contexts apart share a hunk.
    const groups = [[changes[0]]];
    for (const c of changes.slice(1)) {
      const g = groups[groups.length - 1];
      const prev = g[g.length - 1];
      if (c.o.at - (prev.o.at + prev.o.n) <= context * 2) g.push(c);
      else groups.push([c]);
    }

    const out = [`--- ${original == null ? '/dev/null' : `a/${path}`}`, `+++ ${modified == null ? '/dev/null' : `b/${path}`}`];
    for (const g of groups) {
      const first = g[0];
      const last = g[g.length - 1];
      const lead = Math.min(context, first.o.at);
      const trail = Math.min(context, a.length - (last.o.at + last.o.n));
      const body = [];
      let cursor = first.o.at - lead;
      for (const c of g) {
        for (; cursor < c.o.at; cursor++) if (real(a, cursor, aEnd)) body.push(` ${a[cursor]}`);
        for (let i = 0; i < c.o.n; i++) if (real(a, c.o.at + i, aEnd)) body.push(`-${a[c.o.at + i]}`);
        for (let i = 0; i < c.m.n; i++) if (real(b, c.m.at + i, bEnd)) body.push(`+${b[c.m.at + i]}`);
        cursor = c.o.at + c.o.n;
      }
      for (let i = 0; i < trail; i++) if (real(a, cursor + i, aEnd)) body.push(` ${a[cursor + i]}`);
      if (!body.some((l) => l[0] === '+' || l[0] === '-')) continue; // only the final newline differed

      const oStart = first.o.at - lead;
      const mStart = first.m.at - lead;
      const oLen = body.filter((l) => l[0] !== '+').length;
      const mLen = body.filter((l) => l[0] !== '-').length;
      // A zero-length side names the line before the hunk, as git does.
      out.push(`@@ -${oLen === 0 ? oStart : oStart + 1},${oLen} +${mLen === 0 ? mStart : mStart + 1},${mLen} @@`, ...body);
    }
    return out.length === 2 ? '' : `${out.join('\n')}\n`;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = UnifiedDiff;
