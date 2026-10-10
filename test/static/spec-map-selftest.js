#!/usr/bin/env node
'use strict';

// Self-test for spec selection (scripts/select-specs.js) and the map rules
// (scripts/spec-map.js). Fixture repos are built with git in temp dirs; the
// CLI runs as a child process. Exits 1 if any case fails; one line per case.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const EVE = path.resolve(__dirname, '..', '..');
const { parseMap } = require(path.join(EVE, 'devboxverify/areas'));
const { parseFeatureMap, mapFindings } = require(path.join(EVE, 'scripts/spec-map'));

// ---- fixture documents ----

function featuresMd({ goals, rows, journeyOnly = 'none' }) {
  const g = goals.map(([id, areas]) => `| ${id} | goal ${id} | ${areas} |`).join('\n');
  const r = rows.map(([id, spec]) => `| ${id} | act | door | door | screen | none | none | none yet | ${spec} |`).join('\n');
  return `# Features\n\n## Goals\n\n| # | Goal | Areas |\n|---|---|---|\n${g}\n\n## Features by goal\n\n### Rows\n\n` +
    `| ID | Action | Simple door | Power door | Screen proof | Relay proof | Refusals | Journey | Spec |\n|---|---|---|---|---|---|---|---|---|\n${r}\n\n` +
    `## Retired IDs\n\nnone\n\n## Areas\n\nJourney-only: ${journeyOnly}\n\n## Notes\n`;
}

const BASE_GOALS = [['G1', 'alpha'], ['G2', 'beta'], ['G3', 'gamma']];
const BASE_ROWS = [['G1.1', 'a.spec.js'], ['G2.1', 'b.spec.js'], ['G3.1', 'c.spec.js']];

function areasJsonc({ beta = ['public/beta.js', 'public/shared.js'], gamma = ['public/gamma.js'] } = {}) {
  return JSON.stringify({
    quiet: ['**/*.md', 'docs/**', 'test/static/**', '.gitignore'],
    areas: {
      core: { full: true, code: ['server.js'] },
      alpha: { code: ['public/alpha.js'] },
      beta: { code: beta },
      gamma: { code: gamma },
    },
  }, null, 2);
}

const BASE_FILES = {
  '.gitignore': 'node_modules\nscripts\ndevboxverify\n',
  'docs/areas.jsonc': areasJsonc(),
  'docs/FEATURES.md': featuresMd({ goals: BASE_GOALS, rows: BASE_ROWS }),
  'server.js': '// core\n',
  'public/alpha.js': '// alpha\n',
  'public/beta.js': '// beta\n',
  'public/shared.js': '// shared\n',
  'public/gamma.js': '// gamma\n',
  'public/orphan.js': '// in no area\n',
  'README.md': '# readme\n',
  'docs/notes.md': 'notes\n',
  'playwright.config.js': '// config\n',
  'test/e2e/a.spec.js': '// a\n',
  'test/e2e/b.spec.js': '// b\n',
  'test/e2e/c.spec.js': '// c\n',
  'test/e2e/support/fixtures.js': '// support\n',
};

// ---- fixture repo ----

const tmpDirs = [];

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-map-selftest-'));
  tmpDirs.push(dir);
  const sh = (args) => {
    const r = spawnSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  // The tooling under test runs from inside the fixture, untracked.
  for (const rel of ['scripts/spec-map.js', 'scripts/select-specs.js', 'scripts/check-coverage.js', 'devboxverify/areas.js']) {
    write(rel, fs.readFileSync(path.join(EVE, rel)));
  }
  fs.symlinkSync(path.join(EVE, 'node_modules'), path.join(dir, 'node_modules'));
  sh(['init', '-q', '-b', 'main']);
  for (const [rel, content] of Object.entries(BASE_FILES)) write(rel, content);
  sh(['add', '-A']);
  sh(['commit', '-q', '-m', 'base']);
  const repo = {
    dir, sh, write,
    commit: (msg = 'change') => { sh(['add', '-A']); sh(['commit', '-q', '-m', msg]); },
    branch: (name) => sh(['checkout', '-q', '-b', name]),
    checkout: (name) => sh(['checkout', '-q', name]),
    run(args) {
      const r = spawnSync(process.execPath, [path.join(dir, 'scripts/select-specs.js'), ...args], { cwd: dir, env: cleanEnv(), encoding: 'utf8' });
      return { status: r.status, out: r.stdout, err: r.stderr };
    },
  };
  return repo;
}

// Branch pr off main, apply `files`, commit; leaves pr checked out.
function pr(files) {
  const repo = fixture();
  repo.branch('pr');
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  repo.commit();
  return repo;
}

const runLine = (out) => (out.match(/^RUN (.*)$/m) || [])[1];

// ---- cases ----

const cases = [];
const it = (name, fn) => cases.push([name, fn]);

it('changed area file selects only that area\'s specs, and env gets the mode', () => {
  const repo = pr({ 'public/alpha.js': '// alpha 2\n' });
  const envFile = path.join(repo.dir, 'env.out');
  const r = repo.run(['--base', 'main', '--env', envFile]);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.match(r.out, /^AREAS alpha$/m);
  assert.match(r.out, /^SPECS 1\/3$/m);
  assert.strictEqual(runLine(r.out), 'test/e2e/a.spec.js');
  const env = fs.readFileSync(envFile, 'utf8');
  assert.match(env, /^SELECT_MODE=some$/m);
  assert.match(env, /^SELECT_SPECS=test\/e2e\/a\.spec\.js$/m);
});

it('an added spec and a changed spec each run themselves', () => {
  const repo = pr({ 'test/e2e/d.spec.js': '// new\n', 'test/e2e/b.spec.js': '// b 2\n' });
  const r = repo.run(['--base', 'main']);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.deepStrictEqual(runLine(r.out).split(' '), ['test/e2e/b.spec.js', 'test/e2e/d.spec.js']);
});

for (const file of ['test/e2e/support/fixtures.js', 'playwright.config.js']) {
  it(`spec-harness change (${file}) runs all`, () => {
    const repo = pr({ [file]: '// changed\n' });
    const r = repo.run(['--base', 'main']);
    assert.strictEqual(r.status, 0, r.out + r.err);
    assert.strictEqual(runLine(r.out), 'all');
    assert.match(r.out, /^SPECS 3\/3$/m);
  });
}

it('a change in a full area runs all', () => {
  const r = pr({ 'server.js': '// core 2\n' }).run(['--base', 'main']);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.strictEqual(runLine(r.out), 'all');
});

it('an unmapped non-quiet path exits 1 with UNMAPPED and prints no RUN', () => {
  const r = pr({ 'public/orphan.js': '// changed\n', 'public/alpha.js': '// alpha 2\n' }).run(['--base', 'main']);
  assert.strictEqual(r.status, 1, r.out + r.err);
  assert.match(r.out, /^UNMAPPED public\/orphan\.js$/m);
  assert.strictEqual(runLine(r.out), undefined);
});

it('a change to quiet paths only runs no spec', () => {
  const repo = pr({ 'README.md': '# readme 2\n', 'docs/notes.md': 'notes 2\n' });
  const envFile = path.join(repo.dir, 'env.out');
  const r = repo.run(['--base', 'main', '--env', envFile]);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.strictEqual(runLine(r.out), 'none');
  assert.match(r.out, /^SPECS 0\/3$/m);
  assert.match(fs.readFileSync(envFile, 'utf8'), /^SELECT_MODE=none$/m);
});

it('selection unions the base map and the head map (a path moved between areas)', () => {
  const repo = pr({
    'docs/areas.jsonc': areasJsonc({ beta: ['public/beta.js'], gamma: ['public/gamma.js', 'public/shared.js'] }),
    'public/shared.js': '// shared 2\n',
  });
  const r = repo.run(['--base', 'main', '--labels-json', '["map-narrowing-approved"]']);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.match(r.out, /^AREAS beta,gamma$/m);
  assert.deepStrictEqual(runLine(r.out).split(' '), ['test/e2e/b.spec.js', 'test/e2e/c.spec.js']);
});

it('a map change that drops a spec from a file exits 1 with NARROWED', () => {
  const r = pr({ 'docs/FEATURES.md': featuresMd({ goals: [['G1', 'alpha'], ['G2', 'gamma'], ['G3', 'gamma']], rows: BASE_ROWS }) })
    .run(['--base', 'main']);
  assert.strictEqual(r.status, 1, r.out + r.err);
  assert.match(r.out, /^NARROWED public\/beta\.js test\/e2e\/b\.spec\.js$/m);
  assert.strictEqual(runLine(r.out), undefined);
});

it('the map-narrowing-approved label lets a narrowing pass', () => {
  const repo = pr({ 'docs/FEATURES.md': featuresMd({ goals: [['G1', 'alpha'], ['G2', 'gamma'], ['G3', 'gamma']], rows: BASE_ROWS }) });
  const r = repo.run(['--base', 'main', '--labels-json', '[{"name":"map-narrowing-approved"}]']);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.strictEqual(runLine(r.out), 'none');
});

it('another label does not approve a narrowing', () => {
  const repo = pr({ 'docs/FEATURES.md': featuresMd({ goals: [['G1', 'alpha'], ['G2', 'gamma'], ['G3', 'gamma']], rows: BASE_ROWS }) });
  assert.strictEqual(repo.run(['--base', 'main', '--labels-json', '["bug"]']).status, 1);
});

it('adding an area to Journey-only narrows and exits 1 with NARROWED', () => {
  const r = pr({ 'docs/FEATURES.md': featuresMd({ goals: BASE_GOALS, rows: BASE_ROWS, journeyOnly: 'alpha' }) }).run(['--base', 'main']);
  assert.strictEqual(r.status, 1, r.out + r.err);
  assert.match(r.out, /^NARROWED .*alpha/m);
});

it('narrowing is read at the merge base: a map that widened on main is not a false NARROWED', () => {
  const repo = pr({ 'public/alpha.js': '// alpha 2\n' });
  repo.checkout('main');
  repo.write('docs/FEATURES.md', featuresMd({ goals: BASE_GOALS, rows: [['G1.1', 'a.spec.js, c.spec.js'], ['G2.1', 'b.spec.js'], ['G3.1', 'c.spec.js']] }));
  repo.commit('main widens alpha');
  repo.checkout('pr');
  const r = repo.run(['--base', 'main']);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.doesNotMatch(r.out, /NARROWED/);
});

for (const [label, args] of [
  ['a bad base rev', ['--base', 'no-such-rev']],
  ['a bad head rev', ['--base', 'main', '--head', 'no-such-rev']],
  ['no arguments', []],
  ['--full with --base', ['--full', '--base', 'main']],
]) {
  it(`${label} exits 2 and never prints RUN all`, () => {
    const repo = pr({ 'public/alpha.js': '// alpha 2\n' });
    const envFile = path.join(repo.dir, 'env.out');
    const r = repo.run([...args, '--env', envFile]);
    assert.strictEqual(r.status, 2, r.out + r.err);
    assert.doesNotMatch(r.out, /^RUN /m);
    assert.ok(!fs.existsSync(envFile) || !/SELECT_MODE=all/.test(fs.readFileSync(envFile, 'utf8')), 'env must not select all');
  });
}

it('--full prints RUN all and sets mode all', () => {
  const repo = fixture();
  const envFile = path.join(repo.dir, 'env.out');
  const r = repo.run(['--full', '--env', envFile]);
  assert.strictEqual(r.status, 0, r.out + r.err);
  assert.strictEqual(runLine(r.out), 'all');
  assert.match(r.out, /^SPECS 3\/3$/m);
  assert.match(fs.readFileSync(envFile, 'utf8'), /^SELECT_MODE=all$/m);
});

it('the summary lists the areas, the specs run and the count not run', () => {
  const repo = pr({ 'public/alpha.js': '// alpha 2\n' });
  const summary = path.join(repo.dir, 'summary.md');
  const r = repo.run(['--base', 'main', '--summary', summary]);
  assert.strictEqual(r.status, 0, r.out + r.err);
  const text = fs.readFileSync(summary, 'utf8');
  assert.match(text, /alpha/);
  assert.match(text, /test\/e2e\/a\.spec\.js/);
  assert.doesNotMatch(text, /b\.spec\.js/);
  assert.match(text, /2[^\n]*not run|not run[^\n]*2/i);
});

// ---- map rules, in process ----

const AREA_MAP = (extra = {}, quiet = ['**/*.md']) => parseMap(JSON.stringify({
  quiet,
  areas: { alpha: { code: ['public/ok.js'] }, ...extra },
}));
const findingsFor = ({ areaMap, md, tracked, pending = new Set() }) => {
  const fm = parseFeatureMap(md);
  return [...fm.findings, ...mapFindings({ areaMap, featureMap: fm.map, trackedFiles: tracked, pendingGoals: pending })];
};
const mentions = (findings, s) => findings.some((f) => f.includes(s));

it('M2 flags a spec whose rows resolve to no area, and a spec outside top-level test/e2e', () => {
  const md = featuresMd({ goals: [['G1', 'alpha']], rows: [['G1.1', 'a.spec.js'], ['G9.1', 'z.spec.js']] });
  const f = findingsFor({ areaMap: AREA_MAP(), md, tracked: ['test/e2e/a.spec.js', 'test/e2e/z.spec.js', 'test/e2e/sub/x.spec.js', 'tests/y.spec.js'] });
  assert.ok(mentions(f, 'z.spec.js'), f.join('\n'));
  assert.ok(mentions(f, 'test/e2e/sub/x.spec.js'), f.join('\n'));
  assert.ok(mentions(f, 'tests/y.spec.js'), f.join('\n'));
  assert.ok(!mentions(f, 'a.spec.js'), f.join('\n'));
});

it('M3 flags an area that selects no spec, and not pending, full or journey-only areas', () => {
  const areaMap = AREA_MAP({
    delta: { code: ['public/delta.js'] },
    pendingone: { code: ['public/pending.js'] },
    fullone: { full: true, code: ['public/full.js'] },
    joone: { code: ['public/jo.js'] },
    orphanarea: { code: ['public/orphan.js'] },
  });
  const md = featuresMd({
    goals: [['G1', 'alpha'], ['G2', 'delta'], ['G3', 'pendingone'], ['G4', 'fullone'], ['G5', 'joone']],
    rows: [['G1.1', 'a.spec.js']],
    journeyOnly: 'joone',
  });
  const f = findingsFor({ areaMap, md, tracked: ['test/e2e/a.spec.js'], pending: new Set(['G3']) });
  assert.ok(mentions(f, 'delta'), f.join('\n'));
  assert.ok(mentions(f, 'orphanarea'), f.join('\n'));
  for (const ok of ['alpha', 'pendingone', 'fullone', 'joone']) assert.ok(!mentions(f, ok), `${ok} flagged: ${f.join('\n')}`);
});

it('M4 flags an app file that matches quiet and no area, and exempts mapped files, *.md and *.config.js', () => {
  const areaMap = AREA_MAP({}, ['**/*.md', 'public/q.js', 'top.js', 'jest.config.js']);
  const md = featuresMd({ goals: [['G1', 'alpha']], rows: [['G1.1', 'a.spec.js']] });
  const f = findingsFor({
    areaMap, md,
    tracked: ['test/e2e/a.spec.js', 'public/q.js', 'top.js', 'public/ok.js', 'public/readme.md', 'jest.config.js'],
  });
  assert.ok(mentions(f, 'public/q.js'), f.join('\n'));
  assert.ok(mentions(f, 'top.js'), f.join('\n'));
  for (const ok of ['public/ok.js', 'readme.md', 'jest.config.js']) assert.ok(!mentions(f, ok), `${ok} flagged: ${f.join('\n')}`);
});

it('an area in the Goals table that areas.jsonc does not define is flagged', () => {
  const md = featuresMd({ goals: [['G1', 'alpha, ghost']], rows: [['G1.1', 'a.spec.js']] });
  const f = findingsFor({ areaMap: AREA_MAP(), md, tracked: ['test/e2e/a.spec.js'] });
  assert.ok(mentions(f, 'ghost'), f.join('\n'));
});

it('a Journey-only line that is missing or names an undefined area is flagged', () => {
  const base = { goals: [['G1', 'alpha']], rows: [['G1.1', 'a.spec.js']] };
  const missing = findingsFor({ areaMap: AREA_MAP(), md: featuresMd(base).replace(/Journey-only: none\n/, ''), tracked: ['test/e2e/a.spec.js'] });
  assert.ok(mentions(missing, 'Journey-only'), missing.join('\n'));
  const undef = findingsFor({ areaMap: AREA_MAP(), md: featuresMd({ ...base, journeyOnly: 'nowhere' }), tracked: ['test/e2e/a.spec.js'] });
  assert.ok(mentions(undef, 'nowhere'), undef.join('\n'));
});

// ---- run ----

let failed = 0;
try {
  for (const [name, fn] of cases) {
    try {
      fn();
      console.log(`ok - ${name}`);
    } catch (e) {
      failed++;
      console.log(`not ok - ${name}: ${String(e.message).split('\n').slice(0, 6).join(' | ')}`);
    }
  }
} finally {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failed ? `spec-map-selftest: ${failed} of ${cases.length} failed` : `spec-map-selftest: ok (${cases.length} cases)`);
process.exitCode = failed ? 1 : 0;
