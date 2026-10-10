#!/usr/bin/env node
'use strict';

// Lists the e2e specs a pull request adds or changes, one path per line, for
// the CI burn-in (`--repeat-each=5 --retries=0`). Specs only: top-level
// test/e2e/*.spec.js, the config's testMatch. A changed file in
// test/e2e/support/ or playwright.config.js lists none; main's e2e job covers
// it. Specs the config's testIgnore drops are dropped here too.
//
// Usage: node scripts/burn-in-specs.js <base> <head>
// Exit: 0 (empty output when nothing matches), 2 usage, git or config failure.

const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SPEC_DIR = 'test/e2e';
// playwright.config.js testMatch is '*.spec.js' under test/e2e, so top level only.
const SPEC_FILE = /^test\/e2e\/[^/]+\.spec\.js$/;

function matchesIgnore(pattern, relPath, root) {
  if (pattern instanceof RegExp) {
    // Playwright tests ignore patterns against the absolute path.
    pattern.lastIndex = 0;
    return pattern.test(path.join(root, relPath).split(path.sep).join('/'));
  }
  throw Object.assign(new Error('unsupported testIgnore shape; expected a RegExp or an array of RegExp'), { code: 'EIGNORE' });
}

function burnInSpecs(paths, testIgnore, root) {
  const ignores = testIgnore === undefined ? [] : Array.isArray(testIgnore) ? testIgnore : [testIgnore];
  return paths.filter((p) =>
    SPEC_FILE.test(p) &&
    !ignores.some((pat) => matchesIgnore(pat, p, root)));
}

async function main(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  if (argv.length !== 2 || !argv[0] || !argv[1]) {
    err('usage: burn-in-specs.js <base> <head>');
    return 2;
  }
  const [base, head] = argv;
  let stdout;
  try {
    ({ stdout } = await execFileAsync('git', [
      'diff', '--name-only', '-z', '--no-renames', '--diff-filter=AM',
      `${base}...${head}`, '--', SPEC_DIR,
    ], { cwd, maxBuffer: 64 * 1024 * 1024 }));
  } catch (e) {
    err(`git diff ${base}...${head} failed: ${e.stderr || e.message}`);
    return 2;
  }
  let specs;
  try {
    const config = require(path.join(cwd, 'playwright.config.js'));
    specs = burnInSpecs(stdout.split('\0').filter(Boolean), config.testIgnore, cwd);
  } catch (e) {
    err(`burn-in-specs: ${e.message}`);
    return 2;
  }
  for (const s of specs) out(s);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { burnInSpecs, main };
