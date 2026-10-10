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
// Options that point playwright or eslint at another config or reporter.
const BASH_FORBIDDEN_ARGS = /^(-c|-f)|^(--config|--reporter|--format)(=|$)/;
// Options whose next word is a pattern, not a path.
const PATTERN_OPTIONS = new Set(['--grep', '-g', '--grep-invert']);

const readRefusal = (p) => `eve-test-writer reads docs, specs and screens, not eve code: ${p}`;
const writeRefusal = (p) => `eve-test-writer edits only test/e2e specs, docs/FEATURES.md and the coverage pending list: ${p}`;
const specContentRefusal = (why) => `eve-test-writer specs require only ./support/fixtures and ./support/worlds, and use no import, process or child_process: ${why}`;
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
  const guarded = prefix && /^(npx playwright test|npm run -s lint)$/.test(prefix);
  let patternNext = false;
  for (const t of tokens.slice(skip)) {
    if (guarded && BASH_FORBIDDEN_ARGS.test(t)) return bashRefusal(cmd);
    if (patternNext) { patternNext = false; continue; }
    const opt = t.split('=')[0];
    if (PATTERN_OPTIONS.has(opt)) { patternNext = !t.includes('='); continue; }
    if (t.startsWith('-') && !t.includes('/')) continue;
    const looksLikePath = /[\\/]/.test(t) || t.includes('..') || /\.[A-Za-z]\w*$/.test(t) || fs.existsSync(path.resolve(cwd || ROOT, t));
    if (looksLikePath && !readAllowed(t, cwd)) return readRefusal(t);
  }
  if (!prefix || BASH_FORBIDDEN.test(String(command))) return bashRefusal(cmd);
  return null;
}

// The text a Write, Edit or MultiEdit would put into a spec.
function writtenText(ti) {
  const parts = [ti.content, ti.new_string];
  if (Array.isArray(ti.edits)) for (const e of ti.edits) parts.push(e && e.new_string);
  return parts.filter((x) => typeof x === 'string').join('\n');
}

function specContentRefusalFor(text) {
  const re = /\brequire\s*\(\s*(?:(['"`])([^'"`]*)\1)?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[2] === undefined || !/^\.\/support\/(fixtures|worlds)$/.test(m[2])) return specContentRefusal(`require(${m[2] === undefined ? '...' : m[2]})`);
  }
  if (/\bimport\b/.test(text)) return specContentRefusal('import');
  if (/\bprocess\./.test(text)) return specContentRefusal('process.');
  if (/child_process/.test(text)) return specContentRefusal('child_process');
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
      if (!writeAllowed(ti.file_path, cwd)) return writeRefusal(ti.file_path);
      return /^test\/e2e\/[^/]+\.spec\.js$/.test(relToRoot(ti.file_path, cwd)) ? specContentRefusalFor(writtenText(ti)) : null;
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
    ['grep dotted', A('Bash', { command: 'npx playwright test --grep "@G1\\.3\\b"' }), false],
    ['grep tag', A('Bash', { command: 'npx playwright test --grep @G1.3.r1' }), false],
    ['-g tag', A('Bash', { command: 'npx playwright test -g @G1.3.r1' }), false],
    ['grep=', A('Bash', { command: 'npx playwright test --grep=@G1.3.r1' }), false],
    ['grep-invert', A('Bash', { command: 'npx playwright test --grep-invert @G1.3' }), false],
    ['grep then path', A('Bash', { command: 'npx playwright test --grep @G1.3 server.js' }), true],
    ['pw -c', A('Bash', { command: 'npx playwright test -c other.config.js' }), true],
    ['pw -cx', A('Bash', { command: 'npx playwright test -cx' }), true],
    ['pw -fx', A('Bash', { command: 'npx playwright test -fx' }), true],
    ['lint -cx', A('Bash', { command: 'npm run -s lint -- -cx' }), true],
    ['lint -fx', A('Bash', { command: 'npm run -s lint -- -fx' }), true],
    ['pw --config', A('Bash', { command: 'npx playwright test --config x' }), true],
    ['pw --config=', A('Bash', { command: 'npx playwright test --config=x' }), true],
    ['pw --reporter', A('Bash', { command: 'npx playwright test --reporter=line' }), true],
    ['pw -f', A('Bash', { command: 'npx playwright test -f' }), true],
    ['lint --format', A('Bash', { command: 'npm run -s lint --format json' }), true],
    ['lint -c', A('Bash', { command: 'npm run -s lint -- -c x' }), true],
    ['Write ok spec', A('Write', { file_path: 'test/e2e/g1-today.spec.js', content: "const { test } = require('./support/fixtures');\nconst w = require('./support/worlds');" }), false],
    ['Write require fs', A('Write', { file_path: 'test/e2e/g1-today.spec.js', content: "require('fs')" }), true],
    ['Write require dyn', A('Write', { file_path: 'test/e2e/g1-today.spec.js', content: 'require(x)' }), true],
    ['Write require stack', A('Write', { file_path: 'test/e2e/g1-today.spec.js', content: "require('./support/stack')" }), true],
    ['Write import', A('Write', { file_path: 'test/e2e/g1-today.spec.js', content: "import x from 'y'" }), true],
    ['Write process', A('Write', { file_path: 'test/e2e/g1-today.spec.js', content: 'process.env.X' }), true],
    ['Write child_process', A('Write', { file_path: 'test/e2e/g1-today.spec.js', content: 'child_process' }), true],
    ['Edit process', A('Edit', { file_path: 'test/e2e/g1-today.spec.js', new_string: 'process.exit()' }), true],
    ['MultiEdit process', A('MultiEdit', { file_path: 'test/e2e/g1-today.spec.js', edits: [{ new_string: 'ok' }, { new_string: 'process.exit()' }] }), true],
    ['Write pending text', A('Write', { file_path: 'test/e2e/coverage-pending.txt', content: 'import process.' }), false],
    ['non-string command', { agent_type: AGENT, tool_name: 'Bash', tool_input: { command: 5 } }, true],
    ['no input', { agent_type: AGENT, tool_name: 'Read' }, true],
  ];
  let bad = 0;
  for (const [label, input, refuse] of cases) {
    const got = decide(input);
    if (Boolean(got) !== refuse) { bad++; console.error(`FAIL ${label}: expected ${refuse ? 'refuse' : 'allow'}, got ${got || 'allow'}`); }
  }
  if (decide(A('Read', { file_path: 'public/app.js' })) !== readRefusal('public/app.js')) { bad++; console.error('FAIL refusal text'); }
  // An exception inside decide must exit 2 for this agent and 0 for any other.
  const run = (agent) => require('child_process').spawnSync(process.execPath, [__filename], {
    input: JSON.stringify({ agent_type: agent, tool_name: 'Read', tool_input: { file_path: { x: 1 } } }), encoding: 'utf8',
  });
  if (run(AGENT).status !== 2) { bad++; console.error('FAIL exception exits 2 for the agent'); }
  if (run('dev').status !== 0) { bad++; console.error('FAIL exception passes other agents'); }
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
  let refusal;
  try { refusal = decide(input); } catch (err) {
    // A bug in the guard must not let the test writer through.
    if (input && input.agent_type === AGENT) { console.error(`eve-test-writer: the guard failed on this call (${err.message})`); process.exit(2); }
    process.exit(0);
  }
  if (refusal) { console.error(refusal); process.exit(2); }
  process.exit(0);
}

main();
