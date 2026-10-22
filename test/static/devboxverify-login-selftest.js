#!/usr/bin/env node
'use strict';

// Self-test for devboxverify's Claude login preflight (#565). Hermetic: a stub
// `claude` (a node script) sits first on PATH, the token is a fake file, the
// home is a temp dir. Each case awaits the promise claudeLoginCheck returns,
// which settles on the stub's exit; no sleep, no poll.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const login = require(path.join(EVE, 'devboxverify/claude-login'));
const { formatLine } = require(path.join(EVE, 'devboxverify/main'));
const { claudeLoginCheck, readProbe, loginCheckSkip, claudeTokenFile, PROBE_ARGS, TOKEN_FILE_ENV } = login;

const TOKEN = 'fake-token-for-test';
const STUB = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const dir = __dirname;
const mode = JSON.parse(fs.readFileSync(path.join(dir, 'mode.json'), 'utf8'));
let fd3 = null;
try { fd3 = fs.readFileSync(3, 'utf8'); } catch (e) { fd3 = 'ERR ' + e.code; }
fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ argv: process.argv.slice(2), env: process.env, fd3, cwd: process.cwd(), pid: process.pid }));
if (mode.hang) { setInterval(() => {}, 1000); }
else { process.stdout.write(JSON.stringify(mode.out) + '\\n'); process.exit(mode.code); }
`;

const made = [];
function sandbox(mode, { token = `${TOKEN}\n` } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'login-selftest-'));
  made.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const scratch = path.join(root, 'scratch');
  const tokenFile = path.join(home, '.config', 'claude-ltt', 'token');
  for (const d of [path.dirname(tokenFile), bin, scratch]) fs.mkdirSync(d, { recursive: true });
  if (token !== null) fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  fs.writeFileSync(path.join(bin, 'mode.json'), JSON.stringify(mode));
  fs.writeFileSync(path.join(bin, 'claude'), STUB, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, [TOKEN_FILE_ENV]: tokenFile };
  const record = () => (fs.existsSync(path.join(bin, 'record.json')) ? JSON.parse(fs.readFileSync(path.join(bin, 'record.json'), 'utf8')) : null);
  return { root, home, bin, scratch, tokenFile, env, record };
}
const run = (sb, extra = {}) => claudeLoginCheck({ journeys: [{ id: 'j', claude: true }], env: sb.env, home: sb.home, scratchRoot: sb.scratch, ...extra });
const leftovers = (sb) => fs.readdirSync(sb.scratch).filter((n) => n.startsWith('claude-login-'));
const BAD_OUT = { type: 'result', is_error: true, api_error_status: 401, result: 'Invalid authentication credentials' };

async function main() {
  // 1 good
  {
    const sb = sandbox({ out: { type: 'result', is_error: false, result: 'OK' }, code: 0 });
    const t0 = Date.now();
    const r = await run(sb);
    assert.strictEqual(r.state, 'OK');
    assert.match(r.detail, /^logged in \(\d+ ms\)$/);
    assert.ok(Date.now() - t0 < 5000, 'under 5000 ms');
    assert.deepStrictEqual(leftovers(sb), [], 'case 9: scratch removed after good');
  }

  // 2 bad: the exact line
  {
    const sb = sandbox({ out: BAD_OUT, code: 1 });
    const r = await run(sb);
    assert.strictEqual(r.state, 'FAIL');
    assert.strictEqual(
      formatLine(sb.home, 'PREFLIGHT', 'claude', r.state, r.detail),
      'PREFLIGHT\tclaude\tFAIL\tBLOCKED login: Claude cannot log in with the token in ~/.config/claude-ltt/token (the API answered 401); log in again: run claude setup-token and save the new token there',
    );
    assert.ok(r.detail.length < 200, 'detail under the 200 char cut');
    assert.deepStrictEqual(leftovers(sb), [], 'case 9: scratch removed after bad');
  }

  // 3 handoff
  {
    const sb = sandbox({ out: { type: 'result', is_error: false, result: 'OK' }, code: 0 });
    Object.assign(sb.env, {
      ANTHROPIC_API_KEY: 'seed-anthropic', ANTHROPIC_BASE_URL: 'http://seed', CLAUDE_CODE_OAUTH_TOKEN: 'seed-oauth',
      CLAUDE_CODE_SEED: 'seed-cc', CLAUDE_CONFIG_DIR: '/seed/config', GIT_DIR: '/seed/git', GIT_WORK_TREE: '/seed/wt', KEEP_ME: 'kept',
    });
    const r = await run(sb);
    assert.strictEqual(r.state, 'OK');
    const rec = sb.record();
    assert.strictEqual(rec.fd3, TOKEN, 'fd 3 held the token with no newline');
    assert.strictEqual(rec.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR, '3');
    for (const name of Object.keys(rec.env)) {
      if (name === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' || name === 'CLAUDE_CONFIG_DIR') continue;
      assert.ok(!/^(ANTHROPIC_|CLAUDE_CODE_|GIT_)/.test(name), `${name} must not reach the child`);
    }
    assert.notStrictEqual(rec.env.CLAUDE_CONFIG_DIR, '/seed/config', 'config dir is the scratch dir');
    const scratchReal = fs.realpathSync(sb.scratch);
    assert.ok(rec.cwd.startsWith(path.join(scratchReal, 'claude-login-')), `cwd is in the scratch dir: ${rec.cwd}`);
    assert.strictEqual(rec.env.KEEP_ME, 'kept', 'other harness env passes through');
    assert.deepStrictEqual(rec.argv, PROBE_ARGS);
    for (const a of rec.argv) assert.ok(!a.includes(TOKEN), 'token not in argv');
    for (const v of Object.values(rec.env)) assert.ok(!String(v).includes(TOKEN), 'token not in env');
  }

  // 4 redaction
  {
    const sb = sandbox({ out: { ...BAD_OUT, result: `bad token ${TOKEN} rejected` }, code: 1 });
    const r = await run(sb);
    assert.strictEqual(r.state, 'FAIL');
    assert.ok(!r.detail.includes(TOKEN), 'token text removed from the detail');
    assert.ok(!r.detail.includes(sb.home), 'home dir not in the detail');
  }

  // 5 missing and empty token file: FAIL, no process
  {
    const sb = sandbox({ out: {}, code: 0 }, { token: null });
    const r = await run(sb);
    assert.strictEqual(r.state, 'FAIL');
    assert.match(r.detail, /\(no readable token file\)/);
    assert.strictEqual(sb.record(), null, 'missing file: no probe');
    const sb2 = sandbox({ out: {}, code: 0 }, { token: ' \n' });
    const r2 = await run(sb2);
    assert.strictEqual(r2.state, 'FAIL');
    assert.match(r2.detail, /\(the token file is empty\)/);
    assert.strictEqual(sb2.record(), null, 'empty file: no probe');
    assert.deepStrictEqual(leftovers(sb), []);
    assert.deepStrictEqual(leftovers(sb2), []);
  }

  // 6 unknown
  {
    const sb = sandbox({ out: { type: 'result', is_error: true, api_error_status: 500, result: 'overloaded' }, code: 1 });
    const r = await run(sb);
    assert.strictEqual(r.state, 'OK');
    assert.match(r.detail, /^unchecked: the API answered 500; /);
    assert.deepStrictEqual(leftovers(sb), []);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'login-selftest-'));
    made.push(empty);
    const sb2 = sandbox({ out: {}, code: 0 });
    sb2.env.PATH = empty;
    const r2 = await run(sb2);
    assert.strictEqual(r2.state, 'OK');
    assert.match(r2.detail, /^unchecked: claude is not on PATH; /);
    assert.deepStrictEqual(leftovers(sb2), []);

    const sb3 = sandbox({ hang: true });
    const r3 = await run(sb3, { timeoutMs: 300 });
    assert.strictEqual(r3.state, 'OK');
    assert.match(r3.detail, /^unchecked: the probe timed out /);
    const pid = sb3.record().pid;
    assert.throws(() => process.kill(pid, 0), (e) => e.code === 'ESRCH', 'the hung stub is gone');
    assert.deepStrictEqual(leftovers(sb3), []);
  }

  // 7 skip: no process
  {
    const sb = sandbox({ out: {}, code: 0 });
    const r = await run(sb, { stack: { claudeBaseUrl: 'http://127.0.0.1:1' } });
    assert.deepStrictEqual(r, { state: 'OK', detail: "not checked: the stack's Claude uses its broker, not the host login" });
    assert.strictEqual(sb.record(), null);
    const r2 = await run(sb, { journeys: [{ id: 'a' }, { id: 'b', claude: false }] });
    assert.deepStrictEqual(r2, { state: 'OK', detail: 'not checked: no selected journey uses Claude' });
    assert.strictEqual(sb.record(), null);
    assert.strictEqual(loginCheckSkip({ stack: { claudeBaseUrl: 'x' }, journeys: [{ claude: true }] }), "not checked: the stack's Claude uses its broker, not the host login");
    assert.strictEqual(loginCheckSkip({ stack: {}, journeys: [] }), 'not checked: no selected journey uses Claude');
    assert.strictEqual(loginCheckSkip({ stack: null, journeys: [{ claude: true }] }), null);
  }

  // 8 marks
  {
    const all = require(path.join(EVE, 'devboxverify/journeys')).journeys;
    const byId = new Map(all.map((j) => [j.id, j]));
    for (const j of all) {
      // The Pi and Codex adopt journeys run no claude, so they carry no claude flag (eve#609 contract).
      if (j.id === 'outside-adopt-pi' || j.id === 'outside-adopt-codex') assert.notStrictEqual(j.claude, true, `${j.id} runs no claude and carries no claude flag`);
      else if (j.areas && j.areas.includes('chief-of-staff')) assert.strictEqual(j.claude, true, `${j.id} is chief-of-staff and needs claude: true`);
      if (j.fixture) assert.notStrictEqual(j.claude, true, `${j.id} is a fixture journey`);
    }
    const ids = ['agent-board-states', 'agent-drop-in', 'cos-asking-post', 'cos-tell-sends-marked', 'cos-reads-project', 'cos-start-card',
      'cos-errand-finished', 'cos-agent-rail', 'cos-add-agent', 'cos-start-entry', 'cos-add-chat', 'cos-host-agent', 'cos-host-noread',
      'cos-project-from-relay', 'changes-agent-edit', 'files-on-host', 'cos-delegation', 'cos-outside-simple', 'outside-thread', 'cos-outside-hooks'];
    assert.strictEqual(ids.length, 20);
    for (const id of ids) {
      assert.ok(byId.has(id), `journey ${id} exists`);
      assert.strictEqual(byId.get(id).claude, true, `${id} has claude: true`);
    }
  }

  // 10 readProbe table
  {
    const ok = JSON.stringify({ type: 'result', is_error: false, result: 'OK' });
    const row = (input, verdict, reason) => {
      const r = readProbe(input);
      assert.strictEqual(r.verdict, verdict, JSON.stringify(input));
      if (reason !== undefined) assert.strictEqual(r.reason, reason, JSON.stringify(input));
    };
    const err = (o) => JSON.stringify({ type: 'result', is_error: true, ...o });
    row({ code: 0, stdout: ok }, 'ok');
    row({ code: 1, stdout: err({ api_error_status: 401 }) }, 'bad', 'the API answered 401');
    row({ code: 1, stdout: err({ api_error_status: 403 }) }, 'bad', 'the API answered 403');
    row({ code: 1, stdout: err({ result: 'Please log in again' }) }, 'bad', 'Claude reported an authentication failure');
    row({ code: 1, stdout: err({ result: 'authentication_failed' }) }, 'bad', 'Claude reported an authentication failure');
    row({ code: 1, stdout: err({ api_error_status: 500, result: 'log in' }) }, 'unknown', 'the API answered 500');
    row({ code: 1, stdout: err({ result: 'something broke' }) }, 'unknown', 'the probe ended with exit 1 and no result');
    row({ code: null, stdout: '', spawnError: { code: 'ENOENT' } }, 'unknown', 'claude is not on PATH');
    row({ code: null, stdout: '', timedOut: true }, 'unknown', `the probe timed out after ${login.PROBE_TIMEOUT_MS / 1000}s`);
    row({ code: 2, stdout: '' }, 'unknown', 'the probe ended with exit 2 and no result');
    row({ code: 0, stdout: 'not json' }, 'unknown');
    assert.strictEqual(claudeTokenFile({ [TOKEN_FILE_ENV]: '/x/./t' }, '/h'), '/x/t');
    assert.strictEqual(claudeTokenFile({}, '/h'), '/h/.config/claude-ltt/token');
  }
}

main().then(() => { console.log('devboxverify-login-selftest: ok'); }, (err) => { console.error(err); process.exitCode = 1; })
  .finally(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
