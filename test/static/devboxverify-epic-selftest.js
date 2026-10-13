#!/usr/bin/env node
'use strict';

// Self-test for devboxverify's epic-head run: the main-head rule (main.js),
// the --epic flag of set.js, and the two gh lookups in post.js. Pure
// functions with an injected ghFn; no network, no real gh.

const assert = require('assert');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { mainHeadProblem } = require(path.join(EVE, 'devboxverify/main'));
const { parseArgs, planPhases } = require(path.join(EVE, 'devboxverify/set'));
const post = require(path.join(EVE, 'devboxverify/post'));

const MAIN_SHA = 'a'.repeat(40);
const EPIC_SHA = 'b'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const EPIC_BRANCH = 'epic/446-ui-bugs';

function mainHeadCases() {
  const base = { branch: 'feat/x', remoteHead: MAIN_SHA, epicBranch: EPIC_BRANCH, epicHead: EPIC_SHA };
  assert.strictEqual(mainHeadProblem({ head: MAIN_SHA, branch: 'main', remoteHead: MAIN_SHA }), null,
    'head equal to the default-branch head is accepted');
  assert.strictEqual(mainHeadProblem({ ...base, head: EPIC_SHA, mainInEpic: true }), null,
    'epic head with main merged in is accepted');
  const notMerged = mainHeadProblem({ ...base, head: EPIC_SHA, mainInEpic: false });
  assert.ok(typeof notMerged === 'string' && notMerged.includes('merge main into the epic first'),
    `epic head without main merged in says to merge main first, got ${notMerged}`);
  const stray = mainHeadProblem({ ...base, head: OTHER_SHA, mainInEpic: true });
  assert.ok(typeof stray === 'string' && stray.includes(OTHER_SHA),
    `a head matching neither names HEAD, got ${stray}`);
}

function setCases() {
  const argv = ['--eve', EPIC_BRANCH, '--epic', '446'];
  let parsed;
  assert.doesNotThrow(() => { parsed = parseArgs(argv); }, '--eve REF --epic N parses');
  assert.ok(/446/.test(JSON.stringify(parsed.epic)), `parsed epic keeps 446, got ${JSON.stringify(parsed.epic)}`);
  assert.throws(() => parseArgs(['--epic', '446']), '--epic without --eve is refused');
  assert.throws(() => parseArgs(['--eve', '12', '--epic', '446', '--post']), '--epic with --post is refused');

  const phases = planPhases({ eve: { branch: EPIC_BRANCH, checkout: '/tmp/eve-checkout' }, epic: '446' });
  const args = phases.find(p => p.repo === 'eve').args;
  const at = args.indexOf('--epic');
  assert.ok(at >= 0 && args[at + 1] === '446', `eve phase args carry --epic 446, got ${JSON.stringify(args)}`);
}

function fakeGh(handler) {
  const seen = [];
  const ghFn = async (args) => {
    seen.push(args);
    const out = handler(args);
    assert.notStrictEqual(out, undefined, `unexpected gh call: ${JSON.stringify(args)}`);
    return out;
  };
  return { ghFn, seen };
}

async function postCases() {
  const refs = names => JSON.stringify(names.map((n, i) => ({
    ref: `refs/heads/${n}`, object: { sha: String(i + 1).repeat(40) },
  })));
  const refsGh = names => fakeGh(args =>
    args[0] === 'api' && String(args[1]).includes('git/matching-refs/heads/epic/446-') ? refs(names) : undefined);
  const opts = { slug: 'acme/eve', number: 446 };

  let g = refsGh([EPIC_BRANCH]);
  assert.deepStrictEqual(await post.epicBranchHead(opts, { cwd: '.', ghFn: g.ghFn }),
    { branch: EPIC_BRANCH, head: '1'.repeat(40) }, 'one matching ref gives { branch, head }');
  g = refsGh([]);
  await assert.rejects(post.epicBranchHead(opts, { cwd: '.', ghFn: g.ghFn }), 'no epic branch throws');
  g = refsGh([EPIC_BRANCH, 'epic/446-other']);
  await assert.rejects(post.epicBranchHead(opts, { cwd: '.', ghFn: g.ghFn }), 'two epic branches throw');

  for (const [status, want] of [['ahead', true], ['identical', true], ['behind', false], ['diverged', false]]) {
    const c = fakeGh(args => {
      if (args[0] !== 'api' || !String(args[1]).includes(`compare/${MAIN_SHA}...${EPIC_SHA}`)) return undefined;
      return args.includes('-q') ? status : JSON.stringify({ status });
    });
    const got = await post.containsCommit({ slug: 'acme/eve', base: MAIN_SHA, head: EPIC_SHA }, { cwd: '.', ghFn: c.ghFn });
    assert.strictEqual(got, want, `containsCommit is ${want} for status ${status}`);
  }
}

(async () => {
  mainHeadCases();
  setCases();
  await postCases();
  console.log('ok devboxverify epic selftest');
})().catch(err => { console.error(err.stack || err.message); process.exit(1); });
