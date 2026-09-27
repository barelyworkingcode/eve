const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EveApi, added, onlyOutside } = require('./eve-api');

const LIVE_EVE_PORT = 3000;
const SCRIPT_TIMEOUT_MS = 300000;
const USAGE = 'usage: node devboxverify/main.js [--checkout DIR] [--world DIR] [--url URL] [--service ID] [--post PR]';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function scrub(s, home) {
  return home ? String(s).split(home).join('~') : String(s);
}

function formatLine(home, ...fields) {
  return fields.map(f => scrub(f, home).replace(/\s+/g, ' ').trim()).join('\t');
}

function usageError(msg) {
  return Object.assign(new Error(msg), { usage: true });
}

function parseArgs(argv, { toolRoot }) {
  const opts = { checkout: toolRoot, world: path.join(toolRoot, '..', 'devboxWorld'), url: 'http://localhost:3100', service: 'eve-verify', post: null };
  const names = new Set(['checkout', 'world', 'url', 'service', 'post']);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m || !names.has(m[1])) throw usageError(`unexpected argument ${argv[i]}`);
    const value = m[2] !== undefined ? m[2] : argv[++i];
    if (value === undefined || value === '') throw usageError(`--${m[1]} needs a value`);
    opts[m[1]] = value;
  }
  if (opts.post !== null) {
    if (!/^\d+$/.test(opts.post) || Number(opts.post) < 1) throw usageError('--post needs a PR number');
    opts.post = Number(opts.post);
  }
  let u;
  try { u = new URL(opts.url); } catch { throw usageError(`bad --url ${opts.url}`); }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(u.hostname) || u.port === '') {
    throw usageError('--url must be http://localhost:<port> or http://127.0.0.1:<port>');
  }
  return opts;
}

function parseWorldSummary(stdout) {
  const lines = String(stdout).split('\n').filter(l => l.startsWith('SUMMARY\t'));
  if (!lines.length) throw new Error('no SUMMARY line');
  const m = /^SUMMARY\tpass=(\d+)\tfail=(\d+)\s*$/.exec(lines[lines.length - 1]);
  if (!m) throw new Error('malformed world summary');
  return { pass: Number(m[1]), fail: Number(m[2]) };
}

function tally(results) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOTRUN: 0 };
  for (const r of results) counts[r.state]++;
  return { counts, exitCode: counts.FAIL + counts.BLOCKED > 0 ? 1 : 0 };
}

function parseListenPids(lsofOut) {
  const pids = String(lsofOut).split('\n').filter(l => /^p\d+$/.test(l.trim())).map(l => Number(l.trim().slice(1)));
  return [...new Set(pids)].sort((a, b) => a - b);
}

function parseCwd(lsofOut) {
  const line = String(lsofOut).split('\n').find(l => l.startsWith('n'));
  return line ? line.slice(1).trim() || null : null;
}

function parseLstart(text) {
  const m = /^\s*\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d\d):(\d\d):(\d\d)\s+(\d{4})\s*$/.exec(String(text));
  const month = m ? MONTHS.indexOf(m[1]) : -1;
  if (month < 0) return null;
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime();
}

function isNodeServer(command) {
  const tokens = String(command || '').trim().split(/\s+/);
  return path.basename(tokens[0] || '') === 'node' && tokens.some(t => t === 'server.js' || t.endsWith('/server.js'));
}

function eveProcessProblem({ pids, cwd, command, startedAtMs, checkout, newestChangeMs, service = 'eve-verify' }) {
  const restart = `relay service restart --id ${service}`;
  if (pids.length !== 1) return `${pids.length} processes listen on the port, want 1; ${restart}`;
  if (!cwd) return `cannot read the working directory of pid ${pids[0]}`;
  if (cwd !== checkout) return `eve runs from ${cwd}, not ${checkout}; re-register ${service} with --workdir ${checkout}`;
  if (!isNodeServer(command)) return `pid ${pids[0]} is not node running server.js`;
  if (startedAtMs === null || startedAtMs === undefined) return `cannot read the start time of pid ${pids[0]}`;
  if (startedAtMs < Math.floor(newestChangeMs / 1000) * 1000) return `eve predates the checkout's newest change; ${restart}`;
  return null;
}

function liveEveProblem({ port, pid, cwd, livePids, liveCwd }) {
  const fix = 'point --url at eve-verify, not the live eve';
  if (port === LIVE_EVE_PORT) return `port ${LIVE_EVE_PORT} is the live eve; ${fix}`;
  if (livePids.includes(pid)) return `pid ${pid} also serves :${LIVE_EVE_PORT}; ${fix}`;
  if (liveCwd !== null && liveCwd !== undefined && liveCwd === cwd) return `the live eve runs from the same checkout; ${fix}`;
  return null;
}

function serviceRowProblem(listOut, service, url) {
  const row = String(listOut).split('\n').map(l => l.trim().split(/\s+/)).find(t => t[0] === service);
  if (!row) return `no ${service} row in relay service list; register it (see devboxverify/README.md)`;
  if (!row.includes(url)) return `${service} is not registered with --url ${url}`;
  if (row[row.length - 1] !== 'running') return `${service} is ${row[row.length - 1]}; relay service restart --id ${service}`;
  return null;
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 << 20, ...opts }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const git = (dir, ...args) => exec('git', ['-C', dir, ...args]).then(s => s.trim());
const lsofPids = port => exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']).then(parseListenPids, () => []);
const realCwd = pid => exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']).then(parseCwd, () => null)
  .then(cwd => (cwd ? fs.realpathSync(cwd) : null));

async function newestChangeMs(checkout) {
  const files = (await exec('git', ['-C', checkout, 'ls-files', '-z'])).split('\0').filter(Boolean);
  return files.reduce((max, f) => {
    try { return Math.max(max, fs.lstatSync(path.join(checkout, f)).mtimeMs); } catch { return max; }
  }, 0);
}

// Deliberate: the script's stdout goes to our stderr or into the capture, never
// our stdout. A grandchild the script leaves behind can hold the captured pipe
// open, so the pipe is destroyed shortly after the script itself exits.
function worldScript(world, name, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(path.join(world, name), args, { cwd: world, stdio: ['ignore', capture ? 'pipe' : 2, 'inherit'] });
    let out = '';
    let code = -1;
    let timedOut = false;
    if (capture) child.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); child.stdout?.destroy(); }, SCRIPT_TIMEOUT_MS);
    const done = () => { clearTimeout(timer); resolve({ code, out, timedOut }); };
    child.on('error', done);
    child.on('exit', (c) => {
      code = c === null ? -1 : c;
      setTimeout(() => child.stdout?.destroy(), 5000).unref();
    });
    child.on('close', done);
  });
}

const timedOutDetail = `timed out after ${SCRIPT_TIMEOUT_MS / 1000}s`;

function firstLine(err) {
  return String((err && err.message) || err).split('\n')[0].slice(0, 200);
}

const leakKinds = { sessions: 'session', tasks: 'task', terminals: 'terminal' };

async function runJourney(j, env, browser, api, projects) {
  if (j.knownBug) return { id: j.id, state: 'NOTRUN', detail: `omitted: known bug ${j.knownBug}` };
  let before;
  try { before = await api.snapshot(projects); } catch (err) {
    return { id: j.id, state: 'BLOCKED', detail: `could not snapshot: ${firstLine(err)}` };
  }
  const contexts = [];
  let lastStep = 'start';
  const jEnv = {
    ...env,
    newPage: async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 800 } }); contexts.push(c); return c.newPage(); },
    step: (label) => { lastStep = label; process.stderr.write(`  ${j.id}: ${label}\n`); },
  };
  let timer;
  const running = Promise.resolve().then(() => j.run(jEnv));
  running.catch(() => {});
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'FAIL', detail: `timed out after ${Math.round(j.timeoutMs / 1000)}s at ${lastStep}` }), j.timeoutMs);
  });
  let result;
  try { result = await Promise.race([running, timeout]); } catch (err) { result = { state: 'FAIL', detail: firstLine(err) }; }
  clearTimeout(timer);
  await Promise.all(contexts.map(c => c.close().catch(() => {})));
  result = result && ['PASS', 'FAIL', 'BLOCKED', 'NOTRUN'].includes(result.state)
    ? { ...result, id: j.id, detail: result.detail || '' }
    : { id: j.id, state: 'FAIL', detail: 'journey returned no result' };
  try {
    const leaked = onlyOutside(added(before, await api.snapshot(projects)));
    const kind = Object.keys(leakKinds).find(k => leaked[k].length);
    if (kind) result = { id: j.id, state: 'FAIL', detail: `left ${leakKinds[kind]} ${leaked[kind][0].id} outside the world` };
  } catch (err) {
    if (result.state === 'PASS') result = { id: j.id, state: 'BLOCKED', detail: `could not snapshot: ${firstLine(err)}` };
  }
  return result;
}

async function run(argv) {
  const home = os.homedir();
  const emit = (...fields) => process.stdout.write(formatLine(home, ...fields) + '\n');
  const log = msg => process.stderr.write(scrub(msg, home) + '\n');
  let toolRoot, opts;
  try {
    toolRoot = await git(__dirname, 'rev-parse', '--show-toplevel');
    opts = parseArgs(argv, { toolRoot });
    opts.world = path.resolve(opts.world);
  } catch (err) {
    process.stderr.write((err.usage ? USAGE : `run from inside an eve checkout: ${firstLine(err)}`) + '\n');
    return 2;
  }
  const toolCommit = await git(toolRoot, 'rev-parse', 'HEAD').catch(() => '');
  const checkout = fs.existsSync(opts.checkout) ? fs.realpathSync(opts.checkout) : path.resolve(opts.checkout);
  const port = Number(new URL(opts.url).port);
  const api = new EveApi(`http://127.0.0.1:${port}`);
  const relayBin = process.env.RELAY_BIN || '/Applications/Relay.app/Contents/MacOS/relay';
  const lsEnv = { env: { ...process.env, LC_ALL: 'C' } };
  let head, pid, cwd, projects, world;

  const checks = [
    ['head', async () => (head = await git(checkout, 'rev-parse', 'HEAD'))],
    ['tree', async () => {
      if (await git(checkout, 'status', '--porcelain', '--untracked-files=no')) throw new Error('tracked files are modified; commit or reset them');
      return 'clean';
    }],
    ['service', async () => {
      const problem = serviceRowProblem(await exec(relayBin, ['service', 'list']), opts.service, opts.url);
      if (problem) throw new Error(problem);
      return `${opts.service} running`;
    }],
    ['eve', async () => {
      const pids = await lsofPids(port);
      pid = pids[0];
      cwd = pids.length === 1 ? await realCwd(pid) : null;
      const ps = field => (pids.length === 1 ? exec('ps', ['-o', `${field}=`, '-p', String(pid)], lsEnv).catch(() => '') : '');
      const problem = eveProcessProblem({
        pids, cwd, checkout, service: opts.service, command: await ps('args'), startedAtMs: parseLstart(await ps('lstart')),
        newestChangeMs: await newestChangeMs(checkout),
      });
      if (problem) throw new Error(problem);
      return `pid ${pid}`;
    }],
    ['live', async () => {
      const livePids = await lsofPids(LIVE_EVE_PORT);
      const liveCwd = livePids.length === 1 ? await realCwd(livePids[0]) : null;
      const problem = liveEveProblem({ port, pid, cwd, livePids, liveCwd });
      if (problem) throw new Error(problem);
      return `separate from :${LIVE_EVE_PORT}`;
    }],
    ['pr', async () => {
      const prHead = await require('./post').prHead(opts.post, { cwd: toolRoot });
      if (prHead !== head) throw new Error(`PR head ${prHead.slice(0, 12)} is not the checkout HEAD`);
      return 'PR head is HEAD';
    }],
    ['api', async () => {
      const entries = JSON.parse(fs.readFileSync(path.join(opts.world, 'data', 'world.json'), 'utf8')).projects;
      projects = await api.worldProjects(entries);
      return projects.map(p => p.name).join(', ');
    }],
    ['browser', async () => {
      const { chromium } = require('@playwright/test');
      await (await chromium.launch()).close();
      return 'chromium';
    }],
    ['bootstrap', async () => {
      const { code, timedOut } = await worldScript(opts.world, 'bootstrap.sh', ['--check']);
      if (timedOut) throw new Error(`bootstrap.sh --check ${timedOutDetail}`);
      if (code !== 0) throw new Error('bootstrap incomplete; run bootstrap.sh');
      return 'complete';
    }],
    ['world', async () => {
      const { code, out, timedOut } = await worldScript(opts.world, 'verify.sh', [], { capture: true });
      process.stderr.write(out);
      if (timedOut) throw new Error(`verify.sh ${timedOutDetail}`);
      try { world = parseWorldSummary(out); } catch { throw new Error('verify.sh printed no summary'); }
      if (code !== 0 || world.fail !== 0) throw new Error('verify.sh is not green');
      return 'green';
    }],
  ];
  for (const [name, check] of checks) {
    if (name === 'pr' && !opts.post) continue;
    try {
      emit('PREFLIGHT', name, 'OK', await check());
    } catch (err) {
      emit('PREFLIGHT', name, 'FAIL', firstLine(err));
      return 2;
    }
  }
  emit('WORLD', `pass=${world.pass}`, `fail=${world.fail}`);

  const sweep = async () => {
    const counts = await api.sweep(projects);
    log(`sweep: sessions=${counts.sessions} tasks=${counts.tasks} terminals=${counts.terminals}`);
  };
  const reset = await worldScript(opts.world, 'reset.sh', []);
  if (reset.timedOut) {
    emit('RESET', 'FAIL', `reset.sh ${timedOutDetail}`);
    return 2;
  }
  try {
    if (reset.code !== 0) throw new Error('reset.sh failed');
    await sweep();
  } catch (err) {
    log(firstLine(err));
    emit('RESET', 'FAIL');
    return 2;
  }
  emit('RESET', 'OK');

  const { journeys } = require('./journeys');
  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const byKey = Object.fromEntries(projects.map(p => [p.key, p]));
  const env = {
    url: opts.url, nonce: crypto.randomBytes(4).toString('hex'), model: process.env.EVE_VERIFY_MODEL || 'Chat',
    projects: { acme: byKey.acme, globex: byKey.globex, home: byKey.home }, api, shared: {},
  };
  const results = [];
  try {
    for (const j of journeys) {
      log(`running ${j.id}`);
      const r = await runJourney(j, env, browser, api, projects);
      results.push(r);
      emit('JOURNEY', r.id, r.state, r.detail);
    }
  } finally {
    await browser.close().catch(() => {});
    await sweep().catch(err => log(`final sweep: ${firstLine(err)}`));
  }

  const { counts, exitCode } = tally(results);
  emit('SUMMARY', `pass=${counts.PASS}`, `fail=${counts.FAIL}`, `blocked=${counts.BLOCKED}`, `notrun=${counts.NOTRUN}`);
  if (opts.post) {
    const { post, statusState } = require('./post');
    try {
      const ev = { pr: opts.post, commit: head, toolCommit, worldSummary: `pass=${world.pass} fail=${world.fail}`, home, results };
      emit('POSTED', statusState(results), await post(ev, { cwd: toolRoot }));
    } catch (err) {
      log(`post failed: ${firstLine(err)}`);
      return 2;
    }
  }
  return exitCode;
}

module.exports = {
  scrub, formatLine, parseArgs, parseWorldSummary, tally, parseListenPids, parseCwd, parseLstart,
  eveProcessProblem, liveEveProblem, serviceRowProblem, run,
};

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    process.stderr.write(scrub(firstLine(err), os.homedir()) + '\n');
    process.exitCode = 2;
  });
}
