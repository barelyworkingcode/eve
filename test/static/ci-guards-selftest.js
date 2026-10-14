#!/usr/bin/env node
'use strict';

// Self-test for the tests-only guard in scripts/ci-guards.sh. Each case builds
// a throwaway git repo, commits the changed paths on top of a base commit and
// runs the real script over that range. Exits 1 if any case fails.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'ci-guards.sh');

// Git hooks export GIT_DIR and friends; left in place they would point the
// throwaway repo's commands at the real repository.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// Runs the guards over a PR that changes `paths`; returns { status, out }.
function runGuards(paths, labels = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-guards-'));
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 'guard@example.invalid');
    git(dir, 'config', 'user.name', 'guard');
    fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    const base = git(dir, 'rev-parse', 'HEAD');
    for (const p of paths) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), `{"changed":"${p}"}\n`);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'head');
    const head = git(dir, 'rev-parse', 'HEAD');
    const r = spawnSync('bash', [SCRIPT, base, head], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...cleanEnv(), PR_LABELS: JSON.stringify(labels), HYGIENE_PATTERNS: '' },
    });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PIN = 'test/e2e/relay-pin.json';
const SPEC = 'test/e2e/g2-composer.spec.js';

const cases = [
  ['a pin-only PR passes the tests-only guard without the label', () => {
    const r = runGuards([PIN]);
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /tests-only: ok/);
  }],
  ['a spec-only PR fails the tests-only guard without the label', () => {
    const r = runGuards([SPEC]);
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /tests-only: the PR changes 1 test file/);
  }],
  ['a spec-only PR passes with the tests-only label', () => {
    const r = runGuards([SPEC], ['tests-only']);
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /allowed by the tests-only label/);
  }],
  ['a pin plus a spec passes', () => {
    const r = runGuards([PIN, SPEC]);
    assert.strictEqual(r.status, 0, r.out);
    assert.match(r.out, /tests-only: ok/);
  }],
  ['a pin-like file elsewhere under test/ still counts as a test', () => {
    const r = runGuards(['test/e2e/other-pin.json']);
    assert.strictEqual(r.status, 1, r.out);
  }],
];

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n${String(e.message).split('\n').map((l) => `     ${l}`).join('\n')}`);
  }
}
process.exit(failed ? 1 : 0);
