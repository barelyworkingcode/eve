// S1-A4: a project is visible in a mode when its mode is that mode or `both`.
// docs/design-today-s1.md
const Mode = require('../../public/core/mode');

const store = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; }, data };
};

describe('Mode', () => {
  it.each([
    ['work', 'work', true], ['work', 'home', false],
    ['home', 'home', true], ['home', 'work', false],
    ['both', 'work', true], ['both', 'home', true],
    [undefined, 'work', true], [undefined, 'home', true],
    ['nonsense', 'work', true],
  ])('a project with mode %s is visible in %s: %s', (projectMode, mode, expected) => {
    expect(Mode.visible({ mode: projectMode }, mode)).toBe(expected);
  });

  it('normalizes an unknown project mode to both', () => {
    expect(Mode.normalizeProjectMode('home')).toBe('home');
    expect(Mode.normalizeProjectMode('work')).toBe('work');
    expect(Mode.normalizeProjectMode('both')).toBe('both');
    expect(Mode.normalizeProjectMode(undefined)).toBe('both');
    expect(Mode.normalizeProjectMode('x')).toBe('both');
  });

  it('opens in work by default, and ignores a stored value that is not a mode', () => {
    expect(Mode.load(store())).toBe('work');
    expect(Mode.load(store({ 'eve-mode': 'home' }))).toBe('home');
    expect(Mode.load(store({ 'eve-mode': 'both' }))).toBe('work');
    expect(Mode.load({ getItem: () => { throw new Error('blocked'); } })).toBe('work');
  });

  it('saves the choice under eve-mode', () => {
    const s = store();
    Mode.save('home', s);
    expect(s.data['eve-mode']).toBe('home');
  });
});
