#!/usr/bin/env node
'use strict';

// Proves the map: breaking an area's request-path code turns one of the area's
// selected specs red. For each area it breaks one catalogued line in a detached
// worktree at the base commit, picks specs with select() (the function the CI
// e2e job uses), runs them, and counts a failed test only when its title tags a
// row of a goal that lists the area. The broken file is restored byte for byte
// and its sha256 compared.
//
// Usage: node scripts/map-proof.js (--areas a,b | --all) [--base REV] [--record docs/map-proof.md]
// Output: PROVEN <area> <test ids>, GREEN <area>, BASE-RED <area> <test ids>,
//         REFUSED <area> <why>.
// Exit: 0 every area proven; 1 any GREEN, BASE-RED or REFUSED; 2 usage, git,
//       npm ci or build errors.
// Docs: docs/map-proof.md, docs/test.md ("Coverage").

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseMap, globToRegExp } = require('../devboxverify/areas');
const { parseFeatureMap, parseProofRecord, select, git, splitNul, TOP_SPEC, ROOT, PROOF_FILE } = require('./spec-map');

const USAGE = 'usage: map-proof.js (--areas a,b | --all) [--base REV] [--record docs/map-proof.md]';
const BREAKS_FILE = 'test/map-proof/breaks.json';
const ROW_TAG = /^G\d+\.\d+(?:\.r\d+)?$/;
const TABLE_HEAD = '| Area | File | Break | Base | Red tests | Date |';

class UsageError extends Error {}
class ToolError extends Error {}

/** @param {string} text @param {{find: string, replace: string}} brk */
function applyBreak(text, brk) {
  if (!brk.find) throw new Error('break has an empty find');
  const at = text.indexOf(brk.find);
  if (at < 0) throw new Error(`find text occurs 0 times in the file; want exactly once`);
  if (text.indexOf(brk.find, at + 1) >= 0) {
    throw new Error('find text occurs more than once in the file; want exactly once');
  }
  return text.slice(0, at) + brk.replace + text.slice(at + brk.find.length);
}

/** @param {string} json @returns {import('./spec-map').Break[]} */
function loadBreaks(json) {
  let v;
  try { v = JSON.parse(json); } catch (e) { throw new Error(`${BREAKS_FILE}: not JSON: ${e.message}`); }
  if (!Array.isArray(v)) throw new Error(`${BREAKS_FILE}: want an array of breaks`);
  v.forEach((b, i) => {
    for (const k of ['area', 'file', 'find', 'replace', 'why']) {
      if (!b || typeof b[k] !== 'string' || (k !== 'replace' && b[k] === '')) throw new Error(`${BREAKS_FILE}: break ${i} has no string "${k}"`);
    }
  });
  v.forEach((b, i) => {
    if (b.why.includes('|')) throw new Error(`${BREAKS_FILE}: break ${i} (${b.area}) has "|" in "why"; it would split the proof table row`);
  });
  const seen = new Set();
  for (const b of v) {
    if (seen.has(b.area)) throw new Error(`${BREAKS_FILE}: ${b.area} has two breaks; keep one`);
    seen.add(b.area);
  }
  return v;
}

// Tests of a Playwright JSON report: { file, title, tags, ok }.
function reportTests(report) {
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      const fromTitle = [...spec.title.matchAll(/@(\S+)/g)].map((m) => m[1]);
      const tags = [...(spec.tags || []).map((t) => t.replace(/^@/, '')), ...fromTitle];
      tests.push({ file: path.basename(spec.file), title: spec.title, tags, ok: spec.ok !== false && !(spec.tests || []).some((t) => t.status === 'unexpected') });
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of report.suites || []) walk(suite);
  return tests;
}

/**
 * Failed tests that count for `area`: the title tags a row of a goal that lists it.
 * @returns {string[]} sorted "<spec file> <tag>" ids
 */
function redTests(report, featureMap, area) {
  const out = new Set();
  for (const t of reportTests(report)) {
    if (t.ok) continue;
    for (const tag of t.tags) {
      if (!ROW_TAG.test(tag)) continue;
      const goal = tag.split('.')[0];
      if ((featureMap.goalAreas.get(goal) || []).includes(area)) out.add(`${t.file} ${tag}`);
    }
  }
  return [...out].sort();
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--areas' || a === '--base' || a === '--record') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      if (opts[a] !== undefined) throw new UsageError(`${a} given twice`);
      opts[a] = v;
    } else throw new UsageError(`unknown argument ${a}`);
  }
  if (opts.all === !!opts['--areas']) throw new UsageError('give exactly one of --areas and --all');
  if (opts['--base'] !== undefined && opts['--base'].startsWith('-')) throw new UsageError(`bad revision "${opts['--base']}"`);
  return opts;
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function runTool(cmd, args, cwd, env = cleanEnv()) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new ToolError(`${cmd}: ${r.error.message}`);
  return r;
}

// Runs Playwright in `cwd`; a failing test is a normal exit. Only a missing or
// unreadable report is an error. The report is read after the exit.
function playwright(cwd, reportFile, specs) {
  fs.rmSync(reportFile, { force: true });
  const env = { ...cleanEnv(), PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile };
  const r = runTool(process.execPath, [path.join(cwd, 'node_modules/@playwright/test/cli.js'), 'test', '--reporter=json', ...specs], cwd, env);
  let report;
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8')); } catch {
    throw new ToolError(`playwright test gave no report (exit ${r.status}): ${(r.stderr || '').trim().split('\n').pop()}`);
  }
  const fatal = (report.errors || []).filter((e) => !/No tests found/.test(e.message || ''));
  if (fatal.length) throw new ToolError(`playwright test: ${String(fatal[0].message).split('\n')[0]}`);
  return report;
}

function proveArea({ wt, brk, areaMap, featureMap, base, tracked, baseRed, reportFile }) {
  const { area } = brk;
  const areaDef = areaMap.areas[area];
  if (!areaDef) return { line: `REFUSED ${area} area is not defined in docs/areas.jsonc`, ok: false };
  if (areaDef.full) return { line: `REFUSED ${area} is a full area; it has no proof`, ok: false };
  if (!areaDef.code.map(globToRegExp).some((re) => re.test(brk.file))) {
    return { line: `REFUSED ${area} ${brk.file} is outside the area's code globs`, ok: false };
  }

  const target = path.join(wt, brk.file);
  let original;
  try { original = fs.readFileSync(target); } catch { return { line: `REFUSED ${area} ${brk.file} is not in the tree at base`, ok: false }; }
  let broken;
  try { broken = applyBreak(original.toString('utf8'), brk); } catch (e) { return { line: `REFUSED ${area} ${brk.file}: ${e.message}`, ok: false }; }

  const specsAtHead = tracked.filter((f) => TOP_SPEC.test(f));
  const sel = select({ root: wt, base, head: base, mergeBase: base, changed: [brk.file], specsAtHead, trackedAtHead: tracked, labels: [] });
  if (sel.unmapped.length || sel.specs.length === 0) return { line: `GREEN ${area}`, ok: false };
  const stuck = baseRed(sel.specs);
  if (stuck.length) return { line: `BASE-RED ${area} ${stuck.join('; ')}`, ok: false };

  let report;
  fs.writeFileSync(target, broken);
  try {
    report = playwright(wt, reportFile, sel.specs);
  } finally {
    fs.writeFileSync(target, original);
  }
  // Compared with the blob at base, not with the buffer just written back.
  const restored = git(wt, ['hash-object', '--no-filters', brk.file]).trim();
  if (restored !== git(wt, ['rev-parse', `${base}:${brk.file}`]).trim()) return { line: `REFUSED ${area} ${brk.file} differs from the original after restore (differs from the blob at base)`, fatal: true, ok: false };
  const red = redTests(report, featureMap, area);
  if (red.length === 0) return { line: `GREEN ${area}`, ok: false };
  return { line: `PROVEN ${area} ${red.join('; ')}`, ok: true, red };
}

// Replaces the table rows of the proved areas, keeps the other rows, and leaves
// every line outside the table as it was.
function recordRows(md, proved) {
  const lines = md.split('\n');
  const head = lines.findIndex((l) => l.startsWith('| Area |'));
  if (head < 0) throw new ToolError(`${PROOF_FILE}: no proof table; start from the header ${TABLE_HEAD}`);
  let end = head + 2;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  const kept = parseProofRecord(md).record.rows;
  const rows = new Map([...kept].map(([a, r]) => [a, `| ${a} | \`${r.file}\` | ${r.why} | ${r.base} | ${r.red.join('; ')} | ${r.date} |`]));
  for (const p of proved) rows.set(p.area, `| ${p.area} | \`${p.file}\` | ${p.why} | ${p.base} | ${p.red.join('; ')} | ${p.date} |`);
  return [...lines.slice(0, head + 2), ...rows.values(), ...lines.slice(end)].join('\n');
}

function main(argv, { out = console.log, err = console.error } = {}) {
  let wt = null;
  let tmp = null;
  try {
    const opts = parseArgs(argv);
    const base = git(ROOT, ['rev-parse', '--verify', `${opts['--base'] || 'HEAD'}^{commit}`]).trim();
    const breaks = loadBreaks(fs.readFileSync(path.join(ROOT, BREAKS_FILE), 'utf8'));
    const parsed = parseFeatureMap(git(ROOT, ['show', `${base}:docs/FEATURES.md`]));
    const featureMap = parsed.map;
    const areaMap = parseMap(git(ROOT, ['show', `${base}:docs/areas.jsonc`]));
    const proofText = fs.existsSync(path.join(ROOT, PROOF_FILE)) ? fs.readFileSync(path.join(ROOT, PROOF_FILE), 'utf8') : '';
    const parsedRecord = parseProofRecord(proofText);
    const record = parsedRecord.record;

    let wanted;
    if (opts.all) {
      wanted = Object.keys(areaMap.areas).filter((a) => !areaMap.areas[a].full && !featureMap.journeyOnly.has(a) && !record.pending.has(a));
    } else {
      wanted = opts['--areas'].split(',').map((a) => a.trim()).filter(Boolean);
      for (const a of wanted) if (!areaMap.areas[a]) throw new UsageError(`unknown area "${a}"`);
    }
    if (opts['--record'] && path.resolve(ROOT, opts['--record']) !== path.join(ROOT, PROOF_FILE)) throw new UsageError(`--record writes ${PROOF_FILE}`);
    if (opts['--record']) {
      if (!fs.existsSync(path.join(ROOT, PROOF_FILE))) throw new UsageError(`--record needs ${PROOF_FILE} to exist`);
      if (parsedRecord.findings.length) throw new ToolError(`--record refused: ${PROOF_FILE} has findings: ${parsedRecord.findings[0]}`);
    }

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-map-proof-'));
    wt = path.join(tmp, 'tree');
    git(ROOT, ['worktree', 'add', '--detach', wt, base]);
    const ci = runTool('npm', ['ci', '--no-audit', '--no-fund'], wt);
    if (ci.status !== 0) throw new ToolError(`npm ci failed (exit ${ci.status}): ${(ci.stderr || '').trim().split('\n').pop()}`);
    const tracked = splitNul(git(wt, ['ls-files', '-z']));

    const reportFile = path.join(tmp, 'report.json');
    // One run of every spec the wanted areas select stands for "the area's specs are green".
    const specsAtBase = tracked.filter((f) => TOP_SPEC.test(f));
    const selectFor = (area) => {
      const brk = breaks.find((b) => b.area === area);
      if (!brk) return [];
      return select({ root: wt, base, head: base, mergeBase: base, changed: [brk.file], specsAtHead: specsAtBase, trackedAtHead: tracked, labels: [] }).specs;
    };
    const union = [...new Set(wanted.flatMap(selectFor))].sort();
    const baseReport = union.length ? playwright(wt, path.join(tmp, 'base.json'), union) : { suites: [] };
    const baseTests = reportTests(baseReport);
    const baseRed = (specs) => {
      const names = new Set(specs.map((s) => path.basename(s)));
      return baseTests.filter((t) => !t.ok && names.has(t.file)).map((t) => `${t.file} ${t.title}`);
    };

    const proved = [];
    let bad = false;
    const date = new Date().toISOString().slice(0, 10);
    for (const area of wanted) {
      const brk = breaks.find((b) => b.area === area);
      if (!brk) { out(`REFUSED ${area} no break in ${BREAKS_FILE}`); bad = true; continue; }
      const r = proveArea({ wt, brk, areaMap, featureMap, base, tracked, baseRed, reportFile });
      out(r.line);
      if (r.fatal) { bad = true; break; }
      if (r.ok) proved.push({ area, file: brk.file, why: brk.why, base, red: r.red, date });
      else bad = true;
    }

    if (opts['--record'] && proved.length) {
      const file = path.join(ROOT, PROOF_FILE);
      fs.writeFileSync(file, recordRows(fs.readFileSync(file, 'utf8'), proved));
    }
    return bad ? 1 : 0;
  } catch (e) {
    err(`map-proof: ${e instanceof UsageError ? `${e.message}\n${USAGE}` : e.message}`);
    return 2;
  } finally {
    if (wt) {
      try { git(ROOT, ['worktree', 'remove', '--force', wt]); } catch { /* the temp dir goes next */ }
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { applyBreak, redTests, loadBreaks, main, parseArgs };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
