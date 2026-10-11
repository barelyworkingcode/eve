#!/usr/bin/env node
'use strict';

// Self-test for the map proof: the M5 coverage-check findings and the proof
// record parser (scripts/spec-map.js), and applyBreak (scripts/map-proof.js).
// All in process, no git. Exits 1 if any case fails; one line per case.

const assert = require('assert');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { parseMap } = require(path.join(EVE, 'devboxverify/areas'));
const specMap = require(path.join(EVE, 'scripts/spec-map'));
const { parseFeatureMap, mapFindings, parseProofRecord } = specMap;

// ---- fixture inputs ----
// Areas: core (full), alpha (proven), beta (pending), joa (journey-only).

const AREA_MAP = (extra = {}) => parseMap(JSON.stringify({
  quiet: ['**/*.md'],
  areas: {
    core: { full: true, code: ['server.js'] },
    alpha: { code: ['public/alpha.js'] },
    beta: { code: ['public/beta.js'] },
    joa: { code: ['public/joa.js'] },
    ...extra,
  },
}));

function featuresMd({ goals, rows, journeyOnly }) {
  const g = goals.map(([id, areas]) => `| ${id} | goal ${id} | ${areas} |`).join('\n');
  const r = rows.map(([id, spec]) => `| ${id} | act | door | door | screen | none | none | none yet | ${spec} |`).join('\n');
  return `# Features\n\n## Goals\n\n| # | Goal | Areas |\n|---|---|---|\n${g}\n\n## Features by goal\n\n### Rows\n\n` +
    `| ID | Action | Simple door | Power door | Screen proof | Relay proof | Refusals | Journey | Spec |\n|---|---|---|---|---|---|---|---|---|\n${r}\n\n` +
    `## Retired IDs\n\nnone\n\n## Areas\n\nJourney-only: ${journeyOnly}\n\n## Notes\n`;
}

const proofRow = (file, over = {}) => ({
  file, why: 'the break', base: 'a'.repeat(40), red: ['a.spec.js G1.1'], date: '2026-10-11', ...over,
});

// A consistent world: every M5 rule is satisfied. `over` replaces parts of it.
function world(over = {}) {
  const goals = over.goals || [['G1', 'alpha'], ['G2', 'beta'], ['G3', 'joa']];
  const md = featuresMd({
    goals,
    rows: [['G1.1', 'a.spec.js'], ['G2.1', 'none yet'], ['G3.1', 'c.spec.js']],
    journeyOnly: 'joa',
  });
  const fm = parseFeatureMap(md);
  assert.deepStrictEqual(fm.findings, [], 'fixture feature map must parse clean');
  const input = {
    areaMap: over.areaMap || AREA_MAP(),
    featureMap: fm.map,
    trackedFiles: ['test/e2e/a.spec.js', 'test/e2e/c.spec.js'],
    pendingGoals: over.pendingGoals || new Map([['G2', 5]]),
    proof: {
      breaks: over.breaks || [{ area: 'alpha', file: 'public/alpha.js', find: 'x', replace: 'y', why: 'w' }],
      record: {
        rows: over.rows || new Map([['alpha', proofRow('public/alpha.js')]]),
        journeyOnly: over.recordJourneyOnly || new Map([['joa', 'reason']]),
        pending: over.pending || new Map([['beta', { goals: ['G2'], issues: [5] }]]),
      },
    },
  };
  return input;
}

const m5 = (input) => mapFindings(input, ['M5']);
const mentions = (findings, s) => findings.some((f) => f.includes(s));
// Every finding is about `name`: the case fails for its own reason, not another guard's.
const onlyAbout = (findings, name) => {
  assert.ok(findings.length > 0, `no finding for ${name}`);
  for (const f of findings) assert.ok(f.includes(name), `unrelated finding: ${f}\nall: ${findings.join('\n')}`);
};

// ---- cases ----

const cases = [];
const it = (name, fn) => cases.push([name, fn]);

it('M5 reports nothing for a consistent proof', () => {
  assert.deepStrictEqual(m5(world()), []);
});

it('M5 names a proven area that has no break', () => {
  onlyAbout(m5(world({ breaks: [] })), 'alpha');
});

it('M5 names a proven area that has no proof row', () => {
  onlyAbout(m5(world({ rows: new Map() })), 'alpha');
});

it('M5 names a break whose file matches no code glob of its area', () => {
  const f = m5(world({ breaks: [{ area: 'alpha', file: 'public/elsewhere.js', find: 'x', replace: 'y', why: 'w' }] }));
  onlyAbout(f, 'alpha');
  assert.ok(mentions(f, 'public/elsewhere.js'), f.join('\n'));
});

it('M5 names a proof row whose file differs from the break file of its area', () => {
  const f = m5(world({ rows: new Map([['alpha', proofRow('public/other.js')]]) }));
  onlyAbout(f, 'alpha');
  assert.ok(mentions(f, 'public/other.js'), f.join('\n'));
});

it('M5 names a journey-only area that the record does not list', () => {
  onlyAbout(m5(world({ recordJourneyOnly: new Map() })), 'joa');
});

it('M5 names a Pending area that a goal off coverage-pending.txt lists', () => {
  // G4 lists beta but is not pending; the Pending line is otherwise exact for G2 + G4.
  const f = m5(world({
    goals: [['G1', 'alpha'], ['G2', 'beta'], ['G3', 'joa'], ['G4', 'beta']],
    pending: new Map([['beta', { goals: ['G2', 'G4'], issues: [5] }]]),
  }));
  assert.ok(mentions(f, 'beta') && mentions(f, 'G4'), f.join('\n'));
});

it('M5 names a Pending line whose goal ids differ from the goals that list its area', () => {
  // G4 lists beta and is pending, but the Pending line names G2 only.
  const f = m5(world({
    goals: [['G1', 'alpha'], ['G2', 'beta'], ['G3', 'joa'], ['G4', 'beta']],
    pendingGoals: new Map([['G2', 5], ['G4', 5]]),
    pending: new Map([['beta', { goals: ['G2'], issues: [5] }]]),
  }));
  assert.ok(mentions(f, 'beta') && mentions(f, 'G4'), f.join('\n'));
});

it('M5 names a Pending line whose issues differ from coverage-pending.txt', () => {
  const f = m5(world({ pending: new Map([['beta', { goals: ['G2'], issues: [7] }]]) }));
  assert.ok(mentions(f, 'beta'), f.join('\n'));
});

it('M5 names an area that has both a proof row and a Pending line', () => {
  const f = m5(world({
    rows: new Map([['alpha', proofRow('public/alpha.js')], ['beta', proofRow('public/beta.js')]]),
    breaks: [
      { area: 'alpha', file: 'public/alpha.js', find: 'x', replace: 'y', why: 'w' },
      { area: 'beta', file: 'public/beta.js', find: 'x', replace: 'y', why: 'w' },
    ],
  }));
  assert.ok(mentions(f, 'beta'), f.join('\n'));
  assert.ok(!mentions(f, 'alpha'), `alpha flagged: ${f.join('\n')}`);
});

for (const [what, over] of [
  ['break', { breaks: [{ area: 'alpha', file: 'public/alpha.js', find: 'x', replace: 'y', why: 'w' },
    { area: 'ghost', file: 'public/ghost.js', find: 'x', replace: 'y', why: 'w' }] }],
  ['proof row', { rows: new Map([['alpha', proofRow('public/alpha.js')], ['ghost', proofRow('public/ghost.js')]]) }],
  ['Pending listing', { pending: new Map([['beta', { goals: ['G2'], issues: [5] }], ['ghost', { goals: ['G2'], issues: [5] }]]) }],
  ['journey-only listing', { recordJourneyOnly: new Map([['joa', 'reason'], ['ghost', 'reason']]) }],
]) {
  it(`M5 names a ${what} that names an undefined area`, () => {
    const f = m5(world(over));
    assert.ok(mentions(f, 'ghost'), f.join('\n'));
  });
}

// ---- parseProofRecord ----

const RECORD_MD = [
  '# Map proof', '',
  '| Area | File | Break | Base | Red tests | Date |',
  '|---|---|---|---|---|---|',
  `| auth | \`passkey-sync.js\` | revoked passkey can sign in | ${'b'.repeat(40)} | g16-add-browser.spec.js G16.7; g1-signin.spec.js G1.2.r1 | 2026-10-11 |`,
  '', '## Journey-only areas', 'none', '', '## Pending', '- ui-control: G8 (#369)', '',
].join('\n');

it('parseProofRecord reads a row, an empty journey-only list and a Pending line', () => {
  const { record, findings } = parseProofRecord(RECORD_MD);
  assert.deepStrictEqual(findings, []);
  assert.deepStrictEqual([...record.rows.keys()], ['auth']);
  const row = record.rows.get('auth');
  assert.strictEqual(row.file, 'passkey-sync.js');
  assert.strictEqual(row.why, 'revoked passkey can sign in');
  assert.strictEqual(row.base, 'b'.repeat(40));
  assert.strictEqual(row.date, '2026-10-11');
  assert.strictEqual(row.red.length, 2);
  assert.ok(row.red[0].includes('G16.7') && row.red[1].includes('G1.2.r1'), row.red.join('|'));
  assert.strictEqual(record.journeyOnly.size, 0);
  assert.deepStrictEqual([...record.pending], [['ui-control', { goals: ['G8'], issues: [369] }]]);
});

it('parseProofRecord reads a journey-only area with its reason', () => {
  const md = RECORD_MD.replace('## Journey-only areas\nnone', '## Journey-only areas\n- joa: no request path a spec can reach');
  const { record, findings } = parseProofRecord(md);
  assert.deepStrictEqual(findings, []);
  assert.deepStrictEqual([...record.journeyOnly.keys()], ['joa']);
  assert.ok(record.journeyOnly.get('joa').includes('no request path'), String(record.journeyOnly.get('joa')));
});

for (const [what, from, to] of [
  ['a Pending line that is not "- area: goals (#issues)"', '- ui-control: G8 (#369)', '- ui-control G8 369'],
  ['a proof row with missing cells', /^\| auth .*$/m, '| auth | `passkey-sync.js` |'],
]) {
  it(`parseProofRecord reports ${what}`, () => {
    const { findings } = parseProofRecord(RECORD_MD.replace(from, to));
    assert.ok(findings.length > 0, 'no finding');
  });
}

// ---- applyBreak ----

const brk = (find, replace = 'REPLACED') => ({ area: 'alpha', file: 'public/alpha.js', find, replace, why: 'w' });
const loadApplyBreak = () => {
  const { applyBreak } = require(path.join(EVE, 'scripts/map-proof'));
  assert.strictEqual(typeof applyBreak, 'function', 'scripts/map-proof.js must export applyBreak');
  return applyBreak;
};

it('applyBreak refuses a find text that occurs zero times', () => {
  const applyBreak = loadApplyBreak();
  assert.throws(() => applyBreak('one two three\n', brk('four')));
});

it('applyBreak refuses a find text that occurs twice', () => {
  const applyBreak = loadApplyBreak();
  assert.throws(() => applyBreak('x = 1;\nx = 1;\n', brk('x = 1;')));
});

it('applyBreak replaces a find text that occurs exactly once and touches nothing else', () => {
  const applyBreak = loadApplyBreak();
  assert.strictEqual(applyBreak('a\nif (ok) return $1;\nb\n', brk('if (ok) return $1;', 'return $&;')), 'a\nreturn $&;\nb\n');
});

it('loadBreaks refuses a why containing a pipe', () => {
  const { loadBreaks } = require(path.join(EVE, 'scripts/map-proof'));
  const one = (why) => JSON.stringify([{ area: 'alpha', file: 'public/alpha.js', find: 'x', replace: 'y', why }]);
  assert.strictEqual(loadBreaks(one('plain')).length, 1);
  assert.throws(() => loadBreaks(one('a | b')), /"\|"/);
});

// ---- run ----

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}: ${String(e.message).split('\n').slice(0, 6).join(' | ')}`);
  }
}
console.log(failed ? `map-proof-selftest: ${failed} of ${cases.length} failed` : `map-proof-selftest: ok (${cases.length} cases)`);
process.exitCode = failed ? 1 : 0;
