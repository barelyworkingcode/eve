#!/usr/bin/env node
'use strict';

// Self-test for devboxverify's --stack mode: the flag's usage
// errors, the stack.json reader, and the paths a stack run uses. Pure
// functions; no relay, no eve, no browser.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { parseArgs, journeyStack, readStack, relayArgs, runRecordDir } = require(path.join(EVE, 'devboxverify/main'));

const ROOT = '/srv/runs/s1';
const HEAD = 'e'.repeat(40);
const GOOD = {
  slot: 's1', config_dir: `${ROOT}/relay`, relay_bin: `${ROOT}/bundle/Relay.app/Contents/MacOS/relay`,
  marker: `${ROOT}/marker.json`, eve_url: 'http://localhost:53100', eve_data_dir: `${ROOT}/eve-data`,
  head: { relay: 'a'.repeat(40), eve: HEAD },
};
const parse = (argv) => parseArgs(argv, { toolRoot: '/srv/eve' });
const usage = (fn, re, what) => assert.throws(fn, (err) => err.usage === true && re.test(err.message), what);
const from = (doc) => readStack(`${ROOT}/stack.json`, { readFile: () => (typeof doc === 'string' ? doc : JSON.stringify(doc)) });

function argCases() {
  const opts = parse(['--stack', 'stack.json']);
  assert.strictEqual(opts.stack, path.resolve('stack.json'), '--stack takes a path, made absolute');
  assert.strictEqual(opts.screen, false);
  assert.deepStrictEqual(parse(['--stack=/x/stack.json', '--only', 'chat-reply']).only, ['chat-reply'], '--stack works with --only');
  usage(() => parse(['--stack', '/x', '--post', '12']), /--stack cannot be used with --post/, '--stack with --post');
  usage(() => parse(['--stack', '/x', '--epic', '12']), /--stack cannot be used with --epic/, '--stack with --epic');
  usage(() => parse(['--epic', '12', '--stack', '/x']), /--stack cannot be used with --epic/, '--epic before --stack');
  usage(() => parse(['--stack', '/x', '--screen']), /--stack cannot be used with --screen/, '--stack with --screen');
  usage(() => parse(['--stack', '/x', '--url', 'http://localhost:3100']), /drop --url/, '--stack with --url');
  usage(() => parse(['--stack']), /--stack needs a value/, '--stack with no value');

  const plain = parse([]);
  assert.strictEqual(plain.stack, null, 'without --stack there is no stack');
  assert.strictEqual(plain.url, 'http://localhost:3100', 'without --stack the url default is unchanged');
  assert.strictEqual(plain.service, 'eve-verify');
  assert.strictEqual(parse(['--screen']).screen, true, '--screen alone is unchanged');
  usage(() => parse(['--url', 'http://example.com:1']), /--url must be/, '--url rule unchanged');
}

function stackCases() {
  const s = from(GOOD);
  assert.deepStrictEqual(
    { slot: s.slot, configDir: s.configDir, relayBin: s.relayBin, marker: s.marker, url: s.url, dataDir: s.dataDir, eveHead: s.eveHead },
    { slot: 's1', configDir: GOOD.config_dir, relayBin: GOOD.relay_bin, marker: GOOD.marker, url: GOOD.eve_url, dataDir: GOOD.eve_data_dir, eveHead: HEAD },
    'every path comes from the file');
  assert.strictEqual(from({ ...GOOD, extra: 1, pids: { relay: 7 } }).slot, 's1', 'extra keys are ignored');
  for (const k of ['config_dir', 'relay_bin', 'marker', 'eve_data_dir']) {
    usage(() => from({ ...GOOD, [k]: 'relative/path' }), new RegExp(`${k} is not an absolute path`), `${k} relative`);
    const missing = { ...GOOD };
    delete missing[k];
    usage(() => from(missing), new RegExp(`${k} is not an absolute path`), `${k} missing`);
  }
  usage(() => from({ ...GOOD, eve_url: 'http://example.com:3100' }), /eve_url must be/, 'eve_url off loopback');
  usage(() => from({ ...GOOD, head: { relay: 'a'.repeat(40) } }), /head\.eve is not a commit/, 'no eve head');
  usage(() => from({ ...GOOD, slot: '' }), /no slot/, 'no slot');
  usage(() => from({ ...GOOD, outside_spool: 'relative/spool' }), /outside_spool is not an absolute path/, 'relative outside_spool');
  usage(() => from({ ...GOOD, relay_checkout: 7 }), /relay_checkout is not an absolute path/, 'non-string relay_checkout');
  usage(() => from({ ...GOOD, outside_spool: '/x/spool/' }), /must not end with a slash/, 'trailing slash spool');
  assert.strictEqual(from(GOOD).outsideSpool, null, 'absent outside_spool reads as null');
  assert.strictEqual(from({ ...GOOD, relay_checkout: '/x/relay', outside_spool: '/x/spool' }).outsideSpool, '/x/spool');
  assert.strictEqual(from(GOOD).claudeModel, null, 'absent claude_model reads as null');
  assert.strictEqual(from({ ...GOOD, claude_model: 'Local-Model-1' }).claudeModel, 'Local-Model-1', 'claude_model is read as given');
  for (const bad of ['', '  ', 5, null, ['x'], {}]) {
    usage(() => from({ ...GOOD, claude_model: bad }), /claude_model is not a non-empty string/, `claude_model ${JSON.stringify(bad)}`);
  }
  for (const bad of [' m ', 'a\nb', 'm\u007f']) {
    usage(() => from({ ...GOOD, claude_model: bad }), /claude_model must have no surrounding space or control/, `claude_model ${JSON.stringify(bad)}`);
  }
  usage(() => from('{nope'), /not readable JSON/, 'bad JSON');
  usage(() => from('[]'), /not a JSON object/, 'not an object');
  usage(() => readStack('/nonexistent/devboxverify/stack.json'), /no such file/, 'absent file');
}

function modelCases() {
  const { claudeModelId } = require(path.join(EVE, 'devboxverify/journeys'));
  assert.strictEqual(claudeModelId({ stack: null }), 'claude-haiku-5-5', 'a run without --stack asserts the Haiku id');
  assert.strictEqual(claudeModelId({ stack: { claudeModel: null } }), 'claude-haiku-5-5', 'a stack without claude_model asserts the Haiku id');
  assert.strictEqual(claudeModelId({ stack: from(GOOD) }), 'claude-haiku-5-5', 'a read stack without claude_model asserts the Haiku id');
  assert.strictEqual(claudeModelId({ stack: from({ ...GOOD, claude_model: 'Local-Model-1' }) }), 'Local-Model-1', 'claude_model is the asserted id');
  const env = { stack: journeyStack(from({ ...GOOD, claude_model: 'Local-Model-1' }), '/srv/scratch') };
  assert.strictEqual(claudeModelId(env), 'Local-Model-1', 'the env.stack projection keeps claude_model');
  assert.strictEqual(env.stack.scratchDir, '/srv/scratch');
  assert.strictEqual(journeyStack(null, null), null, 'no stack, no env.stack');
}

function brokerCases() {
  const OC = require(path.join(EVE, 'devboxverify/outside-claude'));
  const TOKEN = '/srv/runs/s1/claude-token';
  const owned = { isFile: () => true, mode: 0o100600, uid: process.getuid() };
  const withStat = (st) => (doc) => readStack(`${ROOT}/stack.json`, { readFile: () => JSON.stringify(doc), statFile: () => st });
  const ok = withStat(owned);
  const B = { ...GOOD, claude_model: 'Local-Model-1', claude_base_url: 'http://127.0.0.1:53200', claude_token_file: TOKEN };
  const s = ok(B);
  assert.strictEqual(s.claudeBaseUrl, 'http://127.0.0.1:53200');
  assert.strictEqual(s.claudeTokenFile, TOKEN);
  assert.strictEqual(from(GOOD).claudeTokenFile, null, 'absent broker fields read as null');
  {
    // A real 0600 file holding a marker: it must reach no field of the stack and no error message.
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvb-'));
    try {
      const mfile = path.join(mdir, 'tok');
      fs.writeFileSync(mfile, 'marker-bearer-7f3a\n', { mode: 0o600 });
      const real = readStack(`${ROOT}/stack.json`, { readFile: () => JSON.stringify({ ...B, claude_token_file: mfile }) });
      assert.strictEqual(real.claudeTokenFile, mfile);
      assert.ok(!JSON.stringify(real).includes('marker-bearer-7f3a'), 'the stack holds a path, never a token');
      let msg = '';
      try { readStack(`${ROOT}/stack.json`, { readFile: () => JSON.stringify({ ...B, claude_token_file: mfile, claude_base_url: 'http://example.com:1' }) }); } catch (err) { msg = err.message; }
      assert.ok(msg && !msg.includes('marker-bearer-7f3a'), 'an error never carries the token');
    } finally { fs.rmSync(mdir, { recursive: true, force: true }); }
  }
  for (const bad of ['', ' http://127.0.0.1:1', 5, null, 'a\nb']) {
    usage(() => ok({ ...B, claude_base_url: bad }), /claude_base_url/, `base url ${JSON.stringify(bad)}`);
    usage(() => ok({ ...B, claude_token_file: bad }), /claude_token_file/, `token file ${JSON.stringify(bad)}`);
  }
  usage(() => ok({ ...B, claude_base_url: 'http://example.com:1' }), /claude_base_url must be/, 'base url off loopback');
  usage(() => ok({ ...B, claude_token_file: 'rel/token' }), /claude_token_file is not an absolute path/, 'relative token file');
  usage(() => ok({ ...B, claude_token_file: undefined }), /claude_token_file is not a clean/, 'url without token file');
  usage(() => ok({ ...GOOD, claude_token_file: TOKEN }), /claude_base_url is not a clean/, 'token file without url');
  usage(() => ok({ ...B, claude_model: undefined }), /needs claude_model/, 'broker without a model');
  usage(() => withStat({ ...owned, mode: 0o100644 })(B), /owner only/, 'group/world readable');
  usage(() => withStat({ ...owned, uid: process.getuid() + 1 })(B), /not owned/, 'other owner');
  usage(() => withStat({ ...owned, isFile: () => false })(B), /is not a file/, 'a directory');
  usage(() => readStack(`${ROOT}/stack.json`, { readFile: () => JSON.stringify(B), statFile: () => { throw new Error('ENOENT'); } }), /does not exist/, 'missing file');

  // The env builder, with a real 0600 file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvb-'));
  try {
    const file = path.join(dir, 'tok');
    fs.writeFileSync(file, 'secret-bearer\n', { mode: 0o600 });
    const real = readStack(`${ROOT}/stack.json`, { readFile: () => JSON.stringify({ ...B, claude_token_file: file }) });
    const env = { stack: journeyStack(real, dir) };
    const e = OC.outsideClaudeEnv(env);
    assert.strictEqual(e.ANTHROPIC_AUTH_TOKEN, 'secret-bearer', 'the token is read from the file, trimmed');
    assert.strictEqual(e.ANTHROPIC_BASE_URL, 'http://127.0.0.1:53200');
    assert.strictEqual(e.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'Local-Model-1');
    assert.ok(!Object.keys(e).some((k) => k.startsWith('GIT_')), 'GIT_* is dropped as before');
    assert.ok(!OC.shellPrefix(env).includes('secret-bearer'), 'the tmux command line never holds the token');
    assert.ok(OC.shellPrefix(env).includes(`$(cat '${file}')`), 'the shell reads the token file');
    const pre = OC.shellPrefix(env);
    assert.ok(pre.startsWith(`[ -s '${file}' ] || { echo `) && pre.includes('>&2; exit 1; }; ANTHROPIC_BASE_URL='), 'the shell refuses to start claude on an unreadable or empty token file');
    assert.ok(pre.includes(`token file ${file} is empty`), 'the refusal names the file');
    fs.writeFileSync(file, '\n');
    assert.throws(() => OC.outsideClaudeEnv(env), /is empty/, 'an empty token file fails fast');
    // settings.local.json
    const proj = path.join(dir, 'proj');
    fs.mkdirSync(proj);
    return OC.writeOutsideSettings(env, proj).then(async (f) => {
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { env: { CLAUDE_CODE_ATTRIBUTION_HEADER: '0', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' } });
      const none = path.join(dir, 'none');
      fs.mkdirSync(none);
      assert.strictEqual(await OC.writeOutsideSettings({ stack: from(GOOD) }, none), null, 'no broker, no settings file');
      assert.ok(!fs.existsSync(path.join(none, '.claude')));
      assert.strictEqual(OC.shellPrefix({ stack: null }), '');
      assert.strictEqual(OC.outsideClaudeEnv({ stack: null }).ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_AUTH_TOKEN, 'a run without a stack keeps today\'s env');
    }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (err) { fs.rmSync(dir, { recursive: true, force: true }); throw err; }
}

function pathCases() {
  const s = from(GOOD);
  assert.deepStrictEqual(relayArgs(s, ['service', 'list']), ['--config-dir', GOOD.config_dir, 'service', 'list'],
    'a stack run names its config dir on every relay call');
  assert.deepStrictEqual(relayArgs(null, ['service', 'list']), ['service', 'list'], 'without a stack the argv is unchanged');
  assert.strictEqual(runRecordDir({}, '/srv/home', s), `${ROOT}/eve-verify-runs`, 'a stack run records into its run dir');
  assert.strictEqual(runRecordDir({}, '/srv/home'), '/srv/home/Library/Logs/devboxverify/runs', 'without a stack the record dir is unchanged');
}

argCases();
modelCases();
stackCases();
pathCases();
brokerCases().then(() => console.log('devboxverify-stack-selftest: ok'), (err) => { console.error(err); process.exit(1); });
