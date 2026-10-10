#!/usr/bin/env node
'use strict';

// Every feature-map row names the spec or devbox journey that proves it, and
// every spec test names the row it proves. Inputs: docs/FEATURES.md (the
// tables under "Features by goal", and "Retired IDs"), test/e2e/coverage-pending.txt,
// `playwright test --list --reporter=json` (runs no global setup) and
// test/static/frozen.json (journey ids).
//
// Usage: node scripts/check-coverage.js
// Output: one finding per line, `<ID or file>: <what>`.
// Exit: 0 clean, 1 findings, 2 parse or usage error.
// Docs: docs/test.md, "Coverage"; the Spec grammar is in docs/FEATURES.md, "How to read a row".

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ROW_ID = /^G\d+\.\d+$/;
const TAG = /^(G\d+\.\d+)(?:\.r(\d+))?$/;
const SPEC_FILE = /^[\w.-]+\.spec\.js$/;
// Columns of a row once split on unescaped pipes: '', ID, Action, Simple door,
// Power door, Screen proof, Relay proof, Refusals, Journey, Spec, ''.
const COLUMNS = 11;
const REFUSALS = 7;
const SPEC = 9;

class ParseError extends Error {}

function splitRow(line) {
  return line.split(/(?<!\\)\|/).map((c) => c.trim());
}

function section(text, heading, until) {
  const start = text.indexOf(`\n## ${heading}`);
  if (start < 0) throw new ParseError(`docs/FEATURES.md: no "## ${heading}" section`);
  const end = until ? text.indexOf(`\n## ${until}`, start + 1) : -1;
  return text.slice(start, end < 0 ? undefined : end);
}

function parseFeatures(text) {
  const rows = [];
  const body = section(text, 'Features by goal', 'Retired IDs');
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells[1] === 'ID' || /^-+$/.test(cells[1])) continue;
    if (cells.length !== COLUMNS) throw new ParseError(`docs/FEATURES.md: row "${cells[1]}" has ${cells.length - 2} cells, want ${COLUMNS - 2}`);
    const refusals = new Set([...cells[REFUSALS].matchAll(/(?:^|;\s*)r(\d+):/g)].map((m) => Number(m[1])));
    rows.push({ id: cells[1], refusals, spec: cells[SPEC] });
  }
  if (rows.length === 0) throw new ParseError('docs/FEATURES.md: no feature rows found');
  return rows;
}

function parseRetired(text) {
  const body = section(text, 'Retired IDs', 'Areas');
  return new Set([...body.matchAll(/^- (G\d+\.\d+):/gm)].map((m) => m[1]));
}

// `none yet` (with an optional reason), or `, `-separated items.
function parseSpec(cell) {
  if (/^none yet(:|$)/.test(cell)) return { none: true, files: [], journeys: [], bad: [] };
  const out = { none: false, files: [], journeys: [], bad: [] };
  for (const item of cell.split(', ')) {
    const devbox = /^devbox: (\S+)$/.exec(item);
    if (devbox) out.journeys.push(devbox[1]);
    else if (SPEC_FILE.test(item)) out.files.push(item);
    else out.bad.push(item);
  }
  return out;
}

function listTests() {
  const r = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--list', '--reporter=json'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  let report;
  try { report = JSON.parse(r.stdout); } catch (e) {
    throw new ParseError(`playwright test --list gave no JSON (exit ${r.status}): ${(r.stderr || '').trim().split('\n')[0]}`);
  }
  // With no spec at all Playwright reports "No tests found"; that is zero tests.
  const errors = (report.errors || []).filter((e) => !/No tests found/.test(e.message || ''));
  if (errors.length) throw new ParseError(`playwright test --list: ${String(errors[0].message).split('\n')[0]}`);
  const tests = [];
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      const fromTitle = [...spec.title.matchAll(/@(\S+)/g)].map((m) => m[1]);
      tests.push({ file: path.basename(spec.file), title: spec.title, tags: new Set([...(spec.tags || []).map((t) => t.replace(/^@/, '')), ...fromTitle]) });
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of report.suites || []) walk(suite);
  return tests;
}

function parsePending(text, findings) {
  const goals = new Map();
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^(G\d+) #(\d+)$/.exec(line);
    if (!m) findings.push(`coverage-pending.txt:${i + 1}: "${line}" is not "G<n> #<issue>"`);
    else if (goals.has(m[1])) findings.push(`coverage-pending.txt:${i + 1}: ${m[1]} is listed twice`);
    else goals.set(m[1], Number(m[2]));
  });
  return goals;
}

function check({ features, retired, pending, tests, journeyIds, specFiles }) {
  const findings = [];
  const goalOf = (id) => id.split('.')[0];
  const rowsById = new Map();

  // C1
  for (const row of features) {
    if (!ROW_ID.test(row.id)) findings.push(`${row.id}: not a row ID of the form G<n>.<n>`);
    else if (retired.has(row.id)) findings.push(`${row.id}: this ID is retired and cannot come back`);
    if (rowsById.has(row.id)) findings.push(`${row.id}: listed twice`);
    rowsById.set(row.id, row);
    row.items = parseSpec(row.spec);
    for (const bad of row.items.bad) findings.push(`${row.id}: Spec item "${bad}" is not none yet, <name>.spec.js or devbox: <journey>`);
  }

  const testsByFile = new Map();
  for (const t of tests) testsByFile.set(t.file, [...(testsByFile.get(t.file) || []), t]);
  const tagged = (file, tag) => (testsByFile.get(file) || []).some((t) => t.tags.has(tag));

  for (const row of features) {
    const { items } = row;
    // C2
    if (items.none && !pending.has(goalOf(row.id))) findings.push(`${row.id}: no spec`);
    // C3
    for (const file of items.files) {
      if (!specFiles.has(file)) findings.push(`${row.id}: ${file} is not a spec in test/e2e`);
      else if (![row.id, ...[...row.refusals].map((k) => `${row.id}.r${k}`)].some((tag) => tagged(file, tag))) {
        findings.push(`${row.id}: ${file} has no test tagged @${row.id}`);
      }
    }
    // C4
    for (const id of items.journeys) if (!journeyIds.has(id)) findings.push(`${row.id}: devbox journey ${id} does not exist`);
    // C6
    if (!pending.has(goalOf(row.id)) && !items.none && items.journeys.length === 0) {
      for (const k of [...row.refusals].sort((a, b) => a - b)) {
        if (!items.files.some((f) => tagged(f, `${row.id}.r${k}`))) findings.push(`${row.id}.r${k}: no test tagged @${row.id}.r${k} in a named spec`);
      }
    }
  }

  // C5
  for (const t of tests) {
    const rowTags = [...t.tags].filter((tag) => TAG.test(tag));
    if (rowTags.length === 0) { findings.push(`${t.file}: "${t.title}" names no row`); continue; }
    for (const tag of rowTags) {
      const [, id, k] = TAG.exec(tag);
      const row = rowsById.get(id);
      if (!row || retired.has(id)) findings.push(`${t.file}: "${t.title}": @${tag} names no live row`);
      else if (k !== undefined && !row.refusals.has(Number(k))) findings.push(`${t.file}: "${t.title}": @${tag} names a refusal ${id} does not have`);
      else if (!row.items.files.includes(t.file)) findings.push(`${t.file}: "${t.title}": @${tag} but ${id}'s Spec cell does not name ${t.file}`);
    }
  }

  // C7
  for (const goal of pending.keys()) {
    const rows = features.filter((r) => goalOf(r.id) === goal);
    if (rows.length === 0) findings.push(`${goal}: no rows; remove from coverage-pending.txt`);
    else if (rows.every((r) => !r.items.none)) findings.push(`${goal}: remove from coverage-pending.txt`);
  }
  return findings;
}

function main(argv, { out = console.log, err = console.error } = {}) {
  if (argv.length) { err('usage: check-coverage.js (no arguments)'); return 2; }
  let findings;
  try {
    const text = read('docs/FEATURES.md');
    const pendingFindings = [];
    const pending = parsePending(read('test/e2e/coverage-pending.txt'), pendingFindings);
    const frozen = JSON.parse(read('test/static/frozen.json'));
    const specFiles = new Set(fs.readdirSync(path.join(ROOT, 'test/e2e')).filter((f) => SPEC_FILE.test(f)));
    findings = [...pendingFindings, ...check({
      features: parseFeatures(text),
      retired: parseRetired(text),
      pending,
      tests: listTests(),
      journeyIds: new Set(frozen.journeys.map((j) => j.id)),
      specFiles,
    })];
  } catch (e) {
    err(`check-coverage: ${e instanceof ParseError ? '' : 'unexpected: '}${e.message}`);
    return 2;
  }
  for (const f of findings) out(f);
  if (findings.length === 0) out('check-coverage: ok');
  return findings.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, check, parseFeatures, parseRetired, parseSpec, parsePending, splitRow };
