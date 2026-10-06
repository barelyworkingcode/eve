const path = require('path');
const { burnInSpecs } = require('../../scripts/burn-in-specs');

const ROOT = path.resolve(__dirname, '..', '..');
const { testIgnore } = require('../../playwright.config.js');

describe('burnInSpecs', () => {
  it('keeps e2e specs and drops helpers, json and paths outside test/e2e', () => {
    const out = burnInSpecs([
      'test/e2e/a.spec.js',
      'test/e2e/sub/b.spec.js',
      'test/e2e/helpers.js',
      'test/e2e/data.json',
      'test/unit/c.spec.js',
      'public/d.spec.js',
    ], undefined, ROOT);
    expect(out).toEqual(['test/e2e/a.spec.js', 'test/e2e/sub/b.spec.js']);
  });

  it('applies the real playwright testIgnore: drops voice.spec.js, keeps voice-buttons.spec.js', () => {
    const out = burnInSpecs(['test/e2e/voice.spec.js', 'test/e2e/voice-buttons.spec.js'], testIgnore, ROOT);
    expect(out).toEqual(['test/e2e/voice-buttons.spec.js']);
  });

  it('returns an empty list when nothing qualifies', () => {
    expect(burnInSpecs(['test/e2e/helpers.js'], testIgnore, ROOT)).toEqual([]);
  });

  it.each([['a string', 'voice'], ['a function', () => true]])('throws EIGNORE on %s testIgnore', (_n, shape) => {
    expect(() => burnInSpecs(['test/e2e/a.spec.js'], shape, ROOT)).toThrow(expect.objectContaining({ code: 'EIGNORE' }));
  });
});
