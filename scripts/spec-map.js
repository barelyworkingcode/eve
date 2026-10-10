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
const { parseFeatures, parseSpec, splitRow } = require('./check-coverage');

const ROOT = path.resolve(__dirname, '..');
const MAP_FILE = 'docs/areas.jsonc';
const FEATURES_FILE = 'docs/FEATURES.md';
const SPEC_DIR = 'test/e2e';
const TOP_SPEC = /^test\/e2e\/[\w.-]+\.spec\.js$/;
const ANY_SPEC = /\.spec\.js$/;
const AREA_NAME = /^[a-z][a-z-]*$/;
const APPROVED_LABEL = 'map-narrowing-approved';

// Fixed in code, not in the map: the map is read from the head, so a PR could
// otherwise narrow its own run.
const SPEC_HARNESS = ['test/e2e/support/**', 'test/e2e/relay-pin.json', 'playwright.config.js'];
const HARNESS_RES = SPEC_HARNESS.map(globToRegExp);

const RULES = ['M2', 'M3', 'M4', 'syntax'];

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

/**
 * M2, M3, M4 and syntax findings, one string each. `rules` narrows which run.
 * `featureMap` may be null when `rules` is only ['M4'].
 * @param {{ areaMap: {quiet: string[], areas: object}, featureMap: FeatureMap|null,
 *   trackedFiles: string[], pendingGoals: Map<string,*>|Set<string> }} input
 * @param {string[]} [rules]
 * @returns {string[]}
 */
function mapFindings({ areaMap, featureMap, trackedFiles, pendingGoals }, rules = RULES) {
  const on = new Set(rules);
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

  const names = (labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  const approved = names.includes(APPROVED_LABEL);
  const total = specsAtHead.length;
  const base_ = { areas: [...areas].sort(), unmapped: [...unmapped].sort(), narrowed, total, approved };
  if (all) return { ...base_, mode: 'all', why: all, specs: [...atHead].sort() };
  const picked = [...specs].sort();
  return { ...base_, mode: picked.length ? 'some' : 'none', why: picked.length ? 'by area' : 'no spec reached', specs: picked };
}

module.exports = {
  parseFeatureMap, specAreas, mapFindings, select, git, trackedFiles, splitNul,
  SPEC_HARNESS, APPROVED_LABEL, TOP_SPEC, ROOT,
};
