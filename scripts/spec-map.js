'use strict';

// The map rules and spec selection for the hermetic suite. Two maps meet here:
// docs/areas.jsonc (code path -> area) and the Goals table plus row Spec cells
// of docs/FEATURES.md (area -> goal -> spec). Pure except for the git reads in
// select(); nothing here falls back to "run everything" on an error. An
// unreadable input throws, and the caller exits non-zero.
//
// Docs: docs/test.md, "Coverage"; the grammar is in docs/FEATURES.md, "Areas".

const { spawnSync } = require('child_process');
const path = require('path');
const { parseMap, globToRegExp } = require('../devboxverify/areas');
const { parseFeatures, parseSpec, splitRow, parsePending } = require('./check-coverage');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = 'docs/areas.jsonc';
const FEATURES_FILE = 'docs/FEATURES.md';
const SPEC_DIR = 'test/e2e';
const TOP_SPEC = /^test\/e2e\/[\w.-]+\.spec\.js$/;
const ANY_SPEC = /\.spec\.js$/;
const AREA_NAME = /^[a-z][a-z-]*$/;
const APPROVED_LABEL = 'map-narrowing-approved';

// Fixed in code, not in the map: the map is read from the head, so a PR could
// otherwise narrow its own run. browser-lock.js is loaded by the global setup.
const SPEC_HARNESS = ['test/e2e/support/**', 'test/e2e/relay-pin.json', 'playwright.config.js', 'scripts/browser-lock.js'];
const HARNESS_RES = SPEC_HARNESS.map(globToRegExp);

const RULES = ['M2', 'M3', 'M4', 'M5', 'syntax'];
const PROOF_FILE = 'docs/map-proof.md';
const PENDING_FILE = 'test/e2e/coverage-pending.txt';

/** @typedef {{ goalAreas: Map<string,string[]>, specRows: Map<string,string[]>, journeyOnly: Set<string> }} FeatureMap */

function sectionBody(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

function parseGoalAreas(text, findings) {
  const goalAreas = new Map();
  const body = sectionBody(text, 'Goals');
  if (body === null) { findings.push('docs/FEATURES.md: no "## Goals" section'); return goalAreas; }
  let idCol = -1;
  let areasCol = -1;
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = splitRow(line);
    if (idCol < 0) {
      idCol = cells.indexOf('#');
      areasCol = cells.indexOf('Areas');
      if (idCol < 0 || areasCol < 0) { findings.push('docs/FEATURES.md: the Goals table has no # or Areas column'); return goalAreas; }
      continue;
    }
    if (/^-+$/.test(cells[idCol])) continue;
    if (!/^G\d+$/.test(cells[idCol])) { findings.push(`${cells[idCol]}: not a goal ID of the form G<n>`); continue; }
    goalAreas.set(cells[idCol], cells[areasCol].split(',').map((a) => a.trim()).filter(Boolean));
  }
  if (goalAreas.size === 0) findings.push('docs/FEATURES.md: the Goals table has no goals');
  return goalAreas;
}

// `Journey-only: none`, or a comma-separated list of areas, once, in "## Areas".
function parseJourneyOnly(text, findings) {
  const out = new Set();
  const body = sectionBody(text, 'Areas');
  if (body === null) { findings.push('Journey-only: docs/FEATURES.md has no "## Areas" section'); return out; }
  const lines = body.split('\n').filter((l) => /^Journey-only:/.test(l));
  if (lines.length !== 1) {
    findings.push(`Journey-only: want exactly one "Journey-only:" line in "## Areas", found ${lines.length}`);
    return out;
  }
  const value = lines[0].slice('Journey-only:'.length).trim();
  if (value === 'none') return out;
  for (const item of value.split(',').map((a) => a.trim())) {
    if (!AREA_NAME.test(item) || item === 'none') findings.push(`Journey-only: "${item}" is not an area name; write "none" or a comma-separated list of areas`);
    else out.add(item);
  }
  return out;
}

/**
 * @param {string} featuresMd
 * @returns {{ map: FeatureMap, findings: string[] }}
 * Throws on a malformed row table, as parseFeatures does.
 */
function parseFeatureMap(featuresMd) {
  const findings = [];
  const goalAreas = parseGoalAreas(featuresMd, findings);
  const specRows = new Map();
  for (const row of parseFeatures(featuresMd)) {
    for (const file of parseSpec(row.spec).files) specRows.set(file, [...(specRows.get(file) || []), row.id]);
  }
  const journeyOnly = parseJourneyOnly(featuresMd, findings);
  return { map: { goalAreas, specRows, journeyOnly }, findings };
}

const goalOf = (rowId) => rowId.split('.')[0];

/** A spec's areas: the Areas cells of the goals whose rows name it. */
function specAreas(featureMap) {
  const out = new Map();
  for (const [spec, rows] of featureMap.specRows) {
    const areas = new Set();
    for (const row of rows) for (const a of featureMap.goalAreas.get(goalOf(row)) || []) areas.add(a);
    out.set(spec, [...areas].sort());
  }
  return out;
}

function specsByArea(featureMap) {
  const out = new Map();
  for (const [spec, areas] of specAreas(featureMap)) {
    for (const a of areas) out.set(a, new Set([...(out.get(a) || []), spec]));
  }
  return out;
}

const matches = (res, file) => res.some((re) => re.test(file));

function isAppFile(file) {
  if (file.endsWith('.md')) return false;
  if (/^(public|routes|ws|mcp)\//.test(file)) return true;
  return /^[^/]+\.js$/.test(file) && !file.endsWith('.config.js');
}

/** @typedef {{ area: string, file: string, find: string, replace: string, why: string }} Break */
/** @typedef {{ rows: Map<string, { file: string, why: string, base: string, red: string[], date: string }>,
 *   journeyOnly: Map<string, string>, pending: Map<string, { goals: string[], issues: number[] }> }} ProofRecord */

// docs/map-proof.md: a table of proof rows, then "## Journey-only areas" (`none`
// or `- <area>: <reason>`) and "## Pending" (`none` or `- <area>: G8 (#369), ...`).
function parseProofRecord(md) {
  const findings = [];
  const record = { rows: new Map(), journeyOnly: new Map(), pending: new Map() };
  const lines = md.split('\n');
  const at = (heading) => lines.indexOf(`## ${heading}`);
  const sectionLines = (heading) => {
    const i = at(heading);
    if (i < 0) { findings.push(`${PROOF_FILE}: no "## ${heading}" section`); return []; }
    const rest = lines.slice(i + 1);
    const end = rest.findIndex((l) => l.startsWith('## '));
    return (end < 0 ? rest : rest.slice(0, end)).map((l) => l.trim()).filter(Boolean);
  };

  const head = lines.findIndex((l) => l.startsWith('| Area |'));
  if (head < 0) findings.push(`${PROOF_FILE}: no proof table (header "| Area | File | Break | Base | Red tests | Date |")`);
  else {
    for (const line of lines.slice(head + 1)) {
      if (!line.startsWith('|')) { if (line.trim()) break; else continue; }
      const cells = splitRow(line);
      if (/^-+$/.test(cells[1])) continue;
      if (cells.length !== 8) { findings.push(`${PROOF_FILE}: row "${cells[1]}" has ${cells.length - 2} cells, want 6`); continue; }
      const [area, file, why, base, red, date] = cells.slice(1, 7);
      if (record.rows.has(area)) { findings.push(`${PROOF_FILE}: ${area} has two proof rows`); continue; }
      if (!/^[0-9a-f]{40}$/.test(base)) findings.push(`${PROOF_FILE}: ${area}: Base "${base}" is not a 40-hex commit`);
      const redTests = red.split(';').map((t) => t.trim()).filter(Boolean);
      if (redTests.length === 0) findings.push(`${PROOF_FILE}: ${area}: no red tests`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) findings.push(`${PROOF_FILE}: ${area}: Date "${date}" is not YYYY-MM-DD`);
      record.rows.set(area, { file: file.replace(/^`|`$/g, ''), why, base, red: redTests, date });
    }
  }

  for (const line of sectionLines('Journey-only areas')) {
    if (line === 'none') continue;
    const m = /^- ([a-z][a-z-]*): (\S.*)$/.exec(line);
    if (!m) findings.push(`${PROOF_FILE}: Journey-only line "${line}" is not "- <area>: <reason>" or "none"`);
    else record.journeyOnly.set(m[1], m[2]);
  }
  for (const line of sectionLines('Pending')) {
    if (line === 'none') continue;
    const m = /^- ([a-z][a-z-]*): (G\d+ \(#\d+\)(?:, G\d+ \(#\d+\))*)$/.exec(line);
    if (!m) { findings.push(`${PROOF_FILE}: Pending line "${line}" is not "- <area>: G<n> (#<issue>), ..." or "none"`); continue; }
    const items = m[2].split(', ').map((i) => /^(G\d+) \(#(\d+)\)$/.exec(i));
    record.pending.set(m[1], { goals: items.map((i) => i[1]), issues: items.map((i) => Number(i[2])) });
  }
  return { record, findings };
}

// M5: every proven area has a break and a proof row (see docs/test.md, "Coverage").
function proofFindings({ areaMap, featureMap, pendingGoals, proof }) {
  const findings = [];
  const defined = new Set(Object.keys(areaMap.areas));
  const { breaks, record } = proof;
  const undef = (what, a) => { if (!defined.has(a)) findings.push(`${a}: ${what} names an area not defined in ${MAP_FILE}`); };

  breaks.forEach((b) => undef('a break', b.area));
  for (const a of record.rows.keys()) undef(`a ${PROOF_FILE} row`, a);
  for (const a of record.journeyOnly.keys()) undef(`a ${PROOF_FILE} Journey-only listing`, a);
  for (const a of record.pending.keys()) undef(`a ${PROOF_FILE} Pending listing`, a);

  for (const b of breaks) {
    if (!defined.has(b.area)) continue;
    const res = areaMap.areas[b.area].code.map(globToRegExp);
    if (!matches(res, b.file)) findings.push(`${b.file}: the break for ${b.area} matches no code glob of ${b.area}`);
  }
  for (const name of [...defined].sort()) {
    if (areaMap.areas[name].full || featureMap.journeyOnly.has(name) || record.pending.has(name)) continue;
    if (!breaks.some((b) => b.area === name)) findings.push(`${name}: proven area with no break in test/map-proof/breaks.json`);
    if (!record.rows.has(name)) findings.push(`${name}: proven area with no proof row in ${PROOF_FILE}`);
  }
  for (const a of [...featureMap.journeyOnly].sort()) {
    if (defined.has(a) && !record.journeyOnly.has(a)) findings.push(`${a}: journey-only area not listed under "Journey-only areas" in ${PROOF_FILE}`);
  }
  for (const [a, listing] of record.pending) {
    if (record.rows.has(a)) findings.push(`${a}: has both a proof row and a Pending line in ${PROOF_FILE}`);
    if (!defined.has(a)) continue;
    const goals = [...featureMap.goalAreas].filter(([, areas]) => areas.includes(a)).map(([g]) => g).sort();
    for (const g of goals) if (!pendingGoals.has(g)) findings.push(`${a}: listed Pending, but ${g} lists it and is not on coverage-pending.txt`);
    if (goals.join(',') !== [...listing.goals].sort().join(',')) {
      findings.push(`${a}: Pending line names ${listing.goals.join(', ') || 'no goals'}, the goals that list it are ${goals.join(', ') || 'none'}`);
    }
    const want = listing.goals.map((g) => pendingGoals.get(g));
    if (want.some((i) => i === undefined) || want.join(',') !== listing.issues.join(',')) {
      findings.push(`${a}: Pending line issues ${listing.issues.map((i) => `#${i}`).join(', ')} differ from coverage-pending.txt (${want.map((i) => (i === undefined ? 'absent' : `#${i}`)).join(', ')})`);
    }
  }
  return findings;
}

/**
 * M2, M3, M4, M5 and syntax findings, one string each. `rules` narrows which run.
 * `featureMap` may be null when `rules` is only ['M4']. `proof`
 * ({ breaks: Break[], record: ProofRecord }) is required when `rules` includes
 * 'M5'; the default rules leave M5 out when no proof is given.
 * @param {{ areaMap: {quiet: string[], areas: object}, featureMap: FeatureMap|null,
 *   trackedFiles: string[], pendingGoals: Map<string,*>|Set<string>,
 *   proof?: { breaks: Break[], record: ProofRecord } }} input
 * @param {string[]} [rules]
 * @returns {string[]}
 */
function mapFindings({ areaMap, featureMap, trackedFiles, pendingGoals, proof }, rules = proof ? RULES : RULES.filter((r) => r !== 'M5')) {
  const on = new Set(rules);
  if (on.has('M5') && !proof) throw new Error('mapFindings: rule M5 needs proof');
  const findings = [];
  const defined = new Set(Object.keys(areaMap.areas));

  if (on.has('syntax')) {
    for (const [goal, areas] of featureMap.goalAreas) {
      for (const a of areas) if (!defined.has(a)) findings.push(`${goal}: area "${a}" in the Goals table is not defined in ${MAP_FILE}`);
    }
    for (const a of featureMap.journeyOnly) {
      if (!defined.has(a)) findings.push(`Journey-only: area "${a}" is not defined in ${MAP_FILE}`);
    }
  }

  if (on.has('M2')) {
    const areasOf = specAreas(featureMap);
    for (const [spec, rows] of featureMap.specRows) {
      if (!areasOf.get(spec).some((a) => defined.has(a))) {
        findings.push(`${spec}: rows ${rows.join(', ')} resolve to no area defined in ${MAP_FILE}`);
      }
    }
    for (const f of trackedFiles) {
      if (ANY_SPEC.test(f) && !TOP_SPEC.test(f)) findings.push(`${f}: a spec outside the top level of ${SPEC_DIR}`);
    }
  }

  if (on.has('M3')) {
    const tracked = new Set(trackedFiles);
    const byArea = specsByArea(featureMap);
    for (const name of [...defined].sort()) {
      if (areaMap.areas[name].full || featureMap.journeyOnly.has(name)) continue;
      const goals = [...featureMap.goalAreas].filter(([, areas]) => areas.includes(name)).map(([g]) => g);
      if (goals.length === 0) { findings.push(`${name}: no goal lists this area`); continue; }
      if (goals.some((g) => pendingGoals.has(g))) continue;
      const present = [...(byArea.get(name) || [])].filter((s) => tracked.has(`${SPEC_DIR}/${s}`));
      if (present.length === 0) findings.push(`${name}: selects no spec; name a spec in a row of ${goals.join(', ')}, or list the area as Journey-only`);
    }
  }

  if (on.has('M4')) {
    const quiet = areaMap.quiet.map(globToRegExp);
    const areaRes = Object.values(areaMap.areas).map((a) => a.code.map(globToRegExp));
    for (const f of trackedFiles) {
      if (isAppFile(f) && matches(quiet, f) && !areaRes.some((res) => matches(res, f))) {
        findings.push(`${f}: an app file that matches quiet and no area; add it to an area in ${MAP_FILE}`);
      }
    }
  }

  if (on.has('M5')) findings.push(...proofFindings({ areaMap, featureMap, pendingGoals, proof }));
  return findings;
}

function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

// Throws with git's own message; the callers exit non-zero. A shallow clone
// fails here, which is the point.
function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`}`);
  return r.stdout;
}

const splitNul = (s) => s.split('\0').filter(Boolean);
const trackedFiles = (root) => splitNul(git(root, ['ls-files', '-z']));

function compile(areaMap, featureMap) {
  const quiet = areaMap.quiet.map(globToRegExp);
  const areas = Object.entries(areaMap.areas).map(([name, a]) => ({ name, full: a.full, res: a.code.map(globToRegExp) }));
  const byArea = specsByArea(featureMap);
  return {
    journeyOnly: featureMap.journeyOnly,
    quiet: (f) => matches(quiet, f),
    areasOf: (f) => areas.filter((a) => matches(a.res, f)).map((a) => a.name).sort(),
    isFull: (name) => areas.some((a) => a.name === name && a.full),
    specsOf: (name) => byArea.get(name) || new Set(),
  };
}

/**
 * @typedef {{ mode: 'all'|'some'|'none', why: string, areas: string[], specs: string[],
 *   unmapped: string[], narrowed: Record<string,string[]>, total: number, approved: boolean }} Selection
 * `approved` is true when `labels` holds map-narrowing-approved; `narrowed` is
 * reported either way.
 *
 * Maps are read with git at base and head (rule 3) and at mergeBase (rule 4).
 * `changed`, `specsAtHead` and `trackedAtHead` are repo-relative paths.
 */
function select({ root = ROOT, base, head, mergeBase, changed, specsAtHead, trackedAtHead, labels = [] }) {
  const cache = new Map();
  const mapsAt = (rev) => {
    if (!cache.has(rev)) {
      const areaMap = parseMap(git(root, ['show', `${rev}:${MAP_FILE}`]));
      const featureMap = parseFeatureMap(git(root, ['show', `${rev}:${FEATURES_FILE}`])).map;
      cache.set(rev, compile(areaMap, featureMap));
    }
    return cache.get(rev);
  };
  const baseMap = mapsAt(base);
  const headMap = mapsAt(head);
  const mergeMap = mapsAt(mergeBase);

  const atHead = new Set(specsAtHead);
  const specsOfAreas = (m, names) => {
    const out = new Set();
    for (const a of names) for (const s of m.specsOf(a)) if (atHead.has(`${SPEC_DIR}/${s}`)) out.add(`${SPEC_DIR}/${s}`);
    return out;
  };

  let all = null;
  const specs = new Set();
  const areas = new Set();
  const unmapped = new Set();
  for (const p of changed) {
    if (atHead.has(p)) { specs.add(p); continue; }
    if (matches(HARNESS_RES, p)) { all = all || `spec harness: ${p}`; continue; }
    // Playwright never loads the devbox harness; check 9 and the devbox run grade it.
    if (p.startsWith('devboxverify/') && !p.endsWith('.md')) continue;
    const names = [...new Set([...baseMap.areasOf(p), ...headMap.areasOf(p)])].sort();
    if (names.length === 0) {
      if (!baseMap.quiet(p) && !headMap.quiet(p)) unmapped.add(p);
      continue;
    }
    for (const a of names) {
      areas.add(a);
      if (baseMap.isFull(a) || headMap.isFull(a)) { all = all || `full area ${a}: ${p}`; continue; }
      for (const s of specsOfAreas(baseMap, [a])) specs.add(s);
      for (const s of specsOfAreas(headMap, [a])) specs.add(s);
    }
  }

  const selectedBy = (m, f) => {
    const names = m.areasOf(f);
    if (names.some((a) => m.isFull(a))) return new Set(atHead);
    return specsOfAreas(m, names);
  };
  const narrowed = {};
  for (const f of trackedAtHead) {
    const was = selectedBy(mergeMap, f);
    if (was.size === 0) continue;
    const now = selectedBy(headMap, f);
    const lost = [...was].filter((s) => !now.has(s)).sort();
    if (lost.length) narrowed[f] = lost;
  }
  for (const a of [...headMap.journeyOnly].sort()) {
    if (!mergeMap.journeyOnly.has(a)) narrowed[`area:${a}`] = ['journey-only'];
  }

  // Two listings that narrow the proof. A missing coverage-pending.txt reads as
  // empty; a merge base with no map-proof.md skips the Pending check.
  const readAt = (rev, file) => (git(root, ['ls-tree', '--name-only', rev, '--', file]).trim() ? git(root, ['show', `${rev}:${file}`]) : null);
  const pendingGoalsAt = (rev) => new Set(parsePending(readAt(rev, PENDING_FILE) || '', []).keys());
  const goalsBefore = pendingGoalsAt(mergeBase);
  for (const g of [...pendingGoalsAt(head)].sort()) {
    if (!goalsBefore.has(g)) narrowed[`pending:${g}`] = ['coverage-pending.txt'];
  }
  const proofBefore = readAt(mergeBase, PROOF_FILE);
  if (proofBefore !== null) {
    const pendingAreasAt = (md) => new Set(md === null ? [] : parseProofRecord(md).record.pending.keys());
    const before = pendingAreasAt(proofBefore);
    for (const a of [...pendingAreasAt(readAt(head, PROOF_FILE))].sort()) {
      if (!before.has(a)) narrowed[`pending-area:${a}`] = ['map-proof.md Pending'];
    }
  }

  const names = (labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  const approved = names.includes(APPROVED_LABEL);
  const total = specsAtHead.length;
  const base_ = { areas: [...areas].sort(), unmapped: [...unmapped].sort(), narrowed, total, approved };
  if (all) return { ...base_, mode: 'all', why: all, specs: [...atHead].sort() };
  const picked = [...specs].sort();
  return { ...base_, mode: picked.length ? 'some' : 'none', why: picked.length ? 'by area' : 'no spec reached', specs: picked };
}

module.exports = {
  parseFeatureMap, parseProofRecord, specAreas, mapFindings, select, git, trackedFiles, splitNul,
  SPEC_HARNESS, APPROVED_LABEL, TOP_SPEC, ROOT, RULES, PROOF_FILE,
};
