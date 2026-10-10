#!/usr/bin/env node
'use strict';

// PreToolUse guard for the eve-test-writer subagent (docs/test.md, "The
// eve-test-writer agent"). The hook sits in the project settings because a
// `hooks:` block in subagent frontmatter does not fire. It acts only when the
// hook input names that agent; every other agent and the main session pass.
// Exit 0 allows. Exit 2 refuses, with one line on stderr.

const fs = require('fs');
const path = require('path');

const AGENT = 'eve-test-writer';
const ROOT = path.resolve(__dirname, '..', '..');

const READ_DIRS = ['docs', 'test/e2e', 'test-results'];
const READ_FILES = ['CLAUDE.md', 'package.json', 'devboxverify/README.md'];
const WRITE_FILES = ['docs/FEATURES.md', 'test/e2e/coverage-pending.txt'];
const BASH_PREFIXES = [
  'npx playwright test', 'npm run -s lint', 'npm run -s check:coverage', 'node --check test/e2e/',
];
const BASH_FORBIDDEN = /[;&|<>`\n\r]|\$\(/;

const readRefusal = (p) => `eve-test-writer reads docs, specs and screens, not eve code: ${p}`;
const writeRefusal = (p) => `eve-test-writer edits only test/e2e specs, docs/FEATURES.md and the coverage pending list: ${p}`;
const bashRefusal = (c) => `eve-test-writer runs only playwright, lint, check:coverage and node --check on specs: ${c}`;

// Resolve against the repo root (or the session cwd), normalise `..`, then
// follow symlinks on the longest existing prefix so a link cannot lead out.
function resolveReal(p, cwd) {
  let abs = path.resolve(cwd || ROOT, p || '.');
  const tail = [];
  for (;;) {
    try { abs = path.join(fs.realpathSync(abs), ...tail.reverse()); break; } catch (_) {
      const parent = path.dirname(abs);
      if (parent === abs) break;
      tail.push(path.basename(abs));
      abs = parent;
    }
  }
  return abs;
}

function relToRoot(p, cwd) {
  const rel = path.relative(resolveReal(ROOT), resolveReal(p, cwd));
  return rel.split(path.sep).join('/');
}

function readAllowed(p, cwd) {
  const rel = relToRoot(p, cwd);
  if (rel === '' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return false;
  return READ_FILES.includes(rel) || READ_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

function writeAllowed(p, cwd) {
  const rel = relToRoot(p, cwd);
  return WRITE_FILES.includes(rel) || /^test\/e2e\/[^/]+\.spec\.js$/.test(rel);
}

function checkGlobPattern(pattern, cwd) {
  if (!pattern) return null;
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
    return readAllowed(pattern.replace(/[*?{[].*$/, ''), cwd) && !pattern.split(/[\\/]/).includes('..') ? null : readRefusal(pattern);
  }
  return null;
}

function checkBash(command, cwd) {
  const cmd = String(command || '').trim();
  const prefix = BASH_PREFIXES.find((p) => cmd === p || cmd.startsWith(`${p} `) || (p.endsWith('/') && cmd.startsWith(p)));
  // Words of the allowed prefix are not paths; `node --check test/e2e/` keeps its directory.
  const skip = prefix && !prefix.endsWith('/') ? prefix.split(' ').length : 1;
  const tokens = cmd.split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, ''));
  for (const t of tokens.slice(skip)) {
    if (t.startsWith('-') && !t.includes('/')) continue;
    const looksLikePath = /[\\/]/.test(t) || t.includes('..') || /\.[A-Za-z]\w*$/.test(t) || fs.existsSync(path.resolve(cwd || ROOT, t));
    if (looksLikePath && !readAllowed(t, cwd)) return readRefusal(t);
  }
  if (!prefix || BASH_FORBIDDEN.test(String(command))) return bashRefusal(cmd);
  return null;
}

// Returns null to allow, or the refusal line.
function decide(input) {
  if (!input || input.agent_type !== AGENT) return null;
  const ti = input.tool_input;
  if (!ti || typeof ti !== 'object') return `eve-test-writer: tool call has no input to check (${input.tool_name})`;
  const cwd = input.cwd;
  switch (input.tool_name) {
    case 'Read':
      return readAllowed(ti.file_path, cwd) ? null : readRefusal(ti.file_path);
    case 'Glob':
    case 'Grep': {
      const base = ti.path || '.';
      if (!readAllowed(base, cwd)) return readRefusal(ti.path || ROOT);
      return checkGlobPattern(ti.pattern, cwd) || checkGlobPattern(ti.glob, cwd);
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return writeAllowed(ti.file_path, cwd) ? null : writeRefusal(ti.file_path);
    case 'NotebookEdit':
      return writeRefusal(ti.notebook_path);
    case 'Bash':
      return checkBash(ti.command, cwd);
    default:
      return null;
  }
}

function selfTest() {
  const A = (tool_name, tool_input, agent_type = AGENT) => ({ agent_type, tool_name, tool_input, cwd: ROOT });
  const cases = [
    // [label, input, expect refuse]
    ['no agent_type', { tool_name: 'Read', tool_input: { file_path: 'public/app.js' } }, false],
    ['other agent', A('Read', { file_path: 'public/app.js' }, 'dev'), false],
    ['Read public/', A('Read', { file_path: 'public/app.js' }), true],
    ['Read routes/', A('Read', { file_path: `${ROOT}/routes/index.js` }), true],
    ['Read ws/', A('Read', { file_path: 'ws/message-registry.js' }), true],
    ['Read root js', A('Read', { file_path: 'server.js' }), true],
    ['Read dotdot', A('Read', { file_path: 'docs/../server.js' }), true],
    ['Read outside', A('Read', { file_path: '/etc/hosts' }), true],
    ['Read FEATURES', A('Read', { file_path: 'docs/FEATURES.md' }), false],
    ['Read spec', A('Read', { file_path: 'test/e2e/support/fixtures.js' }), false],
    ['Read CLAUDE.md', A('Read', { file_path: 'CLAUDE.md' }), false],
    ['Grep no path', A('Grep', { pattern: 'x' }), true],
    ['Grep public', A('Grep', { pattern: 'x', path: 'public' }), true],
    ['Grep docs', A('Grep', { pattern: 'x', path: 'docs' }), false],
    ['Grep glob dotdot', A('Grep', { pattern: 'x', path: 'docs', glob: '../server.js' }), true],
    ['Glob no path', A('Glob', { pattern: '**/*.js' }), true],
    ['Glob routes', A('Glob', { pattern: '*.js', path: 'routes' }), true],
    ['Glob docs', A('Glob', { pattern: '*.md', path: 'docs' }), false],
    ['Glob dotdot', A('Glob', { pattern: '../*.js', path: 'docs' }), true],
    ['Bash cat', A('Bash', { command: 'cat public/app.js' }), true],
    ['Bash cat docs', A('Bash', { command: 'cat docs/FEATURES.md' }), true],
    ['Bash chain ;', A('Bash', { command: 'npx playwright test; cat server.js' }), true],
    ['Bash chain &&', A('Bash', { command: 'npm run -s lint && cat server.js' }), true],
    ['Bash pipe', A('Bash', { command: 'npx playwright test | cat' }), true],
    ['Bash subst', A('Bash', { command: 'npx playwright test $(cat server.js)' }), true],
    ['Bash redirect', A('Bash', { command: 'npm run -s lint > routes/x.js' }), true],
    ['Bash arg path', A('Bash', { command: 'node --check test/e2e/../../server.js' }), true],
    ['Bash playwright', A('Bash', { command: 'npx playwright test test/e2e/g1-today.spec.js --grep "@G1.3"' }), false],
    ['Bash lint', A('Bash', { command: 'npm run -s lint' }), false],
    ['Bash coverage', A('Bash', { command: 'npm run -s check:coverage' }), false],
    ['Bash node check', A('Bash', { command: 'node --check test/e2e/g1-today.spec.js' }), false],
    ['Write spec', A('Write', { file_path: 'test/e2e/g1-today.spec.js' }), false],
    ['Edit FEATURES', A('Edit', { file_path: 'docs/FEATURES.md' }), false],
    ['Write pending', A('Write', { file_path: 'test/e2e/coverage-pending.txt' }), false],
    ['Write support', A('Write', { file_path: 'test/e2e/support/fixtures.js' }), true],
    ['Write public', A('Edit', { file_path: 'public/app.js' }), true],
    ['Write dotdot', A('Write', { file_path: 'test/e2e/../../server.js' }), true],
    ['Write test.md', A('Write', { file_path: 'docs/test.md' }), true],
    ['Notebook', A('NotebookEdit', { notebook_path: 'docs/x.ipynb' }), true],
    ['no input', { agent_type: AGENT, tool_name: 'Read' }, true],
  ];
  let bad = 0;
  for (const [label, input, refuse] of cases) {
    const got = decide(input);
    if (Boolean(got) !== refuse) { bad++; console.error(`FAIL ${label}: expected ${refuse ? 'refuse' : 'allow'}, got ${got || 'allow'}`); }
  }
  if (decide(A('Read', { file_path: 'public/app.js' })) !== readRefusal('public/app.js')) { bad++; console.error('FAIL refusal text'); }
  console.log(bad ? `${bad} self-test failures` : `self-test ok (${cases.length + 1} cases)`);
  return bad ? 1 : 0;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch (_) { /* treated as unparseable */ }
  let input;
  try { input = JSON.parse(raw); } catch (_) {
    // Unparseable: we cannot see the agent, so refuse only when the text names it.
    if (raw.includes(AGENT)) { console.error('eve-test-writer: hook input could not be parsed'); process.exit(2); }
    process.exit(0);
  }
  const refusal = decide(input);
  if (refusal) { console.error(refusal); process.exit(2); }
  process.exit(0);
}

main();
