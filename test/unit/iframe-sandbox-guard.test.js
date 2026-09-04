// The module/preview trust model depends on every project-content iframe being
// sandboxed WITHOUT allow-same-origin; that invariant was previously guarded only
// by a code comment, so this scans source text across ALL iframe sites at once
// rather than only the paths a behavioral test happens to instantiate.
//
// public/viewers/pdf-viewer.js creates an iframe with no sandbox attribute at all
// (it renders a same-origin generated PDF via the browser's native viewer) — a
// deliberate exclusion, not an oversight; this guard only forbids allow-same-origin.
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

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

// Matches real assignments rather than a bare "allow-same-origin" substring, so
// warning comments like "(NO allow-same-origin)" don't produce false positives.
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

  const lockedSites = [
    'modules/module-host.js',
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
