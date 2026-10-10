#!/usr/bin/env node
'use strict';

// Static guards a linter cannot express: CSS, HTML, file names and frozen
// sets. The ESLint rules live in eslint.config.js; the frozen data lives in
// test/static/frozen.json, so a deliberate change shows in the diff.
//
// Usage: node scripts/check-static.js
// Output: one finding per line, `<check>: <file>[:<line>]: <what>`.
// Exit: 0 clean, 1 findings, 2 usage error or an unreadable input.
// Docs: docs/test.md, "Lint rules and checks".

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const abs = (rel) => path.join(ROOT, rel);
const read = (rel) => fs.readFileSync(abs(rel), 'utf8');

const REMOVED_MODULES = [
  'file-service.js', 'remote-file-service.js', 'remote-fs-agent.js',
  'ssh-host-pool.js', 'ssh-command.js', 'search-service.js',
];
// Sandboxed with allow-scripts and nothing else (CLAUDE.md). The PDF viewer's
// iframe has no sandbox on purpose: it shows a same-origin generated PDF.
const LOCKED_IFRAME_SITES = ['html-preview-pane.js', 'file-editor.js'];
const FORBIDDEN_PUBLIC_NAMES = new Set(['auth.json', 'sessions.json', 'settings.json', '.env']);
const FORBIDDEN_PUBLIC_EXTS = new Set(['.pem', '.key', '.crt', '.p12', '.pfx']);
const WORLD_FIXTURE_NAMES = /Acme Corp|Globex|todo\.txt|\bbudget\b/g;

function walk(rel, keep) {
  const out = [];
  for (const entry of fs.readdirSync(abs(rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(child, keep));
    else if (keep(entry.name)) out.push(child);
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ---- S1 file plane ----
function checkFilePlane(frozen, add) {
  const config = require(abs('eslint.config.js'));
  const entry = config.find((c) => c.name === 'E1 allowlist');
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
    add('S1', 'eslint.config.js', 'no config object named "E1 allowlist" with files');
    return;
  }
  const inScope = (f) => !f.includes('/') || /^(ws|routes|mcp)\//.test(f);
  for (const f of entry.files) {
    if (!fs.existsSync(abs(f)) || !inScope(f)) add('S1', f, 'the E1 allowlist names a file that does not exist in the scanned tree');
  }
  for (const f of REMOVED_MODULES) {
    if (fs.existsSync(abs(f))) add('S1', f, 'a removed local file-plane module is back');
  }
}

// ---- S2 iframe sandbox ----
function sandboxValues(src, isHtml) {
  const patterns = isHtml
    ? [/\bsandbox\s*=\s*["']([^"']*)["']/g]
    : [/setAttribute\(\s*['"]sandbox['"]\s*,\s*['"]([^'"]*)['"]\s*\)/g, /\.sandbox\s*=\s*['"]([^'"]*)['"]/g];
  const out = [];
  for (const re of patterns) for (const m of src.matchAll(re)) out.push({ value: m[1], line: lineOf(src, m.index) });
  return out;
}

function checkIframeSandbox(frozen, add) {
  for (const f of walk('public', (n) => n.endsWith('.html'))) {
    for (const { value, line } of sandboxValues(read(f), true)) {
      if (/allow-same-origin/.test(value)) add('S2', `${f}:${line}`, `sandbox="${value}" grants allow-same-origin`);
    }
  }
  for (const name of LOCKED_IFRAME_SITES) {
    const rel = `public/${name}`;
    const values = sandboxValues(read(rel), false);
    if (!values.some((v) => v.value === 'allow-scripts')) add('S2', rel, 'no iframe sandbox of exactly allow-scripts found');
    for (const { value, line } of values) {
      if (value !== 'allow-scripts') add('S2', `${rel}:${line}`, `sandbox "${value}" is not exactly allow-scripts`);
    }
  }
}

// ---- S3 public exposure ----
function checkPublicExposure(frozen, add) {
  for (const f of walk('public', () => true)) {
    const base = path.basename(f);
    if (FORBIDDEN_PUBLIC_NAMES.has(base) || FORBIDDEN_PUBLIC_EXTS.has(path.extname(base).toLowerCase())) {
      add('S3', f, 'a secret or state file under public/, which is served without sign-in');
    }
  }
  for (const dir of ['data', 'certs']) {
    if (fs.existsSync(abs(`public/${dir}`))) add('S3', `public/${dir}`, 'this folder must not sit under public/');
  }
}

// ---- S4 CSS breakpoints ----
function widthQueries(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const preludes = src.match(/@media[^{;]*/gi) || [];
  return preludes.flatMap((p) => (p.match(/\([^()]*width[^()]*\)/gi) || [])
    .map((q) => q.replace(/\s+/g, ' ').replace(/\s*:\s*/, ': ').replace(/\(\s+|\s+\)/g, (m) => m.trim())));
}

function checkBreakpoints(frozen, add) {
  const allowed = new Set(frozen.breakpoints);
  let total = 0;
  for (const f of walk('public', (n) => n.endsWith('.css'))) {
    for (const q of widthQueries(read(f))) {
      total++;
      if (!allowed.has(q)) add('S4', f, `width query ${q} is not in frozen.breakpoints`);
    }
  }
  if (total === 0) add('S4', 'public', 'found no width query at all; the scanner proves nothing');
}

// ---- S5 and S6 websocket surface ----
function clientTypes() {
  const { messages } = require(abs('ws/message-registry'));
  const src = read('ws-handler.js');
  const labels = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
  const guards = [...src.matchAll(/message\.type === '([a-z_]+)'/g)].map((m) => m[1]);
  // A migrated type can be gone from the switch and live only as a descriptor.
  return { messages, types: new Set([...labels, ...guards, ...messages.types()]) };
}

function diffSets(check, file, what, actual, frozen, add) {
  for (const t of actual) if (!frozen.includes(t)) add(check, file, `${what} "${t}" is not frozen; add it to test/static/frozen.json on purpose`);
  for (const t of frozen) if (!actual.has(t)) add(check, file, `${what} "${t}" is frozen but gone from the code`);
}

function checkWsSurface(frozen, add) {
  const { types } = clientTypes();
  diffSets('S5', 'ws-handler.js', 'client message type', types, frozen.wsTypes, add);
  const api = read('docs/api.md');
  for (const t of types) {
    if (!new RegExp(`[\`"']${t}[\`"']`).test(api)) add('S5', 'docs/api.md', `client message type "${t}" is not named`);
  }
}

function checkWsRegistry(frozen, add) {
  const { messages } = clientTypes();
  diffSets('S6', 'ws/message-registry.js', 'expensive type', messages.expensiveTypes(), frozen.expensiveTypes, add);
  // A handler is async only where its arm is awaited: an unawaited async
  // handler turns a rejection into a browser-visible error frame.
  const asyncNow = new Set(messages.types().filter((t) => messages.get(t).handle.constructor.name === 'AsyncFunction'));
  diffSets('S6', 'ws/message-registry.js', 'async handler', asyncNow, frozen.asyncHandlers, add);
}

// ---- S7 area map ----
function trackedFiles() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${(r.stderr || '').trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

function checkAreaMap(frozen, add) {
  const { parseMap, unmapped, fixedTrigger, SMOKE } = require(abs('devboxverify/areas'));
  const { journeys } = require(abs('devboxverify/journeys'));
  const map = parseMap(read('docs/areas.jsonc'));
  const tracked = trackedFiles();
  for (const f of unmapped(map, tracked.filter((t) => !fixedTrigger(t)))) {
    add('S7', f, 'in no area and not quiet; add it to docs/areas.jsonc');
  }
  // M4: an app file must reach an area, not only `quiet`.
  const { mapFindings } = require(abs('scripts/spec-map'));
  for (const f of mapFindings({ areaMap: map, featureMap: null, trackedFiles: tracked, pendingGoals: new Set() }, ['M4'])) {
    const cut = f.indexOf(': ');
    add('S7', f.slice(0, cut), f.slice(cut + 2));
  }
  const known = new Set(Object.keys(map.areas));
  for (const j of journeys) for (const a of j.areas) if (!known.has(a)) add('S7', 'devboxverify/journeys.js', `journey ${j.id} names area "${a}", which docs/areas.jsonc lacks`);
  const byId = new Map(journeys.map((j) => [j.id, j]));
  for (const id of SMOKE) {
    const j = byId.get(id);
    if (!j) add('S7', 'devboxverify/areas.js', `smoke journey ${id} does not exist`);
    else if (j.screen || j.fixture) add('S7', 'devboxverify/areas.js', `smoke journey ${id} is not a plain journey`);
  }
  const order = journeys.map((j) => j.id);
  if (!SMOKE.includes('chat-reply')) add('S7', 'devboxverify/areas.js', 'the smoke set lacks chat-reply');
  for (const later of ['open-existing-thread', 'listen']) {
    if (order.indexOf('chat-reply') > order.indexOf(later)) add('S7', 'devboxverify/journeys.js', `chat-reply must come before ${later}`);
  }
}

// ---- S8 devbox journey set ----
function describeJourney(j) {
  const o = { id: j.id, needs: [...j.needs].sort(), areas: [...j.areas].sort(), timeoutMs: j.timeoutMs };
  if (j.screen) o.screen = true;
  if (j.fixture) o.fixture = true;
  return o;
}

function checkJourneySet(frozen, add) {
  const { orderJourneys } = require(abs('devboxverify/main'));
  const { journeys } = require(abs('devboxverify/journeys'));
  const actual = orderJourneys(journeys, { screen: true }).run.map(describeJourney);
  const wanted = new Map(frozen.journeys.map((j) => [j.id, j]));
  const seen = new Set();
  for (const j of actual) {
    seen.add(j.id);
    const w = wanted.get(j.id);
    if (!w) { add('S8', 'devboxverify/journeys.js', `journey ${j.id} is not in frozen.journeys`); continue; }
    if (JSON.stringify(j) !== JSON.stringify(w)) add('S8', 'devboxverify/journeys.js', `journey ${j.id} differs from frozen.journeys: now ${JSON.stringify(j)}, frozen ${JSON.stringify(w)}`);
  }
  for (const id of wanted.keys()) if (!seen.has(id)) add('S8', 'devboxverify/journeys.js', `journey ${id} is frozen but gone`);
  const nowOrder = actual.map((j) => j.id).filter((id) => wanted.has(id));
  const wantOrder = frozen.journeys.map((j) => j.id).filter((id) => seen.has(id));
  if (nowOrder.join() !== wantOrder.join()) add('S8', 'devboxverify/main.js', 'the journey run order differs from frozen.journeys');
}

// ---- S9 no world fixture in a journey body ----
// Declarations (needs, the files file-edit-save shows) may name fixtures;
// function bodies may not.
function checkJourneyBodies(frozen, add) {
  for (const name of ['journeys.js', 'journeys-auth.js', 'journey-kit.js']) {
    const rel = `devboxverify/${name}`;
    const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
    const bodies = code.match(/^(?:async )?function [\s\S]*?^\}$|^const \w+ = (?:async )?\([^)]*\) =>.*$/gm) || [];
    if (bodies.length <= 3) add('S9', rel, 'the body scan found too few functions to mean anything');
    const hits = bodies.join('\n').match(WORLD_FIXTURE_NAMES);
    if (hits) add('S9', rel, `a function body names a world fixture directly: ${[...new Set(hits)].join(', ')}`);
  }
}

// ---- S10 eve-test-writer hook ----
function checkWriterGuard(frozen, add) {
  const rel = '.claude/hooks/eve-test-writer-guard.js';
  if (!fs.existsSync(abs(rel))) { add('S10', rel, 'missing; the eve-test-writer read guard must exist'); return; }
  const r = spawnSync(process.execPath, [abs(rel), '--self-test'], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`;
    add('S10', rel, `--self-test failed (${why})`);
  }
}

// ---- S11 self-tests ----
// Every test/static/*-selftest.js runs as a child process and must exit 0.
function checkSelfTests(frozen, add) {
  const dir = 'test/static';
  for (const name of fs.readdirSync(abs(dir)).filter((n) => n.endsWith('-selftest.js')).sort()) {
    const r = spawnSync(process.execPath, [abs(`${dir}/${name}`)], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      const why = r.error ? r.error.message : `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n')[0]}`;
      add('S11', `${dir}/${name}`, `self-test failed (${why})`);
    }
  }
}

const CHECKS = [
  checkFilePlane, checkIframeSandbox, checkPublicExposure, checkBreakpoints, checkWsSurface,
  checkWsRegistry, checkAreaMap, checkJourneySet, checkJourneyBodies, checkWriterGuard, checkSelfTests,
];

function main(argv, { out = console.log, err = console.error } = {}) {
  if (argv.length) { err('usage: check-static.js (no arguments)'); return 2; }
  let frozen;
  try { frozen = JSON.parse(read('test/static/frozen.json')); } catch (e) { err(`check-static: test/static/frozen.json: ${e.message}`); return 2; }
  const findings = [];
  const add = (check, where, what) => findings.push(`${check}: ${where}: ${what}`);
  for (const check of CHECKS) {
    try { check(frozen, add); } catch (e) { err(`check-static: ${check.name}: ${e.message}`); return 2; }
  }
  for (const f of findings) out(f);
  if (findings.length === 0) out(`check-static: ok (${CHECKS.length} checks)`);
  return findings.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, widthQueries, sandboxValues };
