// The shared browser-test lock through its real entry points: the CLI wrapper,
// the npm scripts and devboxverify/main.js. Every test gets its own lock
// file, shared by that test's processes; no browser ever launches (the npm scripts only run with the lock held
// and a zero timeout).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'browser-lock.js');
const MAIN = path.join(ROOT, 'devboxverify', 'main.js');
const NODE = process.execPath;
const IDLE = 'setInterval(()=>{},1e3)';
const MARK_THEN_IDLE = `require('fs').writeFileSync(process.argv[1],'');${IDLE}`;
const MARK = "require('fs').writeFileSync(process.argv[1],'')";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('browser-test lock', () => {
  let tmp, lockFile, markerFile, vmPreload, children;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-lock-'));
    lockFile = path.join(tmp, 'browser-tests.lock');
    const checkout = path.join(tmp, 'world');
    fs.mkdirSync(path.join(checkout, 'data'), { recursive: true });
    const keys = ['acme', 'globex', 'home'];
    fs.writeFileSync(path.join(checkout, 'data', 'world.json'), JSON.stringify({
      world_version: 1,
      relay_mcp: { id: 'macmcp', tools: 'mail_*' },
      fixtures: [...keys.map((k) => `project:${k}`), ...keys.map((k) => `file:${k}/PROJECT.md`),
        'file:acme/todo.txt', 'file:acme/budget/q4-budget-draft.csv'],
      projects: [['acme', 'Acme Corp'], ['globex', 'Globex'], ['home', 'Home']].map(([key, name]) => ({ key, name, mode: 'work' })),
    }));
    markerFile = path.join(tmp, 'machine.json');
    fs.writeFileSync(markerFile, JSON.stringify({
      schema: 1, world_checkout: checkout, world_root: path.join(tmp, 'root'), world_version: 1, written_at: '2026-09-28T03:30:00Z',
    }), { mode: 0o600 });
    fs.chmodSync(markerFile, 0o600);
    // CI has no sysctl, so the preflight's VM check is stubbed in the child through the real CLI.
    vmPreload = path.join(tmp, 'vm.js');
    fs.writeFileSync(vmPreload, `require(${JSON.stringify(path.join(ROOT, 'devboxverify', 'world.js'))}).isVM = () => true;\n`);
    children = [];
  });

  afterEach(async () => {
    for (const { child } of children) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function start(cmd, args, { timeout, env = {} }) {
    const t0 = Date.now();
    const child = spawn(cmd, args, {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, EVE_BROWSER_LOCK: lockFile, EVE_BROWSER_LOCK_TIMEOUT: String(timeout), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, ms: Date.now() - t0 })));
    const closed = new Promise((r) => child.on('close', (code, signal) => r({ code, signal, stdout, stderr, ms: Date.now() - t0 })));
    const proc = { child, exited, closed };
    children.push(proc);
    return proc;
  }

  const wrap = (argv, opts) => start(NODE, [CLI, ...argv], opts);
  const probe = (timeout = 0) => wrap([NODE, '-e', '0'], { timeout }).closed;
  const verify = (timeout) => start(NODE, ['-r', vmPreload, MAIN, '--service', 'no-such-service'], {
    timeout, env: { RELAY_BIN: path.join(tmp, 'no-such-relay'), DEVBOXWORLD_MARKER: markerFile, NIGHTLY_LOG_DIR: path.join(tmp, 'logs') },
  }).closed;
  const TOTAL = require('../../devboxverify/journeys').journeys.length;
  const SELECTION_ROW = `SELECTION\tfull\t${TOTAL}/${TOTAL}\t-\tnot a PR run`;
  const MACHINE_ROW = 'PREFLIGHT\tmachine\tOK\tvm; world v1';
  const PIN_ROW = 'PREFLIGHT\tpin\tOK\tv1';
  const FIXTURES_ROW = 'PREFLIGHT\\tfixtures\\tOK\\t\\d+ fixtures for \\d+ journeys';

  async function waitFor(fn, what) {
    const deadline = Date.now() + 10000;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  function holderPid() {
    try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid; } catch { return null; }
  }

  async function startHolder() {
    const argv = [NODE, '-e', IDLE];
    const holder = wrap(argv, { timeout: 0 });
    await waitFor(() => holderPid() === holder.child.pid, 'holder pid in the lock file');
    return { ...holder, pid: holder.child.pid, command: argv.join(' ') };
  }

  it.each([
    ['test:e2e', ['--', '--list']],
    ['test:visual', []],
  ])('npm run %s refuses at once while the lock is held, naming the holder', async (script, extra) => {
    const holder = await startHolder();
    const r = await start('npm', ['run', '-s', script, ...extra], { timeout: 0 }).closed;
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(new RegExp(`held by pid ${holder.pid} \\(`));
    expect(r.ms).toBeLessThan(10000);
  });

  it('passes a failing child\'s exit code through and releases the lock', async () => {
    const r = await wrap([NODE, '-e', 'process.exit(3)'], { timeout: 0 }).closed;
    expect(r.code).toBe(3);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('');
    expect((await probe()).code).toBe(0);
  });

  it.each([['SIGINT', 130], ['SIGTERM', 143]])('%s to the wrapper exits %i and releases the lock', async (sig, code) => {
    const marker = path.join(tmp, 'started');
    const w = wrap([NODE, '-e', MARK_THEN_IDLE, marker], { timeout: 0 });
    await waitFor(() => fs.existsSync(marker), 'wrapped child to start');
    process.kill(w.child.pid, sig);
    expect((await w.closed).code).toBe(code);
    expect((await probe()).code).toBe(0);
  });

  it('devboxverify takes the free lock right after the world rows and releases it', async () => {
    const r = await verify(0);
    const lines = r.stdout.replace(/\n$/, '').split('\n');
    expect(lines.slice(0, 5)).toEqual([
      SELECTION_ROW,
      MACHINE_ROW,
      PIN_ROW,
      expect.stringMatching(new RegExp(`^${FIXTURES_ROW}$`)),
      'PREFLIGHT\tlock\tOK\tacquired',
    ]);
    expect(lines[lines.length - 1]).toMatch(/^PREFLIGHT\t(tree|service)\tFAIL\t/);
    expect(r.code).toBe(2);
    expect((await probe()).code).toBe(0);
  });

  it('a waiter gives up after its timeout with exit 75, naming the holder, without running its command', async () => {
    const holder = await startHolder();
    const marker = path.join(tmp, 'ran');
    const r = await wrap([NODE, '-e', MARK, marker], { timeout: 1 }).closed;
    expect(r.code).toBe(75);
    expect(r.stderr).toMatch(new RegExp(`held by pid ${holder.pid} \\(${escape(holder.command)}\\)`));
    expect(r.ms).toBeGreaterThanOrEqual(1000);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('devboxverify reports a held lock as a failed lock row and stops', async () => {
    const holder = await startHolder();
    const r = await verify(1);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(new RegExp(`^${escape(SELECTION_ROW)}\\n${escape(MACHINE_ROW)}\\n${escape(PIN_ROW)}\\n${FIXTURES_ROW}\\n`
      + `PREFLIGHT\\tlock\\tFAIL\\t[^\\n]*pid ${holder.pid}\\b[^\\n]*\\n$`));
    expect(r.stderr).toMatch(new RegExp(`browser-lock: ${escape(lockFile)} is held by pid ${holder.pid} \\(.*; waiting up to 1s`));
  });

  it('a SIGKILLed holder leaves a stale file that does not block the next run', async () => {
    const holder = await startHolder();
    process.kill(holder.pid, 'SIGKILL');
    await holder.exited;
    expect(holderPid()).toBe(holder.pid);
    const r = await probe(5);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(3500);
  });

  it('without perl on PATH it exits 70 and never runs the command unlocked', async () => {
    const marker = path.join(tmp, 'ran');
    const emptyBin = path.join(tmp, 'bin');
    fs.mkdirSync(emptyBin);
    const r = await wrap([NODE, '-e', MARK, marker], { timeout: 0, env: { PATH: emptyBin } }).closed;
    expect(r.code).toBe(70);
    expect(r.stderr).toContain('cannot take');
    expect(fs.existsSync(marker)).toBe(false);
  });
});
