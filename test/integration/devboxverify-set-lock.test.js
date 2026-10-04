// The set runner with the real shared browser lock (perl helper, temp lock
// file). Everything else the runner touches is faked: no git, gh, relay or Terminal.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { acquire } = require('../../scripts/browser-lock');
const { parseArgs, runSet } = require('../../devboxverify/set');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'browser-lock.js');
const NODE = process.execPath;
const RELAY = '/w/relay';
const EVE = '/w/eve-verify';
const REF = { [RELAY]: '2'.repeat(40), [EVE]: '4'.repeat(40) };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('set runner and the shared browser lock', () => {
  let tmp, lockFile, holder, savedEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'set-lock-'));
    lockFile = path.join(tmp, 'browser-tests.lock');
    savedEnv = { EVE_BROWSER_LOCK: process.env.EVE_BROWSER_LOCK, EVE_BROWSER_LOCK_TIMEOUT: process.env.EVE_BROWSER_LOCK_TIMEOUT };
    Object.assign(process.env, { EVE_BROWSER_LOCK: lockFile, EVE_BROWSER_LOCK_TIMEOUT: '1' });
    holder = null;
  });

  afterEach(async () => {
    if (holder) {
      try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* group already gone */ }
      await holder.exited;
    }
    for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function holdLock() {
    const child = spawn(NODE, [CLI, NODE, '-e', 'setInterval(()=>{},1e3)'], {
      detached: true, stdio: 'ignore', env: { ...process.env, EVE_BROWSER_LOCK: lockFile, EVE_BROWSER_LOCK_TIMEOUT: '0' },
    });
    holder = { pid: child.pid, exited: new Promise((r) => child.on('exit', r)) };
    const deadline = Date.now() + 10000;
    for (;;) {
      try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === child.pid) return; } catch { /* not yet */ }
      if (Date.now() > deadline) throw new Error('holder never took the lock');
      await sleep(50);
    }
  }

  // 'busy' while anyone holds the shared lock, 'free' otherwise.
  const probe = () => acquire({ command: 'probe', file: lockFile, timeoutMs: 0, log: () => {} })
    .then((release) => release().then(() => 'free'), (err) => (err.code === 'ELOCKTIMEOUT' ? 'busy' : Promise.reject(err)));

  function deps(onStep) {
    const calls = [];
    const lines = [];
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '', timedOut: false });
    const d = {
      calls, lines,
      async run(cmd, args, { cwd }) {
        const line = `${path.basename(cmd)} ${args.join(' ')}`;
        calls.push(line);
        await onStep(line);
        if (args.join(' ') === 'service list') return ok('relaysessions    Session Host    -    yes    manifest,sessions    running\n');
        if (args[0] !== 'rev-parse') return ok();
        if (args.includes('--abbrev-ref')) return ok('main\n');
        return ok(`${REF[cwd] || '1'.repeat(40)}\n`);
      },
      gh: async (args, { cwd }) => JSON.stringify({ headRefOid: REF[cwd], url: `https://github.com/acme/x/pull/${args[2]}` }),
      acquire,
      waitForPort: async () => true,
      authStatus: async () => ({}),
      async waitForFile(file) {
        d.runDir = path.dirname(file);
        await onStep('CONSOLE');
        const plan = JSON.parse(fs.readFileSync(path.join(d.runDir, 'plan.json'), 'utf8'));
        for (const p of plan.phases) fs.writeFileSync(path.join(d.runDir, `${p.label}.out`), 'SUMMARY\tpass=1\tfail=0\tblocked=0\tnotrun=0\n');
        fs.writeFileSync(file, JSON.stringify({ phases: plan.phases.map((p) => ({ label: p.label, code: 0, timedOut: false })) }));
        return true;
      },
      consoleOwner: () => 'tester',
      user: () => 'tester',
      postSet: async () => { throw new Error('postSet must not run without --post'); },
      now: () => new Date(2026, 9, 3, 12, 0).getTime(),
      out: (line) => lines.push(line),
      log: () => {},
      sleep: async () => {},
      fs,
    };
    return d;
  }

  const run = (d) => runSet({
    ...parseArgs(['--relay', '7', '--eve', '12']),
    env: { PATH: process.env.PATH, HOME: tmp, NIGHTLY_RELAY_CHECKOUT: RELAY, NIGHTLY_EVE_CHECKOUT: EVE,
      NIGHTLY_LOG_DIR: tmp, EVE_BROWSER_LOCK: lockFile, EVE_BROWSER_LOCK_TIMEOUT: '1' },
  }, d);

  it('with the lock held elsewhere, fails the lock step after its timeout and builds or resets nothing', async () => {
    await holdLock();
    const d = deps(async () => {});
    const code = await run(d);
    expect(d.lines.join('\n')).toMatch(/^STEP\tlock\tFAIL\t/m);
    expect(code).toBe(2);
    expect(d.calls.filter((c) => /worktree add|build\.sh|reset|restart/.test(c))).toEqual([]);
    expect(await probe()).toBe('busy');
  });

  it('holds the lock through the console run and restore, gives the harnesses a private lock, and releases it', async () => {
    const seen = {};
    const d = deps(async (line) => {
      if (line === 'CONSOLE' || /^git (merge --ff-only|reset .*--hard origin\/main)/.test(line)) seen[line] = await probe();
    });
    const code = await run(d);
    expect(code).toBe(0);
    expect(Object.values(seen)).toHaveLength(3);
    expect(Object.values(seen).every((s) => s === 'busy')).toBe(true);
    const plan = JSON.parse(fs.readFileSync(path.join(d.runDir, 'plan.json'), 'utf8'));
    expect(plan.env.EVE_BROWSER_LOCK).toBe(path.join(d.runDir, 'inner.lock'));
    expect(path.resolve(plan.env.EVE_BROWSER_LOCK)).not.toBe(path.resolve(lockFile));
    expect(await probe()).toBe('free');
  });
});
