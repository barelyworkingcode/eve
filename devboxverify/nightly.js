'use strict';
// Installed as a standalone copy under ~/.local/share/devboxverify/: Node core only,
// no require of any repo file.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const NPM_CI_TIMEOUT_MS = 10 * 60 * 1000;
const RESTART_TIMEOUT_MS = 60 * 1000;
const PORT_WAIT_MS = 60 * 1000;
const EVE_VERIFY_PORT = 3100;
const EVE_VERIFY_SERVICE = 'eve-verify';
const OUTPUT_CAP = 8 * 1024 * 1024;
const HISTORY_ROWS = 60;

function classify({ exitCode, timedOut, blockedReason }) {
  if (blockedReason || timedOut) return 'BLOCKED';
  if (exitCode === 0) return 'GREEN';
  if (exitCode === 1) return 'RED';
  return 'BLOCKED';
}

function summaryOf(stdout) {
  const lines = String(stdout || '').split(/\r?\n/);
  const summaries = lines.filter((l) => l.startsWith('SUMMARY\t'));
  const line = summaries.length ? summaries[summaries.length - 1]
    : lines.find((l) => /^PREFLIGHT\t[^\t]+\tFAIL/.test(l));
  return line ? line.replace(/\t/g, ' ') : 'no summary';
}

function oneLine(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function formatRecord({ at, repo, result, commit, behind, summary }) {
  const sha = oneLine(commit).slice(0, 12) || '-';
  const n = Number.isInteger(behind) ? behind : 0;
  return ['NIGHT', oneLine(at), oneLine(repo), oneLine(result), sha, `behind=${n}`, oneLine(summary)].join('\t');
}

function parseRecords(logText) {
  const records = [];
  for (const line of String(logText || '').split(/\r?\n/)) {
    const f = line.split('\t');
    if (f[0] !== 'NIGHT' || f.length < 7) continue;
    const m = /^behind=(\d+)$/.exec(f[5]);
    records.push({ at: f[1], repo: f[2], result: f[3], commit: f[4], behind: m ? Number(m[1]) : 0, summary: f.slice(6).join(' ') });
  }
  return records;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function row(r) {
  const cls = /^(GREEN|RED|BLOCKED)$/.test(r.result) ? r.result.toLowerCase() : 'other';
  return `<tr class="${esc(cls)}"><td>${esc(r.at)}</td><td>${esc(r.repo)}</td><td class="result">${esc(r.result)}</td>`
    + `<td><code>${esc(r.commit)}</code></td><td>${esc(r.behind)}</td><td>${esc(r.summary)}</td></tr>`;
}

function table(rows) {
  const head = '<tr><th>At</th><th>Repo</th><th>Result</th><th>Commit</th><th>Behind</th><th>Summary</th></tr>';
  return `<table>${head}${rows.map(row).join('')}</table>`;
}

function renderStatusPage(records, { now }) {
  const sorted = [...records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const latest = [];
  const seen = new Set();
  for (const r of sorted) {
    if (!seen.has(r.repo)) { seen.add(r.repo); latest.push(r); }
  }
  const stamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>devboxverify nightly</title>
<style>
body{font:14px -apple-system,sans-serif;margin:2em}table{border-collapse:collapse;margin-bottom:2em}
td,th{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}
tr.green .result{background:#d4f7d4}tr.red .result{background:#f7c6c6;font-weight:bold}
tr.blocked .result{background:#f7e3b0;font-weight:bold}
</style></head><body>
<h1>devboxverify nightly</h1>
<p>Generated ${esc(stamp)}</p>
<h2>Latest per repo</h2>
${table(latest)}
<h2>Last ${HISTORY_ROWS} nights</h2>
${table(sorted.slice(0, HISTORY_ROWS))}
</body></html>
`;
}

// Runs a child in its own process group so a timeout kills the whole tree
// (go run's compiled binary, main.js), not just the direct child. Chromium is
// not caught by the group kill: Playwright starts it in its own process group
// and closes it from its own exit handler when main.js dies.
function runChild(cmd, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout, stderr: String(err.message), timedOut, error: err.message });
      return;
    }
    const append = (buf, chunk) => (buf.length < OUTPUT_CAP ? buf + chunk : buf);
    child.stdout.on('data', (c) => { stdout = append(stdout, c); });
    child.stderr.on('data', (c) => { stderr = append(stderr, c); });
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 10000).unref();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + err.message, timedOut, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, error: null });
    });
  });
}

function portListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(2000);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

async function waitForPort(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portListening(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

class Night {
  constructor(repo, checkout) {
    this.repo = repo;
    this.checkout = checkout;
    this.log = [];
    this.behind = 0;
  }

  async step(cmd, args, opts = {}) {
    const res = await runChild(cmd, args, { cwd: this.checkout, timeoutMs: GIT_TIMEOUT_MS, ...opts });
    this.log.push(`$ ${cmd} ${args.join(' ')}  -> ${res.timedOut ? 'timed out' : `exit ${res.code}`}`, res.stdout, res.stderr);
    return res;
  }

  async git(...args) {
    return this.step('git', ['-C', this.checkout, ...args]);
  }

  async head() {
    const r = await this.git('rev-parse', 'HEAD');
    return r.code === 0 ? r.stdout.trim() : '';
  }

  async countBehind() {
    const r = await this.git('rev-list', '--count', 'HEAD..origin/main');
    if (r.code === 0) this.behind = Number(r.stdout.trim()) || 0;
  }
}

async function prepareRelay(night) {
  if ((await night.git('fetch', '--quiet', 'origin')).code !== 0) return 'git fetch origin failed';
  if ((await night.git('merge-base', '--is-ancestor', 'HEAD', 'origin/main')).code !== 0) return 'HEAD is not an ancestor of origin/main';
  await night.countBehind();
  return null;
}

async function prepareEve(night) {
  if ((await night.git('fetch', '--quiet', 'origin')).code !== 0) return 'git fetch origin failed';
  const dirty = await night.git('status', '--porcelain', '--untracked-files=no');
  if (dirty.code !== 0 || dirty.stdout.trim()) return 'worktree is not clean';
  if ((await night.git('symbolic-ref', '-q', 'HEAD')).code !== 0) return 'worktree is not on a branch';
  if ((await night.git('merge-base', '--is-ancestor', 'HEAD', 'origin/main')).code !== 0) return 'branch cannot fast-forward to origin/main';
  await night.countBehind();
  const lockBefore = await night.git('rev-parse', 'HEAD:package-lock.json');
  if ((await night.git('merge', '--ff-only', 'origin/main')).code !== 0) return 'git merge --ff-only origin/main failed';
  night.behind = 0;
  const lockAfter = await night.git('rev-parse', 'HEAD:package-lock.json');
  if (lockBefore.stdout.trim() !== lockAfter.stdout.trim()) {
    const ci = await night.step('npm', ['ci'], { timeoutMs: NPM_CI_TIMEOUT_MS });
    if (ci.code !== 0) return ci.timedOut ? 'npm ci timed out' : 'npm ci failed';
  }
  const relayBin = process.env.RELAY_BIN || '/Applications/Relay.app/Contents/MacOS/relay';
  const restart = await night.step(relayBin, ['service', 'restart', '--id', EVE_VERIFY_SERVICE], { timeoutMs: RESTART_TIMEOUT_MS });
  if (restart.code !== 0) return `relay service restart --id ${EVE_VERIFY_SERVICE} failed`;
  if (!(await waitForPort(EVE_VERIFY_PORT, PORT_WAIT_MS))) return `port ${EVE_VERIFY_PORT} not listening after 60s`;
  if (!fs.existsSync(path.join(night.checkout, 'devboxverify', 'main.js'))) return 'no devboxverify/main.js in the checkout';
  return null;
}

async function runNight(repo, checkout, at, logDir) {
  const envName = `NIGHTLY_${repo.toUpperCase()}_CHECKOUT`;
  const night = new Night(repo, checkout);
  let blockedReason = checkout ? null : `${envName} not set`;
  let res = { code: null, stdout: '', stderr: '', timedOut: false };
  if (!blockedReason) blockedReason = repo === 'relay' ? await prepareRelay(night) : await prepareEve(night);
  const commit = checkout ? await night.head() : '';
  if (!blockedReason) {
    res = repo === 'relay'
      ? await night.step('go', ['run', './cmd/devboxverify', '--checkout', checkout], { timeoutMs: RUN_TIMEOUT_MS })
      : await night.step(process.execPath, ['devboxverify/main.js', '--checkout', checkout], { timeoutMs: RUN_TIMEOUT_MS });
  }
  const result = classify({ exitCode: res.code, timedOut: res.timedOut, blockedReason });
  const summary = blockedReason || (res.timedOut ? `timed out after 30 min; ${summaryOf(res.stdout)}` : summaryOf(res.stdout));
  const record = { at, repo, result, commit, behind: night.behind, summary };
  const runs = path.join(logDir, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, `${at.slice(0, 10)}-${repo}.txt`), `${formatRecord(record)}\n\n${night.log.join('\n')}\n`);
  fs.appendFileSync(path.join(logDir, 'nightly.log'), `${formatRecord(record)}\n`);
  return record;
}

async function notify(message) {
  const script = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "devboxverify nightly"', '-e', 'end run'];
  const r = await runChild('osascript', [...script, message], { cwd: os.homedir(), timeoutMs: 15000 });
  if (r.code !== 0) process.stderr.write(`notification failed: ${r.stderr.trim()}\n`);
}

async function main() {
  const logDir = process.env.NIGHTLY_LOG_DIR || path.join(os.homedir(), 'Library', 'Logs', 'devboxverify');
  fs.mkdirSync(logDir, { recursive: true });
  const at = new Date().toISOString();
  const records = [
    await runNight('relay', process.env.NIGHTLY_RELAY_CHECKOUT, at, logDir),
    await runNight('eve', process.env.NIGHTLY_EVE_CHECKOUT, at, logDir),
  ];
  const all = parseRecords(fs.readFileSync(path.join(logDir, 'nightly.log'), 'utf8'));
  fs.writeFileSync(path.join(logDir, 'status.html'), renderStatusPage(all, { now: new Date() }));
  for (const r of records) process.stdout.write(`${formatRecord(r)}\n`);
  const bad = records.filter((r) => r.result !== 'GREEN');
  if (bad.length) await notify(bad.map((r) => `${r.repo} ${r.result}: ${r.summary}`).join('; '));
}

module.exports = { classify, summaryOf, formatRecord, parseRecords, renderStatusPage };

if (require.main === module) {
  main().then(() => process.exit(0), (err) => {
    process.stderr.write(`nightly failed: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
