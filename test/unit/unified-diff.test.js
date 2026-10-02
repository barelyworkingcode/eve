// S5a-A4: the diff pane's "Ask about this" sends a unified diff built from Monaco's
// line changes. Changes below use Monaco's ILineChange numbering (an end of 0 is a
// pure insertion or deletion after the start line). docs/design-workbench.md
const UnifiedDiff = require('../../public/core/unified-diff');

const change = (os, oe, ms, me) => ({
  originalStartLineNumber: os, originalEndLineNumber: oe, modifiedStartLineNumber: ms, modifiedEndLineNumber: me,
});
const lines = (n, from = 1) => Array.from({ length: n }, (_, i) => `l${from + i}`).join('\n') + '\n';

describe('UnifiedDiff.format', () => {
  it('formats an added line with context on both sides', () => {
    const orig = lines(10);
    const mod = orig.replace('l5\n', 'l5\nNEW\n');
    expect(UnifiedDiff.format('a.txt', orig, mod, [change(5, 0, 6, 6)])).toBe([
      '--- a/a.txt', '+++ b/a.txt',
      '@@ -3,6 +3,7 @@', ' l3', ' l4', ' l5', '+NEW', ' l6', ' l7', ' l8', '',
    ].join('\n'));
  });

  it('formats a deleted line', () => {
    const orig = lines(10);
    const mod = orig.replace('l5\n', '');
    expect(UnifiedDiff.format('a.txt', orig, mod, [change(5, 5, 4, 0)])).toBe([
      '--- a/a.txt', '+++ b/a.txt',
      '@@ -2,7 +2,6 @@', ' l2', ' l3', ' l4', '-l5', ' l6', ' l7', ' l8', '',
    ].join('\n'));
  });

  it('formats a changed line', () => {
    const orig = lines(10);
    const mod = orig.replace('l5\n', 'five\n');
    expect(UnifiedDiff.format('a.txt', orig, mod, [change(5, 5, 5, 5)])).toBe([
      '--- a/a.txt', '+++ b/a.txt',
      '@@ -2,7 +2,7 @@', ' l2', ' l3', ' l4', '-l5', '+five', ' l6', ' l7', ' l8', '',
    ].join('\n'));
  });

  it('starts at line 1 when the hunk is at the top of the file', () => {
    const orig = lines(6);
    const mod = orig.replace('l1\n', 'one\n');
    expect(UnifiedDiff.format('a.txt', orig, mod, [change(1, 1, 1, 1)])).toBe([
      '--- a/a.txt', '+++ b/a.txt',
      '@@ -1,4 +1,4 @@', '-l1', '+one', ' l2', ' l3', ' l4', '',
    ].join('\n'));
  });

  it('shows a new file against /dev/null with an empty original', () => {
    expect(UnifiedDiff.format('n.txt', null, 'x\ny\n', [change(0, 0, 1, 2)])).toBe([
      '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+x', '+y', '',
    ].join('\n'));
    expect(UnifiedDiff.format('n.txt', '', 'x\n', [change(0, 0, 1, 1)])).toBe([
      '--- a/n.txt', '+++ b/n.txt', '@@ -0,0 +1,1 @@', '+x', '',
    ].join('\n'));
  });

  it('merges nearby changes into one hunk and splits distant ones', () => {
    const orig = lines(30);
    const near = orig.replace('l5\n', 'A\n').replace('l9\n', 'B\n');
    expect(UnifiedDiff.format('a.txt', orig, near, [change(5, 5, 5, 5), change(9, 9, 9, 9)])
      .match(/^@@/gm)).toHaveLength(1);
    const far = orig.replace('l5\n', 'A\n').replace('l25\n', 'B\n');
    const out = UnifiedDiff.format('a.txt', orig, far, [change(5, 5, 5, 5), change(25, 25, 25, 25)]);
    expect(out.match(/^@@/gm)).toHaveLength(2);
    expect(out).toContain('@@ -22,7 +22,7 @@');
  });

  it('returns an empty string when nothing changed', () => {
    expect(UnifiedDiff.format('a.txt', 'a\n', 'a\n', [])).toBe('');
    expect(UnifiedDiff.format('a.txt', 'a\n', 'a\n', null)).toBe('');
  });
});

describe('UnifiedDiff.format and the last empty line', () => {
  it('never prints the empty line Monaco counts after a final newline', () => {
    // 'a\n' -> 'a\nb\n': Monaco reports an insertion of modified lines 2-3 after line 1.
    expect(UnifiedDiff.format('f.txt', 'a\n', 'a\nb\n', [change(1, 0, 2, 3)])).toBe([
      '--- a/f.txt', '+++ b/f.txt', '@@ -1,1 +1,2 @@', ' a', '+b', '',
    ].join('\n'));
  });

  it('prints nothing for a change that is only the final newline', () => {
    expect(UnifiedDiff.format('f.txt', 'a', 'a\n', [change(1, 0, 2, 2)])).toBe('');
  });
});
