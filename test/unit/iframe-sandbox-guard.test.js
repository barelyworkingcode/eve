/**
 * Iframe sandbox invariant guard (eve/CLAUDE.md, module trust model invariant #4:
 * "Never add allow-same-origin").
 *
 * The entire module/preview trust model — no Eve cookies, no DOM access, no
 * ambient fetch, postMessage origin checks that rely on an opaque `null` origin —
 * depends on every project-content iframe being sandboxed WITHOUT
 * `allow-same-origin`. That invariant was guarded only by a code comment; one
 * careless edit (or a new iframe site) would silently re-grant same-origin and
 * no other test would notice. This is a source-level guard because the threat is
 * a source edit, and it must cover ALL iframe sites at once, not just the paths a
 * behavioral test happens to instantiate.
 *
 * Note: public/viewers/pdf-viewer.js creates an iframe with no sandbox attribute
 * (it renders a same-origin generated PDF via the browser's native viewer) — a
 * deliberate exclusion, not an oversight. This guard checks sandbox *values*, so
 * it neither requires nor forbids that; it only forbids allow-same-origin.
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

/** Recursively collect every .js/.html file under public/. */
function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (/\.(js|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract every sandbox-attribute *value* assigned in a file. We match real
 * assignments (JS setAttribute / .sandbox =, HTML sandbox="...") rather than a
 * bare "allow-same-origin" substring, so warning comments like "(NO
 * allow-same-origin)" are correctly ignored.
 */
function sandboxValues(file) {
  const src = fs.readFileSync(file, 'utf8');
  const values = [];
  const patterns = file.endsWith('.html')
    ? [/\bsandbox\s*=\s*["']([^"']*)["']/g]
    : [
        /setAttribute\(\s*['"]sandbox['"]\s*,\s*['"]([^'"]*)['"]\s*\)/g,
        /\.sandbox\s*=\s*['"]([^'"]*)['"]/g,
      ];
  for (const re of patterns) {
    let mt;
    while ((mt = re.exec(src)) !== null) values.push(mt[1]);
  }
  return values;
}

describe('iframe sandbox invariant', () => {
  const files = collectFiles(PUBLIC_DIR);

  test('public/ is being scanned (sanity)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test('no iframe anywhere under public/ is granted allow-same-origin', () => {
    const offenders = [];
    for (const file of files) {
      for (const value of sandboxValues(file)) {
        if (/allow-same-origin/.test(value)) {
          offenders.push(`${path.relative(PUBLIC_DIR, file)}: sandbox="${value}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The three iframe sites that render project/module content must be locked to
  // exactly allow-scripts. (pdf-viewer.js is intentionally excluded — see header.)
  const lockedSites = [
    'modules/module-host.js', // invariant #4 — the module iframe
    'html-preview-pane.js',
    'file-editor.js',
  ];
  test.each(lockedSites)('%s sandboxes its iframe to exactly allow-scripts', (rel) => {
    const values = sandboxValues(path.join(PUBLIC_DIR, rel));
    expect(values).toContain('allow-scripts');
    for (const value of values) {
      expect(value).toBe('allow-scripts');
    }
  });
});
