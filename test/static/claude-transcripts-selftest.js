#!/usr/bin/env node
'use strict';

// Self-test for devboxverify/claude-transcripts.js: a run leaves none of its
// Claude session files and none of the project folders it made, and touches
// nothing else. HOME is a scratch folder, so no real ~/.claude is read.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-selftest-'));
process.env.HOME = home;
const T = require(path.join(EVE, 'devboxverify/claude-transcripts'));

const NONCE = 'ab12cd34';
const TOKEN = `verify-${NONCE}-`;
const ROOT = path.join(home, '.claude', 'projects');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MARKS = { nonce: NONCE, slotPrefix: '-srv-runs-s1-' };
const RUN_FOLDER = `-Users-x-World-Acme-Corp-verify-${NONCE}-outside-Zz9`;

function put(folder, id, text, { memory = true, ageMs = 0 } = {}) {
  const dir = path.join(ROOT, folder);
  fs.mkdirSync(memory ? path.join(dir, 'memory') : dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, text);
  if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(file, t, t); }
  return file;
}
const exists = (...p) => fs.existsSync(path.join(ROOT, ...p));
const reset = () => { fs.rmSync(ROOT, { recursive: true, force: true }); fs.mkdirSync(ROOT, { recursive: true }); };

async function logged(fn) {
  const lines = [];
  const real = process.stderr.write;
  process.stderr.write = (s) => { lines.push(String(s)); return true; };
  try { await fn(); } finally { process.stderr.write = real; }
  return lines.join('');
}

const removeOne = (id, extra = {}) => T.removeTranscript({
  journey: 'j', id, token: TOKEN, marks: MARKS, running: async () => false, ...extra,
});

const cases = {
  async 'the id cleaner removes the folder it empties, memory/ included'() {
    reset();
    put(RUN_FOLDER, uuid(1), `reply ${TOKEN}done`);
    await logged(() => removeOne(uuid(1)));
    assert.ok(!exists(RUN_FOLDER, `${uuid(1)}.jsonl`), 'file deleted');
    assert.ok(!exists(RUN_FOLDER), 'the empty project folder the run made is removed');
  },
  async 'a folder under the stack run directory is removed when empty'() {
    reset();
    put('-srv-runs-s1-verify-cos', uuid(2), `x ${TOKEN}`);
    await logged(() => removeOne(uuid(2)));
    assert.ok(!exists('-srv-runs-s1-verify-cos'));
  },
  async 'a folder holding another file stays'() {
    reset();
    put(RUN_FOLDER, uuid(3), `x ${TOKEN}`);
    put(RUN_FOLDER, uuid(4), 'someone else');
    await logged(() => removeOne(uuid(3)));
    assert.ok(!exists(RUN_FOLDER, `${uuid(3)}.jsonl`));
    assert.ok(exists(RUN_FOLDER, `${uuid(4)}.jsonl`), 'the other file is untouched');
  },
  async 'a folder the run did not make stays, even when emptied'() {
    reset();
    put('-Users-x-World-Acme-Corp', uuid(5), `x ${TOKEN}`);
    await logged(() => removeOne(uuid(5)));
    assert.ok(!exists('-Users-x-World-Acme-Corp', `${uuid(5)}.jsonl`));
    assert.ok(exists('-Users-x-World-Acme-Corp'), 'a pre-existing project folder is never removed');
  },
  async 'a file without the run token is never touched'() {
    reset();
    put(RUN_FOLDER, uuid(6), 'no token in here');
    const out = await logged(() => removeOne(uuid(6)));
    assert.ok(exists(RUN_FOLDER, `${uuid(6)}.jsonl`));
    assert.match(out, /kept: no run token/);
  },
  async 'a still running session is not deleted'() {
    reset();
    put(RUN_FOLDER, uuid(7), `x ${TOKEN}`);
    const sweep = () => T.sweepTranscripts({
      journey: 'j', nonce: NONCE, marks: MARKS, sinceMs: 0,
      ps: async () => `  10     1 /usr/local/bin/claude --model haiku --session-id ${uuid(7)} hi\n`,
    });
    const out = await logged(sweep);
    assert.ok(exists(RUN_FOLDER, `${uuid(7)}.jsonl`), 'kept');
    assert.match(out, new RegExp(`transcript j: ${uuid(7)} kept: process still running`));
  },
  async 'the sweep deletes every file with the token, whichever journey wrote it, and logs one line each'() {
    reset();
    put(RUN_FOLDER, uuid(8), `Reply with exactly verify-${NONCE}-thread`);
    put('-srv-runs-s1-world-Acme-Corp', uuid(9), 'echo verify-' + NONCE);
    put('-srv-runs-s1-world-Acme-Corp', uuid(10), 'someone else, no token');
    put('-srv-runs-s1-world-Acme-Corp', uuid(15), `Reply with the single word ready. (verify ${NONCE})`);
    put('-Users-x-World-Acme-Corp', uuid(11), `old ${TOKEN}`, { ageMs: 3600e3 });
    put('-Users-x-World-Acme-Corp', uuid(12), 'unrelated');
    const out = await logged(() => T.sweepTranscripts({
      journey: 'cos-start-card', nonce: NONCE, marks: MARKS, sinceMs: Date.now() - 600e3, ps: async () => '',
    }));
    assert.ok(!exists(RUN_FOLDER), 'file and folder gone');
    assert.ok(!exists('-srv-runs-s1-world-Acme-Corp', `${uuid(9)}.jsonl`), 'a token without a trailing dash counts');
    assert.ok(exists('-srv-runs-s1-world-Acme-Corp', `${uuid(10)}.jsonl`), 'no token: untouched');
    assert.ok(!exists('-srv-runs-s1-world-Acme-Corp', `${uuid(15)}.jsonl`), 'the sentence form counts');
    assert.ok(exists('-srv-runs-s1-world-Acme-Corp'), 'a folder that still holds a file stays');
    assert.ok(exists('-Users-x-World-Acme-Corp', `${uuid(11)}.jsonl`), 'a file older than the run is untouched');
    assert.ok(exists('-Users-x-World-Acme-Corp', `${uuid(12)}.jsonl`));
    assert.match(out, new RegExp(`transcript cos-start-card: ${uuid(8)} deleted 1\\n`));
    assert.match(out, new RegExp(`transcript cos-start-card: ${uuid(9)} deleted 1\\n`));
    assert.strictEqual(out.trim().split('\n').length, 3, 'one line per session');
  },
  async 'a file whose Claude outlives the run goes once the Claude is gone'() {
    reset();
    put('-srv-runs-s1-verify-cos', uuid(16), `bootstrap verify-${NONCE}-cos`);
    let polls = 0;
    const ps = async () => (polls++ < 2 ? `  10     1 /bin/claude --print --session-id ${uuid(16)}\n` : '');
    const out = await logged(async () => {
      const waiting = await T.sweepTranscripts({ journey: 'j', nonce: NONCE, marks: MARKS, sinceMs: 0, ps });
      assert.deepStrictEqual(waiting, [uuid(16)], 'the sweep reports the session it had to leave');
      assert.ok(exists('-srv-runs-s1-verify-cos', `${uuid(16)}.jsonl`));
      assert.strictEqual(await T.reap({ ids: [uuid(16)], nonce: NONCE, marks: MARKS, sinceMs: 0, everyMs: 5, forMs: 5000, ps }), 0);
    });
    assert.ok(!exists('-srv-runs-s1-verify-cos'), 'file and folder gone once the Claude exited');
    assert.match(out, /after-run: .* deleted 1/);
  },
  async 'a Claude that never exits is left alone and the reaper gives up'() {
    reset();
    put(RUN_FOLDER, uuid(17), `x ${TOKEN}`);
    const ps = async () => `  10     1 /bin/claude --session-id ${uuid(17)}\n`;
    const left = await logged(async () => {
      assert.strictEqual(await T.reap({ ids: [uuid(17)], nonce: NONCE, marks: MARKS, sinceMs: 0, everyMs: 5, forMs: 40, ps }), 1);
    });
    assert.ok(exists(RUN_FOLDER, `${uuid(17)}.jsonl`));
    assert.ok(left.length > 0);
  },
  async 'the reaper leaves a session it was not handed, even one with no process id in ps'() {
    reset();
    put(RUN_FOLDER, uuid(18), `x ${TOKEN}`);
    await logged(() => T.reap({ ids: [uuid(19)], nonce: NONCE, marks: MARKS, sinceMs: 0, everyMs: 5, forMs: 20, ps: async () => '' }));
    assert.ok(exists(RUN_FOLDER, `${uuid(18)}.jsonl`), 'an unlisted session is not swept by the reaper');
  },
  async 'a failing ps keeps every file'() {
    reset();
    put(RUN_FOLDER, uuid(13), `x ${TOKEN}`);
    const out = await logged(() => T.sweepTranscripts({
      journey: 'j', nonce: NONCE, marks: MARKS, sinceMs: 0, ps: async () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); },
    }));
    assert.ok(exists(RUN_FOLDER, `${uuid(13)}.jsonl`));
    assert.match(out, /kept: ps failed: EPERM/);
  },
  async 'runMarks reads the nonce and the stack run directory'() {
    const m = T.runMarks({ nonce: NONCE, stack: { scratchDir: '/Users/a/.local/state/dv/runs/s9/eve-verify-runs' } });
    assert.deepStrictEqual(m, { nonce: NONCE, slotPrefix: '-Users-a--local-state-dv-runs-s9-' });
    assert.deepStrictEqual(T.runMarks({ nonce: NONCE, stack: null }), { nonce: NONCE, slotPrefix: '' });
  },
  async 'a wrapped journey registers its sweep last, even when it throws; fixtures are left alone'() {
    reset();
    const fixture = { id: 'f', fixture: true, run: async () => 1 };
    assert.strictEqual(T.withTranscriptSweep(fixture, 0), fixture);
    const registered = [];
    const env = { nonce: NONCE, stack: null, cleanup: (label, fn, ms) => registered.push({ label, fn, ms }) };
    const ok = T.withTranscriptSweep({ id: 'a', timeoutMs: 5, run: async () => { env.cleanup('own', () => {}); return 'r'; } }, 0);
    assert.strictEqual(ok.timeoutMs, 5);
    assert.strictEqual(await ok.run(env), 'r');
    assert.deepStrictEqual(registered.map((r) => r.label).slice(0, 1), ['own']);
    assert.match(registered[1].label, /^a: sweep/);
    assert.strictEqual(registered[1].ms, T.TRANSCRIPT_CLEANUP_MS);
    registered.length = 0;
    const bad = T.withTranscriptSweep({ id: 'b', run: async () => { throw new Error('boom'); } }, 0);
    await assert.rejects(bad.run(env), /boom/);
    assert.strictEqual(registered.length, 1, 'the sweep is registered after a throw');
    put(RUN_FOLDER, uuid(14), `x ${TOKEN}`);
    await logged(() => registered[0].fn());
    assert.ok(!exists(RUN_FOLDER));
  },
};

(async () => {
  let failed = 0;
  for (const [name, fn] of Object.entries(cases)) {
    try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed++; console.log(`FAIL ${name}\n     ${String(err.message).split('\n')[0]}`); }
  }
  fs.rmSync(home, { recursive: true, force: true });
  if (failed) { console.log(`${failed} failed`); process.exit(1); }
  console.log(`claude-transcripts-selftest: ${Object.keys(cases).length} cases ok`);
})();
