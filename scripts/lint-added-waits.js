#!/usr/bin/env node
'use strict';

// CI gate: fail a pull request that adds a fixed wait (`waitForTimeout`) to an
// e2e spec. Waits already on the base are left alone: a finding counts only
// when its line span touches a line the diff adds. A moved or reindented line
// is an added line; a pure rename adds none. There is no bypass.
//
// Usage: node scripts/lint-added-waits.js <base> <head>
// Exit: 0 clean, 1 findings, 2 usage, git or ESLint failure.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SPEC_DIR = 'test/e2e';
// Playwright's default testMatch runs these extensions; only JavaScript is linted.
const LINTED = /\.(js|mjs|cjs)$/;
const UNSUPPORTED = /\.(ts|mts|cts|tsx|jsx)$/;
const WAIT_RULES = new Set(['playwright/no-wait-for-timeout', 'no-restricted-properties']);

function unquote(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    try { return JSON.parse(p); } catch { return p.slice(1, -1); }
  }
  return p;
}

// Parses `git diff --unified=0` output into the added line numbers per new path.
function addedLines(diffText) {
  const added = new Map();
  let file = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      // git ends the header with a TAB when the path contains a space.
      const target = unquote(line.slice(4).replace(/\t$/, ''));
      file = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('diff --git ')) { file = null; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (!added.has(file)) added.set(file, new Set());
    for (let n = start; n < start + count; n++) added.get(file).add(n);
  }
  return added;
}

// Returns [{file, line, message}] for every fatal message and every wait
// message whose line span touches an added line.
function findingsOnAddedLines(results, added, cwd) {
  const findings = [];
  // Both wait rules fire on a plugin-named call; one annotation per line.
  const seen = new Set();
  const push = (f) => {
    const key = `${f.file}:${f.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  for (const result of results) {
    const rel = path.relative(cwd, result.filePath).split(path.sep).join('/');
    const lines = added.get(rel) || new Set();
    for (const m of result.messages) {
      const line = m.line || 1;
      if (m.fatal) {
        push({ file: rel, line, message: m.message });
        continue;
      }
      if (!WAIT_RULES.has(m.ruleId)) continue;
      const end = m.endLine || line;
      let touches = false;
      for (let n = line; n <= end && !touches; n++) touches = lines.has(n);
      if (touches) push({ file: rel, line, message: m.message });
    }
  }
  return findings;
}

function annotation(f) {
  const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return `::error file=${prop(f.file)},line=${f.line}::${esc(f.message)}`;
}

async function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  if (argv.length !== 2 || !argv[0] || !argv[1]) {
    err('usage: lint-added-waits.js <base> <head>');
    return 2;
  }
  const [base, head] = argv;
  let diffText;
  try {
    ({ stdout: diffText } = await execFileAsync('git', [
      '-c', 'core.quotepath=false', 'diff', '--unified=0', '--find-renames',
      `${base}...${head}`, '--', SPEC_DIR,
    ], { cwd, maxBuffer: 256 * 1024 * 1024 }));
  } catch (e) {
    err(`git diff ${base}...${head} failed: ${e.stderr || e.message}`);
    return 2;
  }
  const added = addedLines(diffText);
  const changed = [...added.keys()].filter((f) => f.startsWith(`${SPEC_DIR}/`));
  const unsupported = changed.filter((f) => UNSUPPORTED.test(f));
  if (unsupported.length) {
    err(`TypeScript e2e files are not linted; add a parser before adding one: ${unsupported.join(', ')}`);
    return 2;
  }
  const files = changed.filter((f) => LINTED.test(f));
  // Fail closed: a file the diff changed must be on disk at head, or its waits go unseen.
  const missing = files.filter((f) => !fs.existsSync(path.join(cwd, f)));
  if (missing.length) {
    err(`lint-added-waits: ${missing.join(', ')} changed in ${base}...${head} but is not in the working tree; check out ${head} first`);
    return 2;
  }
  if (files.length === 0) return 0;

  let results;
  try {
    const { ESLint } = require('eslint');
    const eslint = new ESLint({ cwd, overrideConfigFile: path.join(__dirname, '..', 'eslint.config.js'), warnIgnored: false });
    results = await eslint.lintFiles(files);
  } catch (e) {
    err(`eslint failed: ${e.message}`);
    return 2;
  }
  const findings = findingsOnAddedLines(results, added, cwd);
  for (const f of findings) {
    out(annotation(f));
  }
  return findings.length ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { addedLines, findingsOnAddedLines, main };
