// FrontDoor (S2-A5): written from docs/design-today-s2.md. Away means no
// stamp for 60 minutes; exactly 60:00 counts; a missing key counts.
const FrontDoor = require('../../public/core/front-door.js');

const MIN = 60 * 1000;
const NOW = 1_800_000_000_000;

function storage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

describe('FrontDoor.isAway', () => {
  test('constants', () => {
    expect(FrontDoor.KEY).toBe('eve-last-active');
    expect(FrontDoor.AWAY_MS).toBe(3600000);
  });

  test('a missing stamp is away', () => {
    expect(FrontDoor.isAway(null, NOW)).toBe(true);
    expect(FrontDoor.isAway(undefined, NOW)).toBe(true);
  });

  test('garbage is away', () => {
    expect(FrontDoor.isAway('soon', NOW)).toBe(true);
    expect(FrontDoor.isAway('', NOW)).toBe(true);
    expect(FrontDoor.isAway('NaN', NOW)).toBe(true);
  });

  test('59:59 is not away', () => {
    expect(FrontDoor.isAway(String(NOW - (60 * MIN - 1000)), NOW)).toBe(false);
  });

  test('exactly 60:00 is away', () => {
    expect(FrontDoor.isAway(String(NOW - 60 * MIN), NOW)).toBe(true);
  });

  test('a fresh stamp is not away', () => {
    expect(FrontDoor.isAway(String(NOW), NOW)).toBe(false);
  });
});

describe('FrontDoor.read and stamp', () => {
  test('stamp then read round-trips epoch ms under the key', () => {
    const s = storage();
    FrontDoor.stamp(s, NOW);
    expect(s.getItem('eve-last-active')).toBe(String(NOW));
    expect(FrontDoor.read(s)).toBe(String(NOW));
  });

  test('read of an empty store is null', () => {
    expect(FrontDoor.read(storage())).toBeNull();
  });

  test('a throwing store neither throws nor reports a stamp', () => {
    const bad = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); } };
    expect(() => FrontDoor.stamp(bad, NOW)).not.toThrow();
    expect(FrontDoor.read(bad)).toBeNull();
  });
});
