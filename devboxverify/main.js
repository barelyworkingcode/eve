const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parse: parseJsonc } = require('jsonc-parser');
const { EveApi, added, onlyOutside } = require('./eve-api');
const { acquire } = require('../scripts/browser-lock');
const {
  WORLD_VERSION, markerPath, readMarker, loadWorld, scoped, missingFixtures,
} = require('./world');

const LIVE_EVE_PORT = 3000;
const SCRIPT_TIMEOUT_MS = 300000;
const REPAIR_TIMEOUT_MS = 900000;
const JOURNEY_BUDGET_MS = 480000;
const MIN_JOURNEY_MS = 1000;
const CLEANUP_TIMEOUT_MS = 10000;
const RESTART_TIMEOUT_MS = 60000;
const OWNER_RESET_WAIT_MS = 30000;
const OWNER_FILES = ['auth.json', 'sessions.json'];
const RELAY_AUDIT_TAIL = '500';
const USAGE = 'usage: node devboxverify/main.js [--checkout DIR] [--url URL] [--service ID] [--post PR] [--screen]';
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
  const opts = {
    checkout: toolRoot, url: 'http://localhost:3100', service: 'eve-verify', post: null, screen: false,
  };
  const names = new Set(['checkout', 'url', 'service', 'post']);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(argv[i]);
    if (m && m[1] === 'screen') {
      if (m[2] !== undefined) throw usageError('--screen takes no value');
      opts.screen = true;
      continue;
    }
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

// repair.sh's stdout, read as devboxWorld's docs/WORLD.md pins it. The harness
// adds the prefix and maps lines; repair.sh writes every detail.
function parseRepair(stdout, { code, timedOut }) {
  const checks = { bootstrap: {}, world: {} };
  const repaired = [];
  for (const line of String(stdout).split('\n')) {
    const f = line.replace(/\r$/, '').split('\t');
    if (f[0] === 'CHECK' && f.length === 4 && (f[1] === 'bootstrap' || f[1] === 'world') && (f[2] === 'OK' || f[2] === 'FAIL')) {
      const c = checks[f[1]];
      if (f[2] === 'OK') c.ok = f[3];
      else if (c.fail === undefined) c.fail = f[3];
    } else if (f[0] === 'REPAIRED' && f.length === 3) {
      repaired.push({ what: f[1], detail: f[2] });
    }
  }
  const how = timedOut ? `timed out after ${REPAIR_TIMEOUT_MS / 1000}s` : `exited ${code}`;
  const blocked = detail => ({ ok: false, detail: `BLOCKED environment: ${detail}` });
  const { bootstrap: b, world: w } = checks;
  let summary = null;
  try { summary = parseWorldSummary(stdout); } catch { /* no valid SUMMARY: 0/0 */ }
  // A FAIL line wins over everything; an OK line counts only with a clean exit and fail=0.
  const green = w.ok !== undefined && code === 0 && !timedOut && summary !== null && summary.fail === 0;
  return {
    bootstrap: b.fail !== undefined ? blocked(b.fail)
      : b.ok !== undefined ? { ok: true, detail: b.ok }
        : blocked(`bootstrap incomplete; repair.sh ${how} without a result; run bootstrap.sh`),
    world: w.fail !== undefined ? blocked(w.fail)
      : green ? { ok: true, detail: w.ok } : blocked(`repair.sh ${how} without a result`),
    repaired,
    pass: summary ? summary.pass : 0,
    fail: summary ? summary.fail : 0,
  };
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
  const row = serviceRow(listOut, service);
  if (!row) return `no ${service} row in relay service list; register it (see devboxverify/README.md)`;
  if (!row.includes(url)) return `${service} is not registered with --url ${url}`;
  if (row[row.length - 1] !== 'running') return `${service} is ${row[row.length - 1]}; relay service restart --id ${service}`;
  return null;
}

function serviceRow(listOut, service) {
  return String(listOut).split('\n').map(l => l.trim().split(/\s+/)).find(t => t[0] === service) || null;
}

// The --data dir from the service row's command, or null. The row is split on
// whitespace, so a dir with a space in it reads as missing.
function pinnedDataDir(listOut, service = 'eve-verify') {
  const row = serviceRow(listOut, service);
  const at = row ? row.indexOf('--data') : -1;
  const dir = at >= 0 ? row[at + 1] : null;
  return dir && path.isAbsolute(dir) ? path.normalize(dir) : null;
}

// Where the live eve keeps its data: the `eve` row's --data against the live
// eve's cwd, else `<cwd>/data`. server.js defaults to its own directory, which
// is the cwd when the service's workdir is its checkout. Null when neither
// can be known.
function liveDataDir(listOut, liveCwd) {
  const row = serviceRow(listOut, 'eve');
  const at = row ? row.indexOf('--data') : -1;
  const dir = at >= 0 ? row[at + 1] : null;
  if (dir && path.isAbsolute(dir)) return path.normalize(dir);
  if (!liveCwd) return null;
  return dir ? path.resolve(liveCwd, dir) : path.join(liveCwd, 'data');
}

function authStatusProblem(status) {
  if (!status || typeof status !== 'object') return 'GET /api/auth/status answered no status';
  if (status.trusted === true) return 'loopback is trusted; register eve-verify with EVE_DISABLE_SUBNET_BYPASS=1';
  return null;
}

// Chief of Staff's daily call count and log live in the pinned dir; a run starts from none,
// so sessions run between runs cannot use up the limit. Same guard as the owner reset.
function chiefOfStaffResetPaths(dir, opts) {
  ownerResetPaths(dir, opts);
  return ['chief-of-staff-state.json', 'chief-of-staff.jsonl'].map(f => path.join(dir, f));
}

// Exactly the two owner files in the pinned dir, and only when that dir is
// not the live eve's own data dir.
function ownerResetPaths(dir, { liveDataDir = null } = {}) {
  if (!dir || !path.isAbsolute(dir) || path.normalize(dir) !== dir) throw new Error(`refusing to reset a data dir that is not a normalised absolute path`);
  if (liveDataDir && path.normalize(liveDataDir) === dir) throw new Error('the pinned data dir is the live eve\'s; refusing to reset it');
  return OWNER_FILES.map(f => path.join(dir, f));
}

// Fixture journeys run first, screen journeys last. Without --screen the
// screen journeys are skipped and reported NOTRUN.
function orderJourneys(journeys, { screen }) {
  const fixtures = journeys.filter(j => j.fixture);
  const plain = journeys.filter(j => !j.fixture && !j.screen);
  const onScreen = journeys.filter(j => !j.fixture && j.screen);
  return screen
    ? { run: [...fixtures, ...plain, ...onScreen], skipped: [] }
    : { run: [...fixtures, ...plain], skipped: onScreen };
}

// machine, pin and fixtures, in that order, stopping at the first FAIL. It
// takes no lock and runs no script or network call; the only process it
// starts is isVM's sysctl. `world` is null after a FAIL.
function worldPreflight({ markerFile, isVM, journeys, screen }) {
  const lines = [];
  const failed = (check, detail) => {
    lines.push([check, 'FAIL', firstLine(detail)]);
    return { lines, world: null };
  };
  let marker;
  try {
    marker = readMarker(markerFile, { isVM });
  } catch (err) {
    return failed('machine', firstLine(err));
  }
  lines.push(['machine', 'OK', `vm; world v${marker.world_version}`]);
  if (marker.world_version !== WORLD_VERSION) {
    return failed('pin', `BLOCKED fixture: this machine's world is v${marker.world_version}; eve needs v${WORLD_VERSION}`);
  }
  lines.push(['pin', 'OK', `v${WORLD_VERSION}`]);
  let world;
  try {
    world = loadWorld(marker);
  } catch (err) {
    return failed('fixtures', `BLOCKED fixture: ${err.message}`);
  }
  const selected = orderJourneys(journeys, { screen }).run.filter(j => !j.knownBug);
  const missing = missingFixtures(selected, world);
  if (missing.length) return failed('fixtures', `BLOCKED fixture: ${missing.join('; ')}`);
  const needed = new Set(selected.flatMap(j => j.needs || []));
  lines.push(['fixtures', 'OK', `${needed.size} fixtures for ${selected.length} journeys`]);
  return { lines, world };
}

// A journey sees only the fixtures it declared. env.projects is the same view
// with each entry cut to name and path, plus id once the api check has run;
// an undeclared key throws as the view does.
function journeyWorld(world, needs) {
  const view = scoped(world, needs || []);
  const projects = new Proxy(view.projects, {
    get(_, key) {
      if (typeof key === 'symbol') return undefined;
      const p = view.projects[key];
      const entry = { name: p.name, path: p.path === undefined ? p.folder : p.path };
      return p.id === undefined ? entry : { ...entry, id: p.id };
    },
  });
  return { world: view, projects };
}

// Fixture setup (docs/design-devboxverify.md): the Chief of Staff journeys need
// eve-verify to run the model on Haiku in the world's Acme project. Reads the
// settings text as JSONC and keeps every other key; refuses text that does not
// parse rather than overwrite it. Comments do not survive the rewrite.
function chiefOfStaffSettings(text, projectId) {
  if (typeof projectId !== 'string' || !projectId) throw new Error('no project id for the Chief of Staff settings');
  let doc = {};
  if (text && text.trim()) {
    const errors = [];
    doc = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length || !doc || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('settings.json is not a JSON object; not overwriting it');
    }
  }
  const own = doc.chiefOfStaff && typeof doc.chiefOfStaff === 'object' && !Array.isArray(doc.chiefOfStaff) ? doc.chiefOfStaff : {};
  return JSON.stringify({ ...doc, chiefOfStaff: { ...own, model: 'haiku', projectId, dailyModelCalls: 40 } }, null, 2) + '\n';
}

// Setup V-COS (README): the Chief of Staff's own project, "Verify Chief of
// Staff", holds exactly one MCP grant, the eve-cos registration for eve-verify.
// `grantOut` and `mcpOut` are the texts of `relay grant --json` and `relay mcp
// list`. A failed call (an Error) or unreadable grant JSON throws, so the
// preflight fails as it always did. A readable answer that is wrong returns a
// BLOCKED detail ('' when the setup is right) and the project's id when exactly
// one has the name.
const COS_PROJECT = 'Verify Chief of Staff';
const COS_MCP = 'relay-eve-cos-verify';
function chiefOfStaffSetup(grantOut, mcpOut) {
  if (grantOut instanceof Error) throw new Error(`relay grant --json failed: ${firstLine(grantOut)}`);
  if (mcpOut instanceof Error) throw new Error(`relay mcp list failed: ${firstLine(mcpOut)}`);
  let views;
  try { views = JSON.parse(grantOut); } catch { throw new Error('relay grant printed unreadable JSON'); }
  if (!Array.isArray(views)) throw new Error('relay grant printed unreadable JSON');
  const blocked = (what, projectId = '') => ({ projectId, problem: `setup V-COS: ${what}; see devboxverify/README.md` });
  const hits = views.filter(v => v && v.kind === 'project' && v.name === COS_PROJECT && typeof v.id === 'string' && v.id);
  if (hits.length !== 1) return blocked(`${hits.length} projects named "${COS_PROJECT}", want 1`);
  const projectId = hits[0].id;
  const granted = (Array.isArray(hits[0].mcps) ? hits[0].mcps : []).map(m => (m && m.mcp) || '?');
  if (granted.length !== 1 || granted[0] !== COS_MCP) {
    return blocked(`"${COS_PROJECT}" is granted [${granted.join(', ')}], want exactly [${COS_MCP}]`, projectId);
  }
  if (!String(mcpOut).split('\n').some(line => line.trim().split(/\s+/)[0] === COS_MCP)) {
    return blocked(`relay mcp list has no MCP ${COS_MCP}`, projectId);
  }
  return { projectId, problem: '' };
}

// Source check for setup V-COS: eve logs `Chief of Staff config from <source>:
// project <id|automatic>, ...` at its first read. When relay is the source and
// holds another project than V-COS, the Chief of Staff journeys would not run
// in it. '' when the setup is right, else the BLOCKED detail.
function chiefOfStaffSourceProblem(logText, projectId) {
  const m = /Chief of Staff config from (relay|settings\.json|defaults): project ([^\s,]+),/.exec(String(logText));
  if (!m) return 'setup V-COS: eve-verify logged no "Chief of Staff config from" line after its restart; see devboxverify/README.md';
  if (m[1] === 'relay' && m[2] !== projectId) {
    return 'setup V-COS: relay holds a Chief of Staff setting; set it to Not set in relay\'s Settings';
  }
  return '';
}

function journeyTimeout(timeoutMs, spentMs, budgetMs) {
  const left = budgetMs - spentMs;
  return left < MIN_JOURNEY_MS ? null : Math.min(timeoutMs, left);
}

function relayAuditRows(jsonl, { path: want, sinceMs }) {
  const rows = [];
  for (const line of String(jsonl).split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o && o.ts);
    if (!o || o.path !== want || !(ts >= sinceMs)) continue;
    rows.push({ ts, credId: (o.actor && o.actor.cred_id) || '', method: o.method || '', path: o.path, outcome: o.outcome || '' });
  }
  return rows;
}

// Read-only. A file that shrank since the mark (rotated) is read from the start.
function serviceLogReader(file) {
  const size = () => fs.promises.stat(file).then(s => s.size, () => 0);
  return {
    mark: size,
    since: async (mark) => {
      let fh;
      try { fh = await fs.promises.open(file, 'r'); } catch { return ''; }
      try {
        const { size: end } = await fh.stat();
        const from = end < mark ? 0 : mark;
        const buf = Buffer.alloc(end - from);
        await fh.read(buf, 0, buf.length, from);
        return buf.toString('utf8');
      } finally {
        await fh.close();
      }
    },
  };
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
function worldScript(checkout, name, args, { capture = false, timeoutMs = SCRIPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(path.join(checkout, name), args, { cwd: checkout, stdio: ['ignore', capture ? 'pipe' : 2, 'inherit'] });
    let out = '';
    let code = -1;
    let timedOut = false;
    if (capture) child.stdout.on('data', d => { out += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); child.stdout?.destroy(); }, timeoutMs);
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

const CHROMIUM_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

async function audioProblem(browser, { timeoutMs = 5000 } = {}) {
  const page = await browser.newPage();
  const creating = page.evaluate(() => { const c = new AudioContext(); return c.state; });
  // A wedged renderer never settles this; it rejects later, when the caller closes the browser.
  creating.catch(() => {});
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    if (await Promise.race([creating, timeout]) === 'timeout') {
      return `new AudioContext() did not return within ${timeoutMs / 1000}s; the host audio stack is wedged (restart coreaudiod)`;
    }
    return null;
  } catch (err) {
    return `new AudioContext() failed: ${firstLine(err)}`;
  } finally {
    clearTimeout(timer);
  }
}

const leakKinds = { sessions: 'session', tasks: 'task', terminals: 'terminal' };
const VIEWPORT = { width: 1280, height: 800 };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Each cleanup gets its own time limit; the first failure is reported.
async function runCleanups(entries) {
  let failure = null;
  for (const { label, fn, timeoutMs = CLEANUP_TIMEOUT_MS } of entries) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    });
    try {
      await Promise.race([Promise.resolve().then(fn), timeout]);
    } catch (err) {
      failure = failure || `cleanup ${label} failed: ${firstLine(err)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return failure;
}

function takeCleanups(pending, id) {
  const mine = pending.filter(c => c.id === id);
  for (const c of mine) pending.splice(pending.indexOf(c), 1);
  return mine;
}

// `projects` is null for the fixture journeys, which run before the world
// projects are known and create nothing in them, so they get no leak check.
// `world` is the loaded world for them and the resolved one (id, path) after.
async function runJourney(j, env, browser, { timeoutMs, projects, world, pending, screen, log }) {
  if (j.knownBug) return { id: j.id, state: 'NOTRUN', detail: `omitted: known bug ${j.knownBug}` };
  if (timeoutMs === null) return { id: j.id, state: 'BLOCKED', detail: 'run budget spent' };
  const api = env.api;
  let before = null;
  if (projects) {
    try { before = await api.snapshot(projects); } catch (err) {
      return { id: j.id, state: 'BLOCKED', detail: `could not snapshot: ${firstLine(err)}` };
    }
  }
  const contexts = [];
  let lastStep = 'start';
  const jEnv = {
    ...env,
    ...(world ? journeyWorld(world, j.needs) : {}),
    browser,
    screen: j.screen ? screen : null,
    newPage: async ({ signedIn = true, device = {} } = {}) => {
      const state = signedIn && env.session ? { storageState: env.session.storageState } : {};
      const c = await browser.newContext({ viewport: VIEWPORT, ...device, ...state });
      contexts.push(c);
      return c.newPage();
    },
    step: (label) => { lastStep = label; process.stderr.write(`  ${j.id}: ${label}\n`); },
    // A journey that timed out can still register one; runLocked runs those.
    cleanup: (label, fn, timeoutMs) => { pending.push({ id: j.id, label, fn, timeoutMs }); },
  };
  // This is subtle: the sign-in fixture sets env.session, and a spread copy
  // would keep that to itself. The accessor carries it back to the run.
  Object.defineProperty(jEnv, 'session', { get: () => env.session, set: (v) => { env.session = v; }, enumerable: true });
  let timer;
  const running = Promise.resolve().then(() => j.run(jEnv));
  running.catch(() => {});
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'FAIL', detail: `timed out after ${Math.round(timeoutMs / 1000)}s at ${lastStep}` }), timeoutMs);
  });
  let result;
  try {
    result = await Promise.race([running, timeout]);
  } catch (err) {
    result = err && err.code === 'EUNDECLARED' ? { state: 'BLOCKED', detail: err.message } : { state: 'FAIL', detail: firstLine(err) };
  }
  clearTimeout(timer);
  await Promise.all(contexts.map(c => c.close().catch(() => {})));
  const cleanupFailure = await runCleanups(takeCleanups(pending, j.id));
  result = result && ['PASS', 'FAIL', 'BLOCKED', 'NOTRUN'].includes(result.state)
    ? { ...result, id: j.id, detail: result.detail || '' }
    : { id: j.id, state: 'FAIL', detail: 'journey returned no result' };
  if (cleanupFailure) {
    log(`${j.id}: ${cleanupFailure}`);
    if (result.state === 'PASS') result = { id: j.id, state: 'FAIL', detail: cleanupFailure };
  }
  if (!before) return result;
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
  const startedAt = performance.now();
  const home = os.homedir();
  const emit = (...fields) => process.stdout.write(formatLine(home, ...fields) + '\n');
  const log = msg => process.stderr.write(scrub(msg, home) + '\n');
  let toolRoot, opts;
  try {
    toolRoot = await git(__dirname, 'rev-parse', '--show-toplevel');
    opts = parseArgs(argv, { toolRoot });
  } catch (err) {
    process.stderr.write((err.usage ? USAGE : `run from inside an eve checkout: ${firstLine(err)}`) + '\n');
    return 2;
  }
  // Deliberate: before the lock and before any script or network call, so a
  // machine that is not a bootstrapped VM is never touched.
  const { journeys } = require('./journeys');
  const { lines, world } = worldPreflight({ markerFile: markerPath(process.env, home), journeys, screen: opts.screen });
  for (const [check, state, detail] of lines) emit('PREFLIGHT', check, state, detail);
  if (!world) return 2;
  let release;
  try {
    release = await acquire({ command: scrub(['devboxverify/main.js', ...argv].join(' '), home), log });
  } catch (err) {
    emit('PREFLIGHT', 'lock', 'FAIL', firstLine(err));
    return 2;
  }
  emit('PREFLIGHT', 'lock', 'OK', 'acquired');
  try {
    return await runLocked({ home, emit, log, toolRoot, opts, world, journeys, startedAt });
  } finally {
    await release();
  }
}

async function runLocked({ home, emit, log, toolRoot, opts, world, journeys, startedAt }) {
  const toolCommit = await git(toolRoot, 'rev-parse', 'HEAD').catch(() => '');
  const checkout = fs.existsSync(opts.checkout) ? fs.realpathSync(opts.checkout) : path.resolve(opts.checkout);
  const port = Number(new URL(opts.url).port);
  const base = `http://127.0.0.1:${port}`;
  const anonymous = new EveApi(base);
  const relayBin = process.env.RELAY_BIN || '/Applications/Relay.app/Contents/MacOS/relay';
  const lsEnv = { env: { ...process.env, LC_ALL: 'C' } };
  let head, pid, cwd, liveCwd, listOut, dataDir, projects, worldCounts, repair;
  let cosSetup = { projectId: '', problem: '' };
  const eveLog = serviceLogReader(path.join(home, 'Library', 'Application Support', 'Relay', 'logs', `${opts.service}.log`));

  const checks = [
    ['head', async () => (head = await git(checkout, 'rev-parse', 'HEAD'))],
    ['tree', async () => {
      if (await git(checkout, 'status', '--porcelain', '--untracked-files=no')) throw new Error('tracked files are modified; commit or reset them');
      return 'clean';
    }],
    ['service', async () => {
      listOut = await exec(relayBin, ['service', 'list']);
      const problem = serviceRowProblem(listOut, opts.service, opts.url);
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
      dataDir = pinnedDataDir(listOut, opts.service);
      if (!dataDir) throw new Error(`${opts.service} has no absolute --data dir; register it as in devboxverify/README.md`);
      const statusProblem = authStatusProblem(await anonymous.authStatus());
      if (statusProblem) throw new Error(statusProblem);
      return `pid ${pid}`;
    }],
    ['live', async () => {
      const livePids = await lsofPids(LIVE_EVE_PORT);
      liveCwd = livePids.length === 1 ? await realCwd(livePids[0]) : null;
      const problem = liveEveProblem({ port, pid, cwd, livePids, liveCwd });
      if (problem) throw new Error(problem);
      return `separate from :${LIVE_EVE_PORT}`;
    }],
    ['pr', async () => {
      const prHead = await require('./post').prHead(opts.post, { cwd: toolRoot });
      if (prHead !== head) throw new Error(`PR head ${prHead.slice(0, 12)} is not the checkout HEAD`);
      return 'PR head is HEAD';
    }],
    ['browser', async () => {
      const { chromium } = require('@playwright/test');
      await (await chromium.launch()).close();
      return 'chromium';
    }],
    ['audio', async () => {
      const { chromium } = require('@playwright/test');
      const browser = await chromium.launch({ args: CHROMIUM_ARGS });
      let problem;
      try { problem = await audioProblem(browser); } finally { await browser.close().catch(() => {}); }
      if (problem) throw new Error(problem);
      return 'AudioContext running';
    }],
    // One repair.sh call serves both checks: it verifies, and on a red world
    // resets once and verifies again (devboxWorld#13).
    ['bootstrap', async () => {
      const result = await worldScript(world.checkout, 'repair.sh', [], { capture: true, timeoutMs: REPAIR_TIMEOUT_MS });
      process.stderr.write(result.out);
      repair = parseRepair(result.out, result);
      worldCounts = { pass: repair.pass, fail: repair.fail };
      if (!repair.bootstrap.ok) throw new Error(repair.bootstrap.detail);
      return repair.bootstrap.detail;
    }],
    ['world', async () => {
      for (const { what, detail } of repair.repaired) emit('REPAIRED', what, detail);
      if (!repair.world.ok) throw new Error(repair.world.detail);
      return repair.world.detail;
    }],
    // Deliberate: this deletes eve-verify's owner so the run can enrol its
    // own. Only the two owner files in the pinned dir, never the live eve's.
    ['owner', async () => {
      const real = dir => (dir && fs.existsSync(dir) ? fs.realpathSync(dir) : dir);
      const files = ownerResetPaths(real(dataDir), { liveDataDir: real(liveDataDir(listOut, liveCwd)) });
      for (const f of files) await fs.promises.rm(f, { force: true });
      for (const f of chiefOfStaffResetPaths(path.dirname(files[0]), { liveDataDir: real(liveDataDir(listOut, liveCwd)) })) await fs.promises.rm(f, { force: true });
      // The one settings write: fixture setup for the Chief of Staff journeys, in the pinned dir only.
      const settingsFile = path.join(path.dirname(files[0]), 'settings.json');
      // Read once, as completed CLI calls. A failed call or unreadable JSON throws and fails the preflight;
      // a readable but wrong setup blocks the Chief of Staff journeys, not the run.
      const grantOut = await exec(relayBin, ['grant', '--json'], { timeout: 20000 }).catch((err) => err);
      const mcpOut = await exec(relayBin, ['mcp', 'list'], { timeout: 20000 }).catch((err) => err);
      cosSetup = chiefOfStaffSetup(grantOut, mcpOut);
      if (cosSetup.projectId) {
        const current = await fs.promises.readFile(settingsFile, 'utf8').catch((err) => { if (err.code === 'ENOENT') return ''; throw err; });
        await fs.promises.writeFile(settingsFile, chiefOfStaffSettings(current, cosSetup.projectId));
      }
      const logMark = await eveLog.mark();
      await exec(relayBin, ['service', 'restart', '--id', opts.service], { timeout: RESTART_TIMEOUT_MS });
      const deadline = performance.now() + OWNER_RESET_WAIT_MS;
      let status = null;
      while (!status) {
        const pids = await lsofPids(port);
        if (pids.length === 1 && pids[0] !== pid) status = await anonymous.authStatus().catch(() => null);
        if (status) break;
        if (performance.now() > deadline) throw new Error(`${opts.service} did not answer on :${port} within ${OWNER_RESET_WAIT_MS / 1000}s of the restart`);
        await sleep(500);
      }
      const problem = authStatusProblem(status);
      if (problem) throw new Error(problem);
      if (status.enrolled !== false) throw new Error('eve still has an owner after the reset');
      // Waits: none possible. eve's log is a file with no hook, so it is polled
      // against a monotonic deadline.
      if (!cosSetup.problem) {
        const logDeadline = performance.now() + OWNER_RESET_WAIT_MS;
        let logged;
        for (;;) {
          logged = await eveLog.since(logMark);
          if (/Chief of Staff config from /.test(logged) || performance.now() > logDeadline) break;
          await sleep(500);
        }
        cosSetup.problem = chiefOfStaffSourceProblem(logged, cosSetup.projectId);
      }
      return cosSetup.projectId ? 'owner removed; not enrolled; Chief of Staff settings written'
        : 'owner removed; not enrolled; Chief of Staff settings not written';
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

  let api = anonymous;
  const sweep = async () => {
    const counts = await api.sweep(projects);
    log(`sweep: sessions=${counts.sessions} tasks=${counts.tasks} terminals=${counts.terminals}`);
  };
  const { run: ordered, skipped } = orderJourneys(journeys, opts);
  const { chromium } = require('@playwright/test');
  const { createScreen } = require('./screen');
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const env = {
    url: opts.url, nonce: crypto.randomBytes(4).toString('hex'), model: process.env.EVE_VERIFY_MODEL || 'Chat',
    api, shared: {}, session: null, cosSetupProblem: cosSetup.problem, relayBin, service: opts.service, dataDir,
    serviceLog: eveLog,
    relayAudit: async ({ path: want, sinceMs }) => relayAuditRows(
      await exec(relayBin, ['audit', '-json', '-tail', RELAY_AUDIT_TAIL, '-grep', want]), { path: want, sinceMs }),
  };
  const screen = opts.screen ? createScreen() : null;
  const results = [];
  const pending = [];
  let spentMs = 0;
  let resolved = null;
  // A record made without running the journey times at 0.
  const record = (r, ms = 0) => {
    results.push(r);
    emit('JOURNEY', r.id, r.state, r.detail);
    emit('TIMING', 'journey', r.id, String(Math.trunc(ms)));
  };
  const runOne = async (j) => {
    log(`running ${j.id}`);
    const journeyStartedAt = performance.now();
    const timeoutMs = journeyTimeout(j.timeoutMs, spentMs, JOURNEY_BUDGET_MS);
    const r = await runJourney(j, env, browser, {
      timeoutMs, projects: j.fixture ? null : projects, world: j.fixture ? world : resolved, pending, screen, log,
    });
    const tookMs = Math.round(performance.now() - journeyStartedAt);
    record(r, j.knownBug || timeoutMs === null ? 0 : tookMs);
    spentMs += tookMs;
  };
  let failedEarly = false;
  try {
    for (const j of ordered.filter(j => j.fixture)) await runOne(j);
    const rest = ordered.filter(j => !j.fixture);
    const signedIn = results.every(r => r.state === 'PASS') && !!(env.session && env.session.token);
    if (!signedIn) {
      for (const j of rest) record({ id: j.id, state: 'BLOCKED', detail: 'no signed-in owner' });
    } else {
      api = new EveApi(base, { token: env.session.token });
      env.api = api;
      try {
        projects = await api.worldProjects(Object.values(world.projects));
        emit('PREFLIGHT', 'api', 'OK', projects.map(p => p.name).join(', '));
      } catch (err) {
        emit('PREFLIGHT', 'api', 'FAIL', firstLine(err));
        failedEarly = true;
        return 2;
      }
      resolved = {
        ...world,
        projects: Object.fromEntries(projects.map(p => [p.key, { ...world.projects[p.key], id: p.id, path: p.path }])),
      };
      emit('WORLD', `pass=${worldCounts.pass}`, `fail=${worldCounts.fail}`);
      const reset = await worldScript(world.checkout, 'reset.sh', []);
      if (reset.timedOut) {
        emit('RESET', 'FAIL', `reset.sh ${timedOutDetail}`);
        failedEarly = true;
        return 2;
      }
      try {
        if (reset.code !== 0) throw new Error('reset.sh failed');
        await sweep();
      } catch (err) {
        log(firstLine(err));
        emit('RESET', 'FAIL');
        failedEarly = true;
        return 2;
      }
      emit('RESET', 'OK');
      for (const j of rest) await runOne(j);
    }
    for (const j of skipped) record({ id: j.id, state: 'NOTRUN', detail: 'screen journey; run with --screen' });
  } finally {
    await browser.close().catch(() => {});
    const late = await runCleanups(pending.splice(0));
    if (late) log(late);
    if (projects && !failedEarly) await sweep().catch(err => log(`final sweep: ${firstLine(err)}`));
  }

  const { counts, exitCode } = tally(results);
  const runMs = Math.round(performance.now() - startedAt);
  emit('TIMING', 'run', String(runMs));
  emit('SUMMARY', `pass=${counts.PASS}`, `fail=${counts.FAIL}`, `blocked=${counts.BLOCKED}`, `notrun=${counts.NOTRUN}`);
  if (opts.post) {
    const { post, statusState } = require('./post');
    try {
      const ev = {
        pr: opts.post, commit: head, toolCommit, runMs, worldSummary: `pass=${worldCounts.pass} fail=${worldCounts.fail}`,
        repaired: repair.repaired, home, results,
      };
      emit('POSTED', statusState(results), await post(ev, { cwd: toolRoot }));
    } catch (err) {
      log(`post failed: ${firstLine(err)}`);
      return 2;
    }
  }
  return exitCode;
}

module.exports = {
  scrub, formatLine, parseArgs, parseWorldSummary, parseRepair, REPAIR_TIMEOUT_MS, tally, parseListenPids, parseCwd, parseLstart,
  eveProcessProblem, liveEveProblem, serviceRowProblem, audioProblem, run, runJourney, worldPreflight,
  JOURNEY_BUDGET_MS, orderJourneys, journeyTimeout, pinnedDataDir, liveDataDir, authStatusProblem, ownerResetPaths,
  relayAuditRows, serviceLogReader, chiefOfStaffSourceProblem, chiefOfStaffSettings, chiefOfStaffResetPaths, chiefOfStaffSetup,
};

if (require.main === module) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; }, (err) => {
    process.stderr.write(scrub(firstLine(err), os.homedir()) + '\n');
    process.exitCode = 2;
  });
}
