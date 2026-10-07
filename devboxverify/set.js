#!/usr/bin/env node
'use strict';

// Verifies a relay + eve change set in one run: builds Relay.app from the relay
// ref, points the verify eve at the eve ref, runs the nightly's phase order,
// posts, then restores both to main. With one ref it runs that repo's own
// verify exactly as today, plus setup, restore and the lock.

const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE = 'usage: node devboxverify/set.js [--relay REF] [--eve REF] [--post]';
const PHASE_TIMEOUT_MS = 30 * 60 * 1000;
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const NPM_CI_TIMEOUT_MS = 10 * 60 * 1000;
const SERVICE_TIMEOUT_MS = 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_RELAY_BIN = '/Applications/Relay.app/Contents/MacOS/relay';
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
// Nightly runs at 03:30; a set run lasts well under an hour.
const WINDOW_START_MIN = 2 * 60 + 30;
const WINDOW_END_MIN = 4 * 60 + 30;
const ENV_ALLOWLIST = ['PATH', 'HOME', 'EVE_VERIFY_MODEL', 'RELAY_VERIFY_MODEL', 'RELAY_BIN',
  'DEVBOXPRESENCE_BIN', 'DEVBOXWORLD_MARKER', 'RELAY_VERIFY_CREDENTIAL_FILE'];

const usageError = () => Object.assign(new Error(USAGE), { usage: true });

function parseRef(value) {
  if (value === undefined) throw usageError();
  if (/^\d+$/.test(value)) {
    const pr = Number(value);
    if (!Number.isSafeInteger(pr) || pr < 1) throw usageError();
    return { pr };
  }
  if (!BRANCH_RE.test(value) || value.startsWith('-')) throw usageError();
  return { branch: value };
}

function parseArgs(argv) {
  const out = { relay: null, eve: null, post: false };
  let postSeen = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--relay' || a === '--eve') {
      const key = a.slice(2);
      if (out[key]) throw usageError();
      out[key] = parseRef(argv[++i]);
    } else if (a === '--post') {
      if (postSeen) throw usageError();
      postSeen = out.post = true;
    } else {
      throw usageError();
    }
  }
  if (!out.relay && !out.eve) throw usageError();
  if (out.post && [out.relay, out.eve].some(r => r && !r.pr)) throw usageError();
  return out;
}

// Refs carry the checkout each phase runs in (the relay worktree for relay).
function planPhases({ relay, eve, post }) {
  const relayCmd = (label, extra) => ({ label, repo: 'relay', cwd: relay.checkout, cmd: 'go',
    args: ['run', './cmd/devboxverify', '--checkout', relay.checkout, ...extra] });
  const eveArgs = ['devboxverify/main.js', '--checkout', eve && eve.checkout, '--screen'];
  if (relay && eve) {
    return [relayCmd('relay-api', ['--phase', 'api']),
      { label: 'eve', repo: 'eve', cwd: eve.checkout, cmd: 'node', args: eveArgs },
      relayCmd('relay-screen', ['--phase', 'screen'])];
  }
  if (eve) {
    return [{ label: 'eve', repo: 'eve', cwd: eve.checkout, cmd: 'node',
      args: post ? [...eveArgs, '--post', String(eve.pr)] : eveArgs }];
  }
  return [relayCmd('relay', post ? ['--post', String(relay.pr)] : [])];
}

// Same rules as the nightly's classify and summaryOf.
function classify({ code, timedOut, stdout }) {
  if (timedOut) return 'BLOCKED';
  if (code === 0) return 'GREEN';
  if (code === 1 && /^SUMMARY\t/m.test(stdout)) return 'RED';
  return 'BLOCKED';
}

function summaryOf(stdout) {
  const lines = stdout.split(/\r?\n/);
  const sums = lines.filter(l => l.startsWith('SUMMARY\t'));
  const line = sums.length ? sums[sums.length - 1] : lines.find(l => /^PREFLIGHT\t[^\t]+\tFAIL/.test(l));
  return line ? line.replace(/\t/g, ' ') : 'no summary';
}

const oneLine = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const sha12 = sha => String(sha).slice(0, 12);
const sleepReal = ms => new Promise(r => setTimeout(r, ms));

async function runSet(opts, deps) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const scrub = s => (home ? String(s).split(home).join('~') : String(s));
  const out = line => deps.out(scrub(line));
  const log = line => deps.log(scrub(line));
  const step = (name, ok, detail = '') => out(['STEP', name, ok ? 'OK' : 'FAIL', oneLine(detail)].join('\t'));
  const sleep = deps.sleep || sleepReal;

  const relayCheckout = env.NIGHTLY_RELAY_CHECKOUT;
  const eveCheckout = env.NIGHTLY_EVE_CHECKOUT;
  for (const [name, v] of [['NIGHTLY_RELAY_CHECKOUT', relayCheckout], ['NIGHTLY_EVE_CHECKOUT', eveCheckout]]) {
    if (!v || !path.isAbsolute(v)) {
      log(`${USAGE}\n${name} must be an absolute path`);
      return 2;
    }
  }

  const startedAt = deps.now();
  const d = new Date(startedAt);
  const minutes = d.getHours() * 60 + d.getMinutes();
  if (minutes >= WINDOW_START_MIN && minutes < WINDOW_END_MIN) {
    step('window', false, 'nightly window 02:30-04:30 local; start a set outside it');
    return 2;
  }

  const sh = (cwd, cmd, args, timeoutMs = GIT_TIMEOUT_MS) => deps.run(cmd, args, { cwd, env, timeoutMs });
  const good = r => r.code === 0 && !r.timedOut;
  const why = r => (r.timedOut ? 'timed out' : oneLine(String(r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').pop()));
  const relayBin = env.RELAY_BIN || DEFAULT_RELAY_BIN;

  // Step 2: resolve refs. Nothing on the machine changes here.
  const refs = {};
  let refFail = false;
  for (const [repo, arg, checkout] of [['relay', opts.relay, relayCheckout], ['eve', opts.eve, eveCheckout]]) {
    if (!arg) continue;
    try {
      const f = await sh(checkout, 'git', ['fetch', '--quiet', 'origin']);
      if (!good(f)) throw new Error(`git fetch origin: ${why(f)}`);
      let url = null;
      let want = null;
      if (arg.pr) {
        const view = JSON.parse(await deps.gh(['pr', 'view', String(arg.pr), '--json', 'headRefOid,url'], { cwd: checkout }));
        want = view.headRefOid;
        url = view.url || null;
      }
      const pf = await sh(checkout, 'git', ['fetch', '--quiet', 'origin', arg.pr ? `pull/${arg.pr}/head` : arg.branch]);
      if (!good(pf)) throw new Error(`git fetch ${arg.pr ? `PR ${arg.pr}` : arg.branch}: ${why(pf)}`);
      const rp = await sh(checkout, 'git', ['rev-parse', 'FETCH_HEAD']);
      const sha = rp.stdout.trim();
      if (!good(rp) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('git rev-parse FETCH_HEAD failed');
      if (want && want !== sha) throw new Error(`PR ${arg.pr} head moved: gh says ${sha12(want)}, fetched ${sha12(sha)}`);
      refs[repo] = { repo, pr: arg.pr || null, branch: arg.branch || null, sha, url, checkout };
      step(`${repo}-ref`, true, sha12(sha));
    } catch (err) {
      refFail = true;
      step(`${repo}-ref`, false, err.message);
    }
  }
  if (refFail) return 2;

  // Step 3: the console session the screen phases need.
  if (deps.consoleOwner() !== deps.user()) {
    step('console', false, 'no console session for this user');
    return 2;
  }
  step('console', true, deps.user());

  // Step 4: the shared browser lock, held until after restore.
  let release;
  try {
    release = await deps.acquire({ command: `devboxverify/set.js ${[opts.relay && 'relay', opts.eve && 'eve'].filter(Boolean).join('+')}`, log });
  } catch (err) {
    step('lock', false, err.message);
    return 2;
  }
  step('lock', true, 'held');

  const paired = !!(refs.relay && refs.eve);
  const state = { failed: false, restoreFailed: false, touched: false, relayTouched: false, eveTouched: false };
  const relayWt = refs.relay && path.join(opts.tmpdir || os.tmpdir(), `devboxverify-set-relay-${sha12(refs.relay.sha)}`);
  let phaseResults = [];
  let runDir;

  const waitService = async () => {
    const tries = Math.floor(SERVICE_TIMEOUT_MS / 2000) + 1;
    for (let i = 0; i < tries; i++) {
      const r = await sh(relayCheckout, relayBin, ['service', 'list'], SERVICE_TIMEOUT_MS);
      if (good(r) && /^relaysessions\s.*\srunning\s*$/m.test(r.stdout)) return true;
      if (i < tries - 1) await sleep(2000);
    }
    return false;
  };
  const lockChanged = async (cwd, before) => {
    const after = (await sh(cwd, 'git', ['rev-parse', 'HEAD:package-lock.json'])).stdout.trim();
    return before !== after;
  };
  const evePrepare = async name => {
    const r = await sh(eveCheckout, relayBin, ['service', 'restart', '--id', 'eve-verify'], SERVICE_TIMEOUT_MS);
    if (!good(r)) return step(name, false, `service restart: ${why(r)}`), false;
    if (!(await deps.waitForPort(3100, SERVICE_TIMEOUT_MS))) return step(name, false, 'port 3100 not listening within 60 s'), false;
    let status;
    try { status = await deps.authStatus(); } catch (err) { return step(name, false, `auth/status: ${err.message}`), false; }
    if (status && Object.prototype.hasOwnProperty.call(status, 'trusted')) return step(name, false, 'auth/status has a trusted field'), false;
    return step(name, true, 'port 3100, no trusted field'), true;
  };
  // Resets the verify worktree to a sha; npm ci only when the lockfile blob changed.
  const eveReset = async target => {
    const before = (await sh(eveCheckout, 'git', ['rev-parse', 'HEAD:package-lock.json'])).stdout.trim();
    const r = await sh(eveCheckout, 'git', ['reset', '--quiet', '--hard', target]);
    if (!good(r)) return `git reset --hard ${sha12(target)}: ${why(r)}`;
    if (await lockChanged(eveCheckout, before)) {
      const ci = await sh(eveCheckout, 'npm', ['ci'], NPM_CI_TIMEOUT_MS);
      if (!good(ci)) return `npm ci: ${why(ci)}`;
    }
    return null;
  };

  // Step 11 body: restore, whatever happened.
  let restoreRun = null;
  const restore = () => {
    restoreRun = restoreRun || (async () => {
      try {
        if (state.relayTouched) {
          const fail = async (stepName, reason) => {
            state.restoreFailed = true;
            out(['RESTORE', 'relay', 'FAIL', `${stepName}: ${oneLine(reason)}`].join('\t'));
            log(`Relay.app is still built from ${sha12(refs.relay.sha)}; rebuild from main by hand`);
          };
          let r = await sh(relayCheckout, 'git', ['fetch', '--quiet', 'origin']);
          if (!good(r)) await fail('fetch', why(r));
          else if ((r = await sh(relayCheckout, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() !== 'main') await fail('branch', `relay checkout is on ${oneLine(r.stdout) || 'unknown'}, not main`);
          else if ((r = await sh(relayCheckout, 'git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim() || !good(r)) await fail('clean-tree', `tracked changes in the relay checkout: ${oneLine(r.stdout).slice(0, 120)}`);
          else if (!good(r = await sh(relayCheckout, 'git', ['merge', '--ff-only', 'origin/main']))) await fail('merge', why(r));
          else if (!good(r = await sh(relayCheckout, './build.sh', [], BUILD_TIMEOUT_MS))) await fail('build', why(r));
          else if (!(await waitService())) await fail('service', 'relaysessions not running within 60 s');
          else {
            const head = (await sh(relayCheckout, 'git', ['rev-parse', 'HEAD'])).stdout.trim();
            out(['RESTORE', 'relay', 'OK', sha12(head)].join('\t'));
          }
        }
        if (state.eveTouched) {
          const err = await eveReset('origin/main');
          if (err) {
            state.restoreFailed = true;
            out(['RESTORE', 'eve', 'FAIL', `reset: ${oneLine(err)}`].join('\t'));
            log(`the verify eve worktree is still at ${sha12(refs.eve.sha)}; reset it to origin/main by hand`);
          } else {
            out(['RESTORE', 'eve', 'OK', sha12((await sh(eveCheckout, 'git', ['rev-parse', 'HEAD'])).stdout.trim())].join('\t'));
          }
        }
        if (state.touched && !(await evePrepare('eve-verify'))) state.restoreFailed = true;
        if (relayWt && state.relayTouched) await sh(relayCheckout, 'git', ['worktree', 'remove', '--force', relayWt]);
      } catch (err) {
        state.restoreFailed = true;
        log(`restore threw: ${err.message}`);
      }
    })();
    return restoreRun;
  };

  const releaseOnce = (() => { let p = null; return () => (p = p || Promise.resolve(release())); })();

  try {
    // Step 5: relay build from a detached worktree of the ref.
    if (refs.relay) {
      state.touched = state.relayTouched = true;
      await sh(relayCheckout, 'git', ['worktree', 'remove', '--force', relayWt]);
      const add = await sh(relayCheckout, 'git', ['worktree', 'add', '--detach', relayWt, refs.relay.sha]);
      if (!good(add)) throw Object.assign(new Error(`git worktree add: ${why(add)}`), { step: 'relay-build' });
      const build = await sh(relayWt, './build.sh', [], BUILD_TIMEOUT_MS);
      if (!good(build)) throw Object.assign(new Error(`build.sh: ${why(build)}`), { step: 'relay-build' });
      if (!(await waitService())) throw Object.assign(new Error('relaysessions not running within 60 s'), { step: 'relay-build' });
      step('relay-build', true, sha12(refs.relay.sha));
    }

    // Step 6: point the verify worktree at the eve ref.
    if (refs.eve) {
      state.touched = state.eveTouched = true;
      const err = await eveReset(refs.eve.sha);
      if (err) throw Object.assign(new Error(err), { step: 'eve-checkout' });
      step('eve-checkout', true, sha12(refs.eve.sha));
    }

    // Step 7
    if (!(await evePrepare('eve-verify'))) throw Object.assign(new Error('eve-verify not up'), { step: null });

    // Step 8: console run.
    const phases = planPhases({ relay: refs.relay && { ...refs.relay, checkout: relayWt }, eve: refs.eve, post: opts.post && !paired });
    const nodePath = opts.nodePath || process.execPath;
    const toolRoot = opts.toolRoot || path.resolve(__dirname, '..');
    const logDir = env.NIGHTLY_LOG_DIR || path.join(home, 'Library', 'Logs', 'devboxverify');
    runDir = path.join(logDir, 'set', new Date(startedAt).toISOString().replace(/[:.]/g, '-'));
    deps.fs.mkdirSync(runDir, { recursive: true });
    const planEnv = { EVE_BROWSER_LOCK: path.join(runDir, 'inner.lock') };
    for (const k of ENV_ALLOWLIST) if (env[k] !== undefined) planEnv[k] = env[k];
    const plan = { phases: phases.map(p => ({ ...p, cmd: p.cmd === 'node' ? nodePath : p.cmd })), env: planEnv, timeoutMs: PHASE_TIMEOUT_MS };
    const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
    deps.fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), { mode: 0o600 });
    const script = path.join(runDir, 'phases.command');
    deps.fs.writeFileSync(script, `#!/bin/sh\ncd ${q(toolRoot)} && exec ${q(nodePath)} devboxverify/set.js --phases ${q(runDir)}\n`, { mode: 0o700 });
    const open = await sh(toolRoot, 'open', ['-a', 'Terminal', script]);
    if (!good(open)) throw Object.assign(new Error(`open Terminal: ${why(open)}`), { step: 'console-run' });
    const waitMs = phases.length * PHASE_TIMEOUT_MS + 10 * 60 * 1000;
    const donePath = path.join(runDir, 'done.json');
    if (!(await deps.waitForFile(donePath, waitMs))) {
      throw Object.assign(new Error(`no done.json after ${Math.round(waitMs / 1000)} s`), { step: 'console-run' });
    }
    let done;
    try { done = JSON.parse(deps.fs.readFileSync(donePath, 'utf8')); } catch (err) {
      throw Object.assign(new Error(`done.json unreadable: ${err.message}`), { step: 'console-run' });
    }
    step('console-run', true, `${phases.length} phase(s)`);

    // Step 9: one PHASE line per phase.
    phaseResults = phases.map(p => {
      const rec = (done.phases || []).find(x => x.label === p.label) || { code: null, timedOut: false };
      let stdout = '';
      try { stdout = String(deps.fs.readFileSync(path.join(runDir, `${p.label}.out`), 'utf8')); } catch { /* phase never ran */ }
      const r = { label: p.label, repo: p.repo, sha: refs[p.repo].sha, code: rec.code, timedOut: !!rec.timedOut, stdout };
      r.result = classify(r);
      return r;
    });
    for (const r of phaseResults) {
      out(['PHASE', r.label, r.result, sha12(r.sha), summaryOf(r.stdout)].join('\t'));
      if (!paired) for (const l of r.stdout.split(/\r?\n/)) if (/^POSTED\b/.test(l)) out(l);
    }
  } catch (err) {
    state.failed = true;
    if (err.step) step(err.step, false, err.message);
    else if (err.step === undefined) { step('console-run', false, err.message); }
  }

  // Step 10: post for a pair.
  let postedFail = false;
  const finished = phaseResults.length > 0;
  const setResult = phaseResults.length ? require('./set-status').setState(phaseResults) : 'error';
  if (paired && opts.post && finished) {
    try {
      const toolCommit = (await sh(opts.toolRoot || path.resolve(__dirname, '..'), 'git', ['rev-parse', 'HEAD'])).stdout.trim();
      const urls = await deps.postSet({ relay: refs.relay, eve: refs.eve, phases: phaseResults, toolCommit, runMs: deps.now() - startedAt, home }, { gh: deps.gh });
      for (const repo of ['relay', 'eve']) out(['POSTED', `${repo}#${refs[repo].pr}`, setResult, urls[repo]].join('\t'));
    } catch (err) {
      postedFail = true;
      out(['POSTED', 'FAIL', oneLine(err.message)].join('\t'));
    }
  }

  // Step 11: restore, whatever happened above.
  await restore();

  // Step 12: the SET line and the exit code come from one state.
  const stepOrRestoreFail = state.failed || state.restoreFailed || postedFail;
  const finalSet = stepOrRestoreFail ? 'error' : setResult;
  try {
    out(['SET', finalSet].join('\t'));
  } finally {
    await releaseOnce();
  }

  if (!paired) {
    const r = phaseResults[0];
    const code = r && r.code !== null && !r.timedOut ? r.code : 2;
    return stepOrRestoreFail ? 2 : code;
  }
  return { success: 0, failure: 1 }[finalSet] ?? 2;
}

// Internal mode: runs the plan inside the console Terminal.
async function runPhases(runDir, deps) {
  const resolved = path.resolve(runDir);
  if (!path.isAbsolute(runDir) || path.basename(path.dirname(resolved)) !== 'set') {
    throw new Error(`refusing run dir outside <log dir>/set/: ${runDir}`);
  }
  const plan = JSON.parse(deps.fs.readFileSync(path.join(resolved, 'plan.json'), 'utf8'));
  const nodePath = deps.nodePath || process.execPath;
  for (const p of plan.phases) {
    if (p.cmd !== nodePath && p.cmd !== 'go') throw new Error(`refusing command ${p.cmd} in plan`);
  }
  const results = [];
  for (const p of plan.phases) {
    const r = await deps.run(p.cmd, p.args, { cwd: p.cwd, env: plan.env, timeoutMs: plan.timeoutMs });
    deps.fs.writeFileSync(path.join(resolved, `${p.label}.out`), r.stdout || '');
    deps.fs.writeFileSync(path.join(resolved, `${p.label}.err`), r.stderr || '');
    results.push({ label: p.label, code: r.code === undefined ? null : r.code, timedOut: !!r.timedOut });
  }
  const tmp = path.join(resolved, 'done.json.tmp');
  deps.fs.writeFileSync(tmp, JSON.stringify({ phases: results }));
  deps.fs.renameSync(tmp, path.join(resolved, 'done.json'));
}

function realDeps() {
  const { spawn, execFileSync } = require('child_process');
  const net = require('net');
  const http = require('http');
  const OUTPUT_CAP = 4 * 1024 * 1024;
  const run = (cmd, args, { cwd, env, timeoutMs }) => new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, stdout, stderr: String(err.message), timedOut });
    }
    const append = (buf, chunk) => (buf.length < OUTPUT_CAP ? buf + chunk : buf);
    child.stdout.on('data', c => { stdout = append(stdout, c); });
    child.stderr.on('data', c => { stderr = append(stderr, c); });
    const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10000).unref();
    }, timeoutMs);
    child.on('error', err => { clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + err.message, timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
  const portListening = port => new Promise(resolve => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(2000);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
  const pollUntil = async (check, ms) => {
    const end = performance.now() + ms;
    for (;;) {
      if (await check()) return true;
      if (performance.now() >= end) return false;
      await sleepReal(2000);
    }
  };
  return {
    run,
    gh: (args, o) => require('./post').gh(args, o),
    acquire: o => require('../scripts/browser-lock').acquire(o),
    postSet: (ev, o) => require('./set-status').postSet(ev, o),
    waitForPort: (port, ms) => pollUntil(() => portListening(port), ms),
    authStatus: () => new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:3100/api/auth/status', { timeout: 10000 }, res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
      }).on('error', reject).on('timeout', function onTimeout() { this.destroy(new Error('timed out')); });
    }),
    waitForFile: (file, ms) => pollUntil(() => fs.existsSync(file), ms),
    consoleOwner: () => execFileSync('stat', ['-f', '%Su', '/dev/console'], { encoding: 'utf8' }).trim(),
    user: () => os.userInfo().username,
    now: () => Date.now(),
    out: line => process.stdout.write(`${line}\n`),
    log: line => process.stderr.write(`${line}\n`),
    sleep: sleepReal,
    fs,
  };
}

async function main(argv) {
  if (argv[0] === '--phases') {
    if (argv.length !== 2) throw usageError();
    await runPhases(argv[1], realDeps());
    return 0;
  }
  const args = parseArgs(argv);
  return runSet(args, realDeps());
}

if (require.main === module) {
  // An SSH drop must not stop the run: it finishes and restores itself.
  process.on('SIGHUP', () => {});
  main(process.argv.slice(2)).then(code => process.exit(code), err => {
    process.stderr.write(`${err.usage ? USAGE : `set: ${err.message}`}\n`);
    process.exit(2);
  });
}

module.exports = { parseArgs, planPhases, runSet, runPhases };
