'use strict';

// Preflight: can the host's Claude login answer one call? A lapsed login turns every Claude
// journey red with "authentication_failed"; this ends the run first with one BLOCKED line.
// `claude auth status` is not used: it reads local state and reports a made-up token as logged in.
// The token goes to the child on fd 3 only, never in env, argv or any output.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TOKEN_FILE_ENV = 'DEVBOXVERIFY_CLAUDE_TOKEN_FILE';
const PROBE_TIMEOUT_MS = 20000; // kill bound for a hung claude, not a wait
const PROBE_ARGS = ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', '',
  '--no-session-persistence', '--output-format', 'json', 'Reply with OK'];

function claudeTokenFile(env = process.env, home = os.homedir()) {
  return env[TOKEN_FILE_ENV] ? path.resolve(env[TOKEN_FILE_ENV]) : path.join(home, '.config', 'claude-ltt', 'token');
}

function loginCheckSkip({ stack, journeys }) {
  if (stack && stack.claudeBaseUrl) return "not checked: the stack's Claude uses its broker, not the host login";
  if (!journeys.some((j) => j.claude === true)) return 'not checked: no selected journey uses Claude';
  return null;
}

function readProbe({ code, stdout, timedOut = false, spawnError = null }) {
  if (spawnError && spawnError.code === 'ENOENT') return { verdict: 'unknown', reason: 'claude is not on PATH' };
  if (timedOut) return { verdict: 'unknown', reason: `the probe timed out after ${Math.round(PROBE_TIMEOUT_MS / 1000)}s` };
  let out = null;
  try {
    const parsed = JSON.parse(String(stdout || '').trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out = parsed;
  } catch { /* no JSON object: falls through to the exit reason */ }
  if (out) {
    const status = out.api_error_status;
    if (status === 401 || status === 403) return { verdict: 'bad', reason: `the API answered ${status}` };
    if (out.is_error === true && (status === undefined || status === null) && /authenticat|log ?in/i.test(String(out.result || ''))) {
      return { verdict: 'bad', reason: 'Claude reported an authentication failure' };
    }
    if (code === 0 && out.is_error === false) return { verdict: 'ok', reason: 'logged in' };
    if (status !== undefined && status !== null) return { verdict: 'unknown', reason: `the API answered ${status}` };
  }
  return { verdict: 'unknown', reason: `the probe ended with exit ${code} and no result` };
}

// The harness env minus every name that could steer or leak a login, plus the fd handoff.
function probeEnv(env, configDir) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE_') || k === 'CLAUDE_CONFIG_DIR' || k.startsWith('GIT_')) continue;
    out[k] = v;
  }
  out.CLAUDE_CONFIG_DIR = configDir;
  out.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = '3';
  return out;
}

function runProbe({ token, env, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let spawnError = null;
    let child;
    try {
      child = spawn('claude', PROBE_ARGS, { cwd, env: probeEnv(env, cwd), stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', timedOut, spawnError: err });
      return;
    }
    child.stdout.on('data', (d) => { if (stdout.length < 1e6) stdout += d; });
    child.stderr.resume(); // discarded
    child.stdio[3].on('error', () => { /* the child may exit before reading */ });
    child.stdio[3].end(token);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    timer.unref();
    child.on('error', (err) => { spawnError = err; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, timedOut, spawnError }); });
  });
}

async function claudeLoginCheck({ stack = null, journeys, env = process.env, home = os.homedir(),
  scratchRoot = os.tmpdir(), timeoutMs = PROBE_TIMEOUT_MS }) {
  const skip = loginCheckSkip({ stack, journeys });
  if (skip) return { state: 'OK', detail: skip };
  const file = claudeTokenFile(env, home);
  const shown = home ? file.split(home).join('~') : file;
  const bad = (reason) => ({
    state: 'FAIL',
    detail: `BLOCKED login: Claude cannot log in with the token in ${shown} (${reason}); log in again: run claude setup-token and save the new token there`,
  });
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch { return bad('no readable token file'); }
  if (!token) return bad('the token file is empty');
  const clean = (s) => String(s).split(token).join('').split(home).join('~');
  let scratch;
  try {
    await fs.promises.mkdir(scratchRoot, { recursive: true });
    scratch = await fs.promises.mkdtemp(path.join(scratchRoot, 'claude-login-'));
    const started = Date.now();
    const probe = await runProbe({ token, env, cwd: scratch, timeoutMs });
    const ms = Date.now() - started;
    const { verdict, reason } = readProbe(probe);
    if (verdict === 'ok') return { state: 'OK', detail: `logged in (${ms} ms)` };
    if (verdict === 'bad') return bad(clean(reason));
    return { state: 'OK', detail: clean(`unchecked: ${reason}; a login failure will show in the Claude journeys`) };
  } catch (err) {
    return { state: 'OK', detail: clean(`unchecked: the probe could not run (${(err && err.code) || 'error'}); a login failure will show in the Claude journeys`) };
  } finally {
    if (scratch) await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { TOKEN_FILE_ENV, PROBE_TIMEOUT_MS, PROBE_ARGS, claudeTokenFile, loginCheckSkip, readProbe, claudeLoginCheck };
