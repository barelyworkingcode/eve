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

  it("keeps every path Playwright's default testMatch runs", () => {
    const paths = [
      'test/e2e/a.test.js', 'test/e2e/a.spec.mjs', 'test/e2e/a.spec.cjs', 'test/e2e/a.spec.ts',
      'test/e2e/a.test.mts', 'test/e2e/a.spec.cts', 'test/e2e/a.spec.jsx', 'test/e2e/a.test.tsx',
    ];
    expect(burnInSpecs(paths, undefined, ROOT)).toEqual(paths);
  });

  it('drops names that testMatch would not run', () => {
    expect(burnInSpecs(['test/e2e/a.specs.js', 'test/e2e/a.spec.json', 'test/e2e/spec.js', 'test/e2e/a.spec.js.snap'], undefined, ROOT)).toEqual([]);
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
