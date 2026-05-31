/**
 * Guard: `public/` is served unauthenticated by express.static, so no secret
 * or state file may ever live there. data/ (auth.json, sessions.json) and
 * certs/ are separate trees — this test fails loudly if that stops being true.
 * See docs/security-audit-frontend.md (L3).
 */
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

// Filenames / extensions that must never be reachable from the web root.
const FORBIDDEN_NAMES = new Set(['auth.json', 'sessions.json', 'settings.json', '.env']);
const FORBIDDEN_EXTS = new Set(['.pem', '.key', '.crt', '.p12', '.pfx']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe('static public/ exposure guard', () => {
  const files = walk(PUBLIC_DIR);

  it('contains no secret or state files', () => {
    const offenders = files.filter((f) => {
      const base = path.basename(f);
      return FORBIDDEN_NAMES.has(base) || FORBIDDEN_EXTS.has(path.extname(base).toLowerCase());
    });
    expect(offenders).toEqual([]);
  });

  it('does not nest the data/ or certs/ directories under public/', () => {
    expect(fs.existsSync(path.join(PUBLIC_DIR, 'data'))).toBe(false);
    expect(fs.existsSync(path.join(PUBLIC_DIR, 'certs'))).toBe(false);
  });
});
