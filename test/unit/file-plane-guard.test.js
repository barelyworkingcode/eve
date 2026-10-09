/**
 * The file-plane guard. Eve reaches project files only through relay, so no
 * module outside a short allowlist may load the file system, a child process,
 * ripgrep or a trash library. A new require elsewhere fails this test.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// Each entry carries the reason it may touch fs or child_process.
const ALLOWLIST = {
  'server.js': 'index.html, data dir, settings',
  'auth.js': 'auth.json',
  'session-store.js': 'sessions.json',
  'notifier.js': 'notifications log',
  'chief-of-staff.js': 'its data dir',
  'launch-identity.js': 'fd 3',
  'relay-transport.js': 'CA file',
  'terminal-paste.js': 'the OS temp dir, not a project',
  'ws/file-messages.js': '~/.claude/plans',
  'ws/diagnostics-messages.js': 'device log',
};

const DELETED_MODULES = [
  'file-service.js', 'remote-file-service.js', 'remote-fs-agent.js',
  'ssh-host-pool.js', 'ssh-command.js', 'search-service.js',
];

const BANNED = ['fs', 'fs/promises', 'child_process', '@vscode/ripgrep', 'trash'];
const SPECIFIER = `(?:node:)?(?:${BANNED.map((m) => m.replace('/', '\\/')).join('|')})(?:\\/[\\w/.-]*)?`;
const PATTERNS = [
  new RegExp(`\\brequire\\(\\s*(['"\`])${SPECIFIER}\\1\\s*\\)`),
  /\bimport\(\s*(['"`])trash\1\s*\)/,
];

// The scanner is itself tested by the table below.
function violations(source) {
  return PATTERNS.some((re) => re.test(source));
}

function scanFiles() {
  const out = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js') && fs.statSync(path.join(ROOT, f)).isFile());
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  for (const d of ['ws', 'routes', 'mcp']) if (fs.existsSync(path.join(ROOT, d))) walk(d);
  return out;
}

describe('file-plane guard: the scanner', () => {
  it.each([
    ["const fs = require('fs');", true],
    ['const fs = require("fs");', true],
    ["const fsp = require('fs').promises;", true],
    ["require('fs/promises')", true],
    ["require('node:fs')", true],
    ["require('node:fs/promises')", true],
    ["const { execFile } = require('child_process');", true],
    ["require('node:child_process')", true],
    ["const { rgPath } = require('@vscode/ripgrep');", true],
    ["const trash = require('trash');", true],
    ["const { default: trash } = await import('trash');", true],
    ["const path = require('path');", false],
    ["const x = require('./file-service-like');", false],
    ["const fsx = require('fsevents');", false],
    ["// uses the fs module", false],
  ])('%s -> %s', (src, expected) => {
    expect(violations(src)).toBe(expected);
  });
});

describe('file-plane guard: the repo', () => {
  const files = scanFiles();

  it('scans enough files to mean something', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it('allowlists only files that exist', () => {
    const missing = Object.keys(ALLOWLIST).filter((f) => !files.includes(f));
    expect(missing).toEqual([]);
  });

  it('has none of the deleted modules', () => {
    const present = DELETED_MODULES.filter((f) => fs.existsSync(path.join(ROOT, f)));
    expect(present).toEqual([]);
  });

  it('keeps fs, child_process, ripgrep and trash out of every file outside the allowlist', () => {
    const offenders = files
      .filter((f) => !(f in ALLOWLIST))
      .filter((f) => violations(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
