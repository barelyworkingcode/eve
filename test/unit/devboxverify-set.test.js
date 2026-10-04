// The relay + eve set runner, driven through its exported entry points with
// fake deps: no real git, gh, relay, Terminal or lock.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs, planPhases, runSet, runPhases } = require('../../devboxverify/set');
const setStatus = require('../../devboxverify/set-status');

const SET_JS = path.resolve(__dirname, '..', '..', 'devboxverify', 'set.js');
const USAGE = 'usage: node devboxverify/set.js [--relay REF] [--eve REF] [--post]';
const RELAY = '/w/relay';
const EVE = '/w/eve-verify';
const SHA = { relayMain: '1'.repeat(40), relayRef: '2'.repeat(40), eveMain: '3'.repeat(40), eveRef: '4'.repeat(40), tool: '5'.repeat(40) };
const WT = path.join(os.tmpdir(), `devboxverify-set-relay-${SHA.relayRef.slice(0, 12)}`);
const at = (h, m) => new Date(2026, 9, 3, h, m).getTime();
const GREEN_OUT = 'JOURNEY\tj1\tPASS\t\nJOURNEY\tj2\tNOTRUN\tomitted\nSUMMARY\tpass=1\tfail=0\tblocked=0\tnotrun=1\n';

let logDir;
beforeEach(() => { logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-test-')); });
afterEach(() => fs.rmSync(logDir, { recursive: true, force: true }));

// A small model of the two checkouts: HEAD per checkout, a lockfile blob per commit.
function world({ phases = {}, build = 0, done = true, dirty = false, branch = 'main', lockBlobChanges = false,
  ghHead = {}, now = at(12, 0), post = async () => ({ relay: 'https://github.com/acme/relay/pull/7#c', eve: 'https://github.com/acme/eve/pull/12#c' }),
  consoleOwner = 'tester', realPost = false } = {}) {
  const calls = [];
  const out = [];
  const log = [];
  const posted = [];
  const head = { [RELAY]: SHA.relayMain, [EVE]: SHA.eveMain };
  const fetched = {};
  const main = (cwd) => (cwd === EVE ? SHA.eveMain : SHA.relayMain);
  const ref = (cwd) => (cwd === EVE ? SHA.eveRef : SHA.relayRef);
  const tag = (cwd) => ({ [RELAY]: 'relay', [EVE]: 'eve', [WT]: 'wt' }[cwd] || 'tool');
  const resolve = (cwd, rev) => (rev === 'HEAD' ? head[cwd] : /^(origin\/)?main$/.test(rev) ? main(cwd) : rev);
  const blob = (sha) => (lockBlobChanges && sha === SHA.eveRef ? 'blob-new' : 'blob-old');
  const ok = (stdout = '', code = 0) => ({ code, stdout, stderr: '', timedOut: false });
  const env = {
    PATH: '/usr/bin:/bin', HOME: '/home/tester', NIGHTLY_RELAY_CHECKOUT: RELAY, NIGHTLY_EVE_CHECKOUT: EVE,
    NIGHTLY_LOG_DIR: logDir, RELAY_BIN: '/opt/relay/bin/relay', EVE_VERIFY_MODEL: 'm1', GH_TOKEN: 'not-for-disk',
  };
  const w = { calls, out, log, posted, env, runDir: null };
  w.deps = {
    async run(cmd, args, { cwd }) {
      calls.push(`${tag(cwd)}: ${path.basename(cmd)} ${args.join(' ')}`);
      if (path.basename(cmd) === 'build.sh') return ok('', cwd === WT ? build : 0);
      if (cmd !== 'git') return ok(args.join(' ') === 'service list' ? 'eve-verify    eve verify    node server.js    http://localhost:3100    no    frontend    running\nrelaysessions    Session Host    -    yes    manifest,sessions    running\n' : '');
      const [verb] = args;
      const last = args[args.length - 1];
      if (verb === 'fetch') fetched[cwd] = last === 'origin' ? main(cwd) : ref(cwd);
      if (verb === 'reset') head[cwd] = resolve(cwd, last);
      if (verb === 'merge') head[cwd] = main(cwd);
      if (verb === 'status') return ok(dirty ? ' M go.mod\n' : '');
      if (verb === 'diff' || verb === 'diff-index') return ok('', dirty ? 1 : 0);
      if (verb === 'branch' || verb === 'symbolic-ref') return ok(`${branch}\n`);
      if (verb !== 'rev-parse') return ok();
      if (args.includes('--abbrev-ref')) return ok(`${branch}\n`);
      if (last === 'FETCH_HEAD') return ok(`${fetched[cwd]}\n`);
      const m = /^(.*):package-lock\.json$/.exec(last);
      if (m) return ok(`${blob(resolve(cwd, m[1]))}\n`);
      return ok(`${head[cwd] || SHA.tool}\n`);
    },
    async gh(args, { cwd }) {
      const repo = cwd === EVE ? 'eve' : 'relay';
      if (args[0] === 'api') { calls.push(`GH ${repo} ${args.join(' ')}`); return '{}'; }
      if (args[1] === 'comment') return `https://github.com/acme/${repo}/pull/${args[2]}#issuecomment-1\n`;
      return JSON.stringify({ headRefOid: ghHead[repo] || ref(cwd), url: `https://github.com/acme/${repo}/pull/${args[2]}` });
    },
    async acquire() { calls.push('ACQUIRE'); return async () => { calls.push('RELEASE'); }; },
    waitForPort: async () => true,
    authStatus: async () => ({ enrolled: true }),
    async waitForFile(file) {
      if (!done) return false;
      w.runDir = path.dirname(file);
      calls.push('CONSOLE');
      const plan = JSON.parse(fs.readFileSync(path.join(w.runDir, 'plan.json'), 'utf8'));
      const results = plan.phases.map((p) => {
        const o = phases[p.label] || {};
        fs.writeFileSync(path.join(w.runDir, `${p.label}.out`), o.stdout ?? GREEN_OUT);
        return { label: p.label, code: o.code ?? 0, timedOut: !!o.timedOut };
      });
      fs.writeFileSync(file, JSON.stringify({ phases: results }));
      return true;
    },
    consoleOwner: () => consoleOwner,
    user: () => 'tester',
    async postSet(ev, o) { calls.push('POSTSET'); posted.push(ev); return realPost ? setStatus.postSet(ev, o) : post(ev); },
    now: () => now,
    out: (line) => out.push(line),
    log: (line) => log.push(line),
    sleep: async () => {},
    fs,
  };
  return w;
}

async function go(argv, opts) {
  const w = world(opts);
  w.code = await runSet({ ...parseArgs(argv), env: w.env }, w.deps);
  w.text = w.out.join('\n');
  w.idx = (re) => w.calls.findIndex((c) => re.test(c));
  return w;
}
const usageOf = (argv) => { try { parseArgs(argv); } catch (e) { return e; } return null; };

describe('parseArgs', () => {
  it.each([
    [['--relay', '7', '--eve', '12'], { relay: { pr: 7 }, eve: { pr: 12 }, post: false }],
    [['--eve', 'feat/x-1.2_b'], { relay: null, eve: { branch: 'feat/x-1.2_b' }, post: false }],
    [['--post', '--relay', '7'], { relay: { pr: 7 }, eve: null, post: true }],
  ])('%j parses', (argv, want) => expect(parseArgs(argv)).toEqual(want));

  it.each([
    ['neither ref', ['--post']],
    ['--post with a branch ref', ['--relay', '7', '--eve', 'feat/x', '--post']],
    ['a repeated flag', ['--eve', '1', '--eve', '2']],
    ['an unknown argument', ['--eve', '1', '--screen']],
    ['a positional argument', ['--eve', '1', 'extra']],
    ['a branch with a space', ['--eve', 'feat x']],
    ['a branch with a shell character', ['--relay', 'feat;rm']],
    ['a branch starting with -', ['--eve', '-feat']],
    ['PR number 0', ['--relay', '0']],
  ])('%s is a usage error', (_, argv) => expect(usageOf(argv)).toMatchObject({ usage: true }));

  it.each([
    ['no arguments', [], {}],
    ['a relative eve checkout', ['--eve', '12'], { NIGHTLY_RELAY_CHECKOUT: RELAY, NIGHTLY_EVE_CHECKOUT: 'w/eve' }],
    ['no relay checkout', ['--eve', '12'], { NIGHTLY_EVE_CHECKOUT: EVE }],
  ])('the CLI exits 2 with the usage line for %s', (_, argv, env) => {
    const r = spawnSync(process.execPath, [SET_JS, ...argv], { env: { PATH: logDir, HOME: logDir, NIGHTLY_LOG_DIR: logDir, ...env }, encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(USAGE);
  });
});

describe('planPhases', () => {
  const relay = { repo: 'relay', pr: 7, branch: null, sha: SHA.relayRef, url: null, checkout: WT };
  const eve = { repo: 'eve', pr: 12, branch: null, sha: SHA.eveRef, url: null, checkout: EVE };
  const shape = (ps) => ps.map((p) => ({ label: p.label, repo: p.repo, cwd: p.cwd, cmd: path.basename(p.cmd), args: p.args }));

  it('plans a pair in the nightly order, eve with --screen, and never --post', () => {
    expect(shape(planPhases({ relay, eve, post: true }))).toEqual([
      { label: 'relay-api', repo: 'relay', cwd: WT, cmd: 'go', args: ['run', './cmd/devboxverify', '--checkout', WT, '--phase', 'api'] },
      { label: 'eve', repo: 'eve', cwd: EVE, cmd: 'node', args: ['devboxverify/main.js', '--checkout', EVE, '--screen'] },
      { label: 'relay-screen', repo: 'relay', cwd: WT, cmd: 'go', args: ['run', './cmd/devboxverify', '--checkout', WT, '--phase', 'screen'] },
    ]);
  });

  it.each([
    [{ relay: null, eve }, { label: 'eve', repo: 'eve', cwd: EVE, cmd: 'node', args: ['devboxverify/main.js', '--checkout', EVE, '--screen', '--post', '12'] }],
    [{ relay, eve: null }, { label: 'relay', repo: 'relay', cwd: WT, cmd: 'go', args: ['run', './cmd/devboxverify', '--checkout', WT, '--post', '7'] }],
  ])('plans one ref with --post as that repo\'s own verify', (refs, want) => {
    expect(shape(planPhases({ ...refs, post: true }))).toEqual([want]);
  });
});

describe('runSet', () => {
  it('builds relay in a worktree at its sha, resets the verify eve to its sha, restarts, then runs the console', async () => {
    const w = await go(['--relay', '7', '--eve', '12', '--post']);
    const order = [
      new RegExp(`^relay: git worktree add --detach ${WT} ${SHA.relayRef}$`), /^wt: build\.sh/,
      new RegExp(`^eve: git reset .*--hard ${SHA.eveRef}$`), /relay service restart --id eve-verify$/, /^CONSOLE$/,
    ].map(w.idx);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const planFile = path.join(w.runDir, 'plan.json');
    expect(path.dirname(w.runDir)).toBe(path.join(logDir, 'set'));
    expect(fs.statSync(planFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(w.runDir, 'phases.command')).mode & 0o777).toBe(0o700);
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    expect(plan.phases.map((p) => [p.label, p.cwd])).toEqual([['relay-api', WT], ['eve', EVE], ['relay-screen', WT]]);
    const allowed = ['PATH', 'HOME', 'EVE_VERIFY_MODEL', 'RELAY_VERIFY_MODEL', 'RELAY_BIN', 'DEVBOXPRESENCE_BIN',
      'DEVBOXWORLD_MARKER', 'RELAY_VERIFY_CREDENTIAL_FILE', 'EVE_BROWSER_LOCK'];
    expect(Object.keys(plan.env).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(fs.readFileSync(planFile, 'utf8')).not.toContain('not-for-disk');

    expect(w.out.filter((l) => l.startsWith('PHASE\t')).map((l) => l.split('\t').slice(0, 4))).toEqual([
      ['PHASE', 'relay-api', 'GREEN', SHA.relayRef.slice(0, 12)], ['PHASE', 'eve', 'GREEN', SHA.eveRef.slice(0, 12)],
      ['PHASE', 'relay-screen', 'GREEN', SHA.relayRef.slice(0, 12)],
    ]);
    expect(w.posted).toHaveLength(1);
    expect([w.posted[0].relay.sha, w.posted[0].eve.sha]).toEqual([SHA.relayRef, SHA.eveRef]);
    expect(w.out[w.out.length - 1]).toBe('SET\tsuccess');
    expect(w.code).toBe(0);
  });

  it('restores relay before eve and releases the lock last', async () => {
    const w = await go(['--relay', '7', '--eve', '12']);
    const order = [/^relay: git merge --ff-only origin\/main$/, /^relay: build\.sh/, /^eve: git reset .*--hard origin\/main$/, /^RELEASE$/].map(w.idx);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(w.calls[w.calls.length - 1]).toBe('RELEASE');
    expect(w.text).toMatch(/^RESTORE\trelay\tOK\t/m);
    expect(w.text).toMatch(/^RESTORE\teve\tOK\t/m);
  });

  it('posts, prints and exits with the state set-status gives a RED phase whose journeys all pass', async () => {
    const w = await go(['--relay', '7', '--eve', '12', '--post'], {
      realPost: true, phases: { eve: { code: 1, stdout: 'JOURNEY\tj1\tPASS\t\nSUMMARY\tpass=1\tfail=0\tblocked=0\tnotrun=0\n' } },
    });
    const states = w.calls.filter((c) => c.startsWith('GH ')).map((c) => /state=(\w+)/.exec(c)[1]);
    expect(states).toEqual(['failure', 'failure']);
    expect(w.out.filter((l) => /^(POSTED|SET)\t/.test(l)).map((l) => l.split('\t').slice(0, 3).join(' ')))
      .toEqual(['POSTED relay#7 failure', 'POSTED eve#12 failure', 'SET failure']);
    expect(w.code).toBe(1);
  });

  it.each([[false, 0], [true, 1]])('runs npm ci for the eve ref only when its lockfile differs (%s)', async (changes, n) => {
    const w = await go(['--eve', '12'], { lockBlobChanges: changes });
    const before = w.calls.slice(0, w.idx(/^CONSOLE$/));
    expect(before.filter((c) => /^eve: npm ci$/.test(c))).toHaveLength(n);
    if (n) expect(w.idx(/^eve: npm ci$/)).toBeGreaterThan(w.idx(new RegExp(`^eve: git reset .*--hard ${SHA.eveRef}$`)));
  });

  it.each([
    ['02:30, inside the nightly window', { now: at(2, 30) }, 'window'],
    ['04:29, inside the nightly window', { now: at(4, 29) }, 'window'],
    ['a PR head that moved after the fetch', { ghHead: { eve: '6'.repeat(40) } }, 'eve-ref'],
    ['a console owned by another user', { consoleOwner: 'someone-else' }, 'console'],
  ])('refuses at %s: exit 2, nothing touched, nothing restored', async (_, opts, stepName) => {
    const w = await go(['--relay', '7', '--eve', '12', '--post'], opts);
    expect(w.text).toMatch(new RegExp(`^STEP\\t${stepName}\\tFAIL`, 'm'));
    expect(w.code).toBe(2);
    expect(w.calls.filter((c) => /ACQUIRE|CONSOLE|POSTSET|worktree add|build\.sh|reset|npm|restart|merge/.test(c))).toEqual([]);
    expect(w.text).not.toMatch(/^RESTORE/m);
  });

  it.each([at(2, 29), at(4, 31)])('starts outside the nightly window (%s)', async (now) => {
    const w = await go(['--eve', '12'], { now });
    expect(w.text).not.toMatch(/^STEP\twindow/m);
    expect(w.code).toBe(0);
  });

  it.each([
    ['a relay build failure', { build: 1 }, /^STEP\trelay-build\tFAIL/m, false, false],
    ['a console timeout', { done: false }, /^STEP\tconsole-run\tFAIL/m, false, true],
    ['a post failure', { post: async () => { throw new Error('gh down'); } }, /^POSTED\tFAIL\t/m, true, true],
  ])('restores after %s and exits 2', async (_, opts, failLine, posts, eveTouched) => {
    const w = await go(['--relay', '7', '--eve', '12', '--post'], opts);
    expect(w.text).toMatch(failLine);
    expect(w.calls.includes('POSTSET')).toBe(posts);
    expect(w.idx(/^relay: git merge --ff-only origin\/main$/)).toBeGreaterThanOrEqual(0);
    expect(w.text).toMatch(/^RESTORE\trelay\tOK\t/m);
    if (eveTouched) expect(w.text).toMatch(/^RESTORE\teve\tOK\t/m);
    expect(w.calls[w.calls.length - 1]).toBe('RELEASE');
    expect(w.code).toBe(2);
  });

  it.each([['a dirty tracked tree', { dirty: true }], ['a branch other than main', { branch: 'feat/x' }]])(
    'reports RESTORE relay FAIL for %s, builds nothing from it, and still releases the lock', async (_, opts) => {
      const w = await go(['--relay', '7', '--eve', '12'], opts);
      expect(w.text).toMatch(/^RESTORE\trelay\tFAIL\t/m);
      expect(w.calls.filter((c) => /^relay: (git merge|build\.sh)/.test(c))).toEqual([]);
      expect(w.log.join('\n')).toContain(SHA.relayRef.slice(0, 12));
      expect(w.calls[w.calls.length - 1]).toBe('RELEASE');
      expect(w.code).toBe(2);
    });

  it.each([
    ['eve', ['--eve', '12', '--post'], 1, /^(wt|relay): |build\.sh|merge/],
    ['relay', ['--relay', '7', '--post'], 0, /^eve: (git|npm)/],
  ])('with only %s, runs its own verify, copies POSTED, passes the exit code through and leaves the other repo alone', async (label, argv, code, foreign) => {
    const posted = `POSTED\t${code ? 'failure' : 'success'}\thttps://github.com/acme/${label}/pull/1#issuecomment-9`;
    const stdout = `JOURNEY\tj1\t${code ? 'FAIL' : 'PASS'}\t\nSUMMARY\tpass=${1 - code}\tfail=${code}\tblocked=0\tnotrun=0\n${posted}\n`;
    const w = await go(argv, { phases: { [label]: { code, stdout } } });
    expect(w.out).toContain(posted);
    expect(w.calls).not.toContain('POSTSET');
    expect(w.calls.filter((c) => foreign.test(c))).toEqual([]);
    expect(w.code).toBe(code);
  });
});

describe('runPhases', () => {
  const phase = (label, cmd) => ({ label, repo: 'relay', cwd: '/w/wt', cmd, args: ['run', label] });
  function setup(dir, phases) {
    fs.mkdirSync(dir, { recursive: true });
    const plan = { phases, env: { PATH: '/usr/bin', EVE_BROWSER_LOCK: path.join(dir, 'inner.lock') }, timeoutMs: 1800000 };
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
    const runs = [];
    const results = { a: { code: 1, stdout: 'SUMMARY\tpass=0\tfail=1\n', stderr: 'e-a', timedOut: false }, b: { code: null, stdout: 'partial', stderr: '', timedOut: true } };
    const run = async (cmd, args, o) => { runs.push({ cmd, args, ...o }); return results[args[1]]; };
    return { plan, runs, deps: { run, fs } };
  }

  it('runs each phase with the plan env and timeout, writes its output, then done.json', async () => {
    const dir = path.join(logDir, 'set', '2026-10-03T12-00-00-000Z');
    const { plan, runs, deps } = setup(dir, [phase('a', 'go'), phase('b', process.execPath)]);
    await runPhases(dir, deps);
    expect(runs).toEqual(plan.phases.map((p) => ({ cmd: p.cmd, args: p.args, cwd: p.cwd, env: plan.env, timeoutMs: 1800000 })));
    expect(fs.readFileSync(path.join(dir, 'a.out'), 'utf8')).toBe('SUMMARY\tpass=0\tfail=1\n');
    expect(fs.readFileSync(path.join(dir, 'a.err'), 'utf8')).toBe('e-a');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'done.json'), 'utf8'))).toEqual({
      phases: [{ label: 'a', code: 1, timedOut: false }, { label: 'b', code: null, timedOut: true }],
    });
  });

  it.each([
    ['a run dir outside <log dir>/set/', 'elsewhere', [phase('a', 'go')]],
    ['a plan with a command other than node or go', 'set', [phase('a', 'go'), phase('b', '/bin/sh')]],
  ])('refuses %s and runs nothing', async (_, parent, phases) => {
    const dir = path.join(logDir, parent, '2026-10-03T12-00-00-000Z');
    const { runs, deps } = setup(dir, phases);
    await runPhases(dir, deps).catch(() => {});
    expect(runs).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'done.json'))).toBe(false);
  });
});
