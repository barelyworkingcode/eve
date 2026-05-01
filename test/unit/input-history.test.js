const InputHistory = require('../../public/input-history');

function mockLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
    _store: store,
  };
}

describe('InputHistory', () => {
  beforeEach(() => {
    global.localStorage = mockLocalStorage();
  });

  afterEach(() => {
    delete global.localStorage;
  });

  test('push adds entries and persists', () => {
    const h = new InputHistory('k', 100);
    h.push('hello');
    h.push('world');
    expect(h.entries).toEqual(['hello', 'world']);
    const raw = JSON.parse(localStorage.getItem('k'));
    expect(raw.entries).toEqual(['hello', 'world']);
  });

  test('push deduplicates consecutive duplicates', () => {
    const h = new InputHistory('k', 100);
    h.push('a');
    h.push('a');
    h.push('a');
    h.push('b');
    h.push('a');
    expect(h.entries).toEqual(['a', 'b', 'a']);
  });

  test('push drops empty and whitespace-only entries', () => {
    const h = new InputHistory('k', 100);
    h.push('');
    h.push('   ');
    h.push('\n\t');
    expect(h.entries).toEqual([]);
  });

  test('push trims whitespace', () => {
    const h = new InputHistory('k', 100);
    h.push('  hello  ');
    expect(h.entries).toEqual(['hello']);
  });

  test('push enforces cap by trimming oldest', () => {
    const h = new InputHistory('k', 3);
    h.push('a');
    h.push('b');
    h.push('c');
    h.push('d');
    expect(h.entries).toEqual(['b', 'c', 'd']);
  });

  test('prev walks oldest, returns null at start', () => {
    const h = new InputHistory('k', 100);
    h.push('a');
    h.push('b');
    h.push('c');
    expect(h.prev('')).toBe('c');
    expect(h.prev('')).toBe('b');
    expect(h.prev('')).toBe('a');
    expect(h.prev('')).toBeNull();
  });

  test('prev on empty history returns null', () => {
    const h = new InputHistory('k', 100);
    expect(h.prev('anything')).toBeNull();
  });

  test('next without prior prev returns null', () => {
    const h = new InputHistory('k', 100);
    h.push('a');
    expect(h.next()).toBeNull();
  });

  test('next walks back toward newest then restores draft', () => {
    const h = new InputHistory('k', 100);
    h.push('a');
    h.push('b');
    h.push('c');
    expect(h.prev('draft-text')).toBe('c');
    expect(h.prev('ignored-on-second-call')).toBe('b');
    expect(h.next()).toBe('c');
    expect(h.next()).toBe('draft-text');
    expect(h.next()).toBeNull();
  });

  test('prev snapshots draft only on first call', () => {
    const h = new InputHistory('k', 100);
    h.push('a');
    h.push('b');
    h.prev('first-draft');
    h.prev('not-a-draft');
    expect(h.draft).toBe('first-draft');
  });

  test('reset clears index and draft', () => {
    const h = new InputHistory('k', 100);
    h.push('a');
    h.prev('draft');
    expect(h.index).not.toBe(-1);
    h.reset();
    expect(h.index).toBe(-1);
    expect(h.draft).toBeNull();
    expect(h.next()).toBeNull();
  });

  test('push resets navigation state', () => {
    const h = new InputHistory('k', 100);
    h.push('a');
    h.push('b');
    h.prev('mid-draft');
    h.push('c');
    expect(h.index).toBe(-1);
    expect(h.draft).toBeNull();
  });

  test('persistence: second instance loads first instance entries', () => {
    const h1 = new InputHistory('k', 100);
    h1.push('one');
    h1.push('two');
    const h2 = new InputHistory('k', 100);
    expect(h2.entries).toEqual(['one', 'two']);
    expect(h2.prev('')).toBe('two');
  });

  test('load tolerates corrupt JSON', () => {
    localStorage.setItem('k', '{not valid json');
    const h = new InputHistory('k', 100);
    expect(h.entries).toEqual([]);
  });

  test('load tolerates missing entries field', () => {
    localStorage.setItem('k', JSON.stringify({ savedAt: 1 }));
    const h = new InputHistory('k', 100);
    expect(h.entries).toEqual([]);
  });

  test('load filters non-string entries and applies cap', () => {
    localStorage.setItem('k', JSON.stringify({
      entries: ['a', 'b', 'c', 'd'],
      savedAt: 1,
    }));
    const h = new InputHistory('k', 2);
    expect(h.entries).toEqual(['c', 'd']);
  });
});
