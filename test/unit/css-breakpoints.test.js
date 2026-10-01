// The layouts switch on two exact media strings (docs/design-today-s2.md,
// "Breakpoint model"); any other width query in the stylesheets is a third
// breakpoint nobody planned. The 380px and 540px refinements are the only others.
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const ALLOWED = new Set([
  '(max-width: 1023.98px)',
  '(max-width: 599.98px)',
  '(max-width: 380px)',
  '(max-width: 540px)',
]);

function cssFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return cssFiles(full);
    return e.name.endsWith('.css') ? [full] : [];
  });
}

// Every width feature in every @media prelude, whitespace-normalised.
function widthQueries(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const preludes = src.match(/@media[^{;]*/gi) || [];
  return preludes.flatMap((p) => (p.match(/\([^()]*width[^()]*\)/gi) || [])
    .map((q) => q.replace(/\s+/g, ' ').replace(/\s*:\s*/, ': ').replace(/\(\s+|\s+\)/g, (m) => m.trim())));
}

describe('CSS width queries', () => {
  test('the scanner flags a width query outside the allowed set', () => {
    const found = widthQueries(`
      @media (max-width: 768px) { a { b: c } }
      @media screen and (min-width:1024px) { a { b: c } }
      @media (width < 600px) { a { b: c } }
      /* @media (max-width: 100px) is a comment */
      @media (max-width:  599.98px) and (pointer: coarse) { a { b: c } }`);
    expect(found).toEqual(['(max-width: 768px)', '(min-width: 1024px)', '(width < 600px)', '(max-width: 599.98px)']);
    expect(found.filter((q) => !ALLOWED.has(q))).toHaveLength(3);
  });

  test('public/**/*.css uses only the two layout strings, 380px and 540px', () => {
    const offenders = [];
    let total = 0;
    for (const file of cssFiles(PUBLIC_DIR)) {
      for (const q of widthQueries(fs.readFileSync(file, 'utf8'))) {
        total++;
        if (!ALLOWED.has(q)) offenders.push(`${path.relative(PUBLIC_DIR, file)}: ${q}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(total).toBeGreaterThan(0); // a scanner that finds nothing proves nothing
  });
});
