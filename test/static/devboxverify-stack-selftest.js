#!/usr/bin/env node
'use strict';

// Self-test for devboxverify's --stack mode (eve#543): the flag's usage
// errors, the stack.json reader, and the paths a stack run uses. Pure
// functions; no relay, no eve, no browser.

const assert = require('assert');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { parseArgs, readStack, relayArgs, runRecordDir } = require(path.join(EVE, 'devboxverify/main'));

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
  usage(() => from('{nope'), /not readable JSON/, 'bad JSON');
  usage(() => from('[]'), /not a JSON object/, 'not an object');
  usage(() => readStack('/nonexistent/devboxverify/stack.json'), /no such file/, 'absent file');
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
stackCases();
pathCases();
console.log('devboxverify-stack-selftest: ok');
