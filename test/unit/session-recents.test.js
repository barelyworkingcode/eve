/**
 * SessionRecents + the ui-utils naming helpers it feeds. Pure logic over a
 * stubbed localStorage — no DOM.
 */
const SessionRecents = require('../../public/core/session-recents');

function stubStorage() {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  return store;
}

describe('SessionRecents', () => {
  beforeEach(() => {
    stubStorage();
    global.SessionRecents = SessionRecents;
  });
  afterEach(() => {
    delete global.localStorage;
    delete global.SessionRecents;
  });

  test('touch records lastOpenedAt and list() is newest-first', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1000); SessionRecents.touch('a');
    nowSpy.mockReturnValue(2000); SessionRecents.touch('b');
    nowSpy.mockReturnValue(3000); SessionRecents.touch('a');
    expect(SessionRecents.list().map(e => e.id)).toEqual(['a', 'b']);
    expect(SessionRecents.get('a').lastOpenedAt).toBe(3000);
    nowSpy.mockRestore();
  });

  test('setTitle keeps the title across later touches and remove drops it', () => {
    SessionRecents.setTitle('s1', 'Refactor the relay transport\nmore detail');
    SessionRecents.touch('s1');
    expect(SessionRecents.get('s1').title).toBe('Refactor the relay transport');
    SessionRecents.remove('s1');
    expect(SessionRecents.get('s1')).toBeNull();
  });

  test('titleFromText skips markdown prefixes, slash commands and empty input', () => {
    expect(SessionRecents.titleFromText('## Plan\n\nFix the bug')).toBe('Plan');
    expect(SessionRecents.titleFromText('/clear')).toBe('');
    expect(SessionRecents.titleFromText('   ')).toBe('');
    expect(SessionRecents.titleFromText(null)).toBe('');
  });

  test('titleFromText truncates long lines at a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(40).trim();
    const t = SessionRecents.titleFromText(long);
    expect(t.length).toBeLessThanOrEqual(SessionRecents.TITLE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toMatch(/ …$/);
  });

  test('titleFromHistory reads block-array and JSON-encoded user content', () => {
    expect(SessionRecents.titleFromHistory([
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'Write the tests' }] },
    ])).toBe('Write the tests');
    expect(SessionRecents.titleFromHistory([
      { role: 'user', content: JSON.stringify([{ type: 'text', text: 'Encoded ask' }]) },
    ])).toBe('Encoded ask');
    expect(SessionRecents.titleFromHistory([{ role: 'user', content: '"quoted string"' }])).toBe('quoted string');
    expect(SessionRecents.titleFromHistory([])).toBe('');
  });

  test('prunes to MAX entries by recency', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    for (let i = 0; i < SessionRecents.MAX + 5; i++) {
      nowSpy.mockReturnValue(i);
      SessionRecents.touch(`s${i}`);
    }
    const ids = SessionRecents.list().map(e => e.id);
    expect(ids).toHaveLength(SessionRecents.MAX);
    expect(ids[0]).toBe(`s${SessionRecents.MAX + 4}`);
    expect(ids).not.toContain('s0');
    nowSpy.mockRestore();
  });
});

describe('ui-utils naming helpers', () => {
  const utils = require('../../public/core/ui-utils');

  beforeEach(() => {
    stubStorage();
    global.SessionRecents = SessionRecents;
  });
  afterEach(() => {
    delete global.localStorage;
    delete global.SessionRecents;
  });

  test('projectMonogram keeps siblings apart', () => {
    expect(utils.projectMonogram('Hermes Mail')).toBe('HM');
    expect(utils.projectMonogram('Hermes Files v3')).toBe('HF');
    expect(utils.projectMonogram('eve')).toBe('EV');
    expect(utils.projectMonogram('relayfs-mount-test')).toBe('RM');
    expect(utils.projectMonogram('')).toBe('?');
  });

  test('projectColorAtRank keeps the first dozen ranks at least 20° apart', () => {
    const hue = (rank) => Number(utils.projectColorAtRank(rank).match(/hsl\((\d+)/)[1]);
    const hues = Array.from({ length: 12 }, (_, i) => hue(i));
    for (let i = 0; i < hues.length; i++) {
      for (let j = i + 1; j < hues.length; j++) {
        const d = Math.abs(hues[i] - hues[j]);
        expect(Math.min(d, 360 - d)).toBeGreaterThanOrEqual(20);
      }
    }
    expect(utils.projectHue('x')).toBe(utils.projectHue('x'));
  });

  test('relativeTime is compact', () => {
    const now = 10_000_000_000;
    expect(utils.relativeTime(now - 10_000, now)).toBe('now');
    expect(utils.relativeTime(now - 12 * 60_000, now)).toBe('12m');
    expect(utils.relativeTime(now - 3 * 3_600_000, now)).toBe('3h');
    expect(utils.relativeTime(now - 2 * 86_400_000, now)).toBe('2d');
    expect(utils.relativeTime('not a date', now)).toBe('');
  });

  test('sessionDisplayName prefers a chosen name, then the remembered ask, then the model', () => {
    const project = { name: 'Chat Test' };
    const auto = { id: 's1', name: 'Chat Test - host/omlx/Chat', model: 'host/omlx/Chat' };
    expect(utils.sessionDisplayName(auto, project)).toBe('host/omlx/Chat');
    SessionRecents.setTitle('s1', 'Summarise the inbox');
    expect(utils.sessionDisplayName(auto, project)).toBe('Summarise the inbox');
    const renamed = { id: 's1', name: 'Inbox triage', model: 'host/omlx/Chat' };
    expect(utils.sessionDisplayName(renamed, project)).toBe('Inbox triage');
  });

  test('sessionDisplayName falls back to the server preview before the model name', () => {
    const project = { name: 'Chat Test' };
    const unseen = { id: 's9', name: 'Chat Test - sonnet', model: 'sonnet', preview: 'Plan the migration' };
    expect(utils.sessionDisplayName(unseen, project)).toBe('Plan the migration');
    SessionRecents.setTitle('s9', 'What I actually typed');
    expect(utils.sessionDisplayName(unseen, project)).toBe('What I actually typed');
    expect(utils.sessionDisplayName({ id: 's8', name: 'Chat Test - sonnet', model: 'sonnet', preview: '  ' }, project)).toBe('sonnet');
  });
});
