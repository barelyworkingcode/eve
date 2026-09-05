// command-palette.js is a classic script (`class CommandPalette extends
// DialogBase`), so `DialogBase` must exist as a global before it's required —
// see test/unit/tab-manager-logic.test.js for the same "stub the browser
// globals a classic script expects" approach. None of the cases below
// instantiate CommandPalette (no DOM needed): they exercise the static, pure
// matching/ranking/ordering helpers directly.
const { escapeHtml } = require('../../public/core/ui-utils.js');

function loadCommandPalette() {
  jest.resetModules();
  global.DialogBase = class DialogBase {};
  global.escapeHtml = escapeHtml;
  return require('../../public/dialogs/command-palette.js');
}

describe('CommandPalette.fuzzyScore', () => {
  const CommandPalette = loadCommandPalette();

  it('matches a case-insensitive subsequence', () => {
    const result = CommandPalette.fuzzyScore('hlo', 'Hello World');
    expect(result).not.toBeNull();
    expect(result.positions).toEqual([0, 2, 4]);
  });

  it('returns null when the query is not a subsequence', () => {
    expect(CommandPalette.fuzzyScore('xyz', 'Hello World')).toBeNull();
  });

  it('returns a zero-cost match for an empty query', () => {
    expect(CommandPalette.fuzzyScore('', 'anything')).toEqual({ score: 0, positions: [] });
  });

  it('scores contiguous / word-start matches higher than scattered ones', () => {
    // "he" as a contiguous, word-start prefix of "Hello" ...
    const tight = CommandPalette.fuzzyScore('he', 'hello');
    // ... vs "h" + "e" split far apart across a gap, each restarting a "word".
    const loose = CommandPalette.fuzzyScore('he', 'h-------e');
    expect(tight.score).toBeGreaterThan(loose.score);
  });
});

describe('CommandPalette.matchItem', () => {
  const CommandPalette = loadCommandPalette();

  it('matches across label + sub but only highlights positions within label', () => {
    // Combined text is "label sub", so a query spanning both must name the
    // label's characters before the sub's ("foo" from the label, "proj" from
    // the sub) to remain a valid subsequence.
    const m = CommandPalette.matchItem('fooproj', 'foo.js', 'project-alpha');
    expect(m).not.toBeNull();
    expect(m.labelPositions).toEqual([0, 1, 2]);
  });

  it('gives items whose label starts with the query a ranking bonus', () => {
    const prefixMatch = CommandPalette.matchItem('set', 'Settings', 'Appearance, voice, providers');
    const scatteredMatch = CommandPalette.matchItem('set', 'Reset all settings', '');
    expect(prefixMatch.score).toBeGreaterThan(scatteredMatch.score);
  });

  it('returns null when nothing in label+sub matches the query', () => {
    expect(CommandPalette.matchItem('zzz', 'Settings', 'Appearance')).toBeNull();
  });

  it('treats an empty query as a universal match with no highlights', () => {
    expect(CommandPalette.matchItem('', 'Settings', 'Appearance')).toEqual({ score: 0, labelPositions: [] });
  });
});

describe('CommandPalette.highlightLabel', () => {
  const CommandPalette = loadCommandPalette();

  it('wraps a contiguous run of matched positions in a single <mark>', () => {
    const html = CommandPalette.highlightLabel('Settings', [3, 4, 5]);
    expect(html).toBe('Set<mark>tin</mark>gs');
  });

  it('escapes HTML both inside and outside the marked run', () => {
    const html = CommandPalette.highlightLabel('A&B', [0]);
    expect(html).toBe('<mark>A</mark>&amp;B');
  });

  it('escapes with no marks when there are no matched positions', () => {
    expect(CommandPalette.highlightLabel('Tom & Jerry', [])).toBe('Tom &amp; Jerry');
  });
});

describe('CommandPalette.stripProjectPrefix', () => {
  const CommandPalette = loadCommandPalette();

  it('strips the "<project name> - " prefix', () => {
    expect(CommandPalette.stripProjectPrefix('Hermes Mail - triage', 'Hermes Mail')).toBe('triage');
  });

  it('leaves the name untouched when it does not start with the project prefix', () => {
    expect(CommandPalette.stripProjectPrefix('triage', 'Hermes Mail')).toBe('triage');
  });

  it('leaves the name untouched when there is no project', () => {
    expect(CommandPalette.stripProjectPrefix('Hermes Mail - triage', undefined)).toBe('Hermes Mail - triage');
  });
});

describe('CommandPalette.orderSessionsForEmptyQuery', () => {
  const CommandPalette = loadCommandPalette();

  const sessions = [
    { id: 'a', active: false },
    { id: 'b', active: true },
    { id: 'c', active: false },
    { id: 'd', active: true },
    { id: 'e', active: false },
  ];

  it('orders recent tabs first (in getRecentSessionIds order), then active, then the rest', () => {
    const ordered = CommandPalette.orderSessionsForEmptyQuery(sessions, ['c', 'a']);
    expect(ordered.map(s => s.id)).toEqual(['c', 'a', 'b', 'd', 'e']);
  });

  it('does not duplicate a session that is both recent and active', () => {
    const ordered = CommandPalette.orderSessionsForEmptyQuery(sessions, ['d']);
    expect(ordered.map(s => s.id)).toEqual(['d', 'b', 'a', 'c', 'e']);
    expect(new Set(ordered.map(s => s.id)).size).toBe(ordered.length);
  });

  it('caps the result to the given limit', () => {
    const ordered = CommandPalette.orderSessionsForEmptyQuery(sessions, [], 2);
    expect(ordered).toHaveLength(2);
    expect(ordered.map(s => s.id)).toEqual(['b', 'd']);
  });

  it('ignores recent ids that no longer correspond to a live session', () => {
    const ordered = CommandPalette.orderSessionsForEmptyQuery(sessions, ['ghost', 'a']);
    expect(ordered.map(s => s.id)).toEqual(['a', 'b', 'd', 'c', 'e']);
  });
});
