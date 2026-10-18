#!/usr/bin/env node
'use strict';

// Self-test for the Chief of Staff turn gate in devboxverify: the busy-flag
// reader, the wait (on the flag, with a named failure at the cap) and the
// wrapper that runs it before and after a Chief of Staff journey. No eve, no browser.

const assert = require('assert');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { withCosTurnGate, waitCosIdle, latestCosBusy, afterOwnPost } = require(path.join(EVE, 'devboxverify/journeys'));

const status = (busy) => ({ type: 'cos_status', status: { busy } });

// A socket whose frames come from `script`, one more per poll of its frames.
function fakeOpen(script, log) {
  return async () => {
    const frames = [];
    let next = 0;
    return {
      send: (m) => log.push(m.type),
      close: () => log.push('close'),
      get frames() { if (next < script.length) frames.push(script[next++]); return frames; },
    };
  };
}

async function main() {
  assert.strictEqual(latestCosBusy([]), null, 'no frame, no answer');
  assert.strictEqual(latestCosBusy([{ type: 'cos_snapshot', status: { busy: true } }, status(false)]), false, 'the newest frame wins');
  assert.strictEqual(latestCosBusy([status(false), { type: 'cos_post' }, status(true)]), true, 'other frames are skipped');

  const own = { posts: [{ kind: 'reply' }, { kind: 'person', text: 'hi' }, { kind: 'reply', body: 'old' }] };
  assert.strictEqual(await afterOwnPost(own, 0, ' hi '), 2, "new posts begin after the journey's own person post");

  const ran = [];
  const journey = { id: 'cos-x', timeoutMs: 1000, areas: ['chief-of-staff'], run: async () => { ran.push('run'); return { id: 'cos-x', state: 'PASS', detail: 'ok' }; } };
  const plain = { id: 'chat', timeoutMs: 1000, areas: ['chat'], run: async () => null };
  assert.strictEqual(withCosTurnGate(plain), plain, 'a journey outside the area is untouched');

  // Busy, then idle: it starts after busy:false and waits again at the end.
  const log = [];
  const wrapped = withCosTurnGate(journey, { open: fakeOpen([status(true), status(true), status(false)], log) });
  assert.strictEqual(wrapped.timeoutMs, 1000, 'the declared timeout is unchanged');
  assert.strictEqual((await wrapped.run({})).state, 'PASS');
  assert.deepStrictEqual(ran, ['run']);
  assert.strictEqual(log.filter((x) => x === 'cos_subscribe').length, 2, 'one wait before and one after');
  assert.strictEqual(log.filter((x) => x === 'close').length, 2, 'every socket is closed');

  // Never idle: the failure names the journey and the flag it waited for.
  const closed = [];
  await assert.rejects(
    waitCosIdle({}, 'cos-x', 'before the journey started', { open: fakeOpen([status(true)], closed), withinMs: 60, intervalMs: 10 }),
    /cos-x: the Chief of Staff turn had not ended within 0\.06s before the journey started \(waited for cos_status busy:false; last status busy:true\)/);
  assert.deepStrictEqual(closed.filter((x) => x === 'close'), ['close'], 'the socket closes on failure');

  // End-wait times out: a PASS becomes a FAIL naming the journey.
  const quick = { withinMs: 40, intervalMs: 10 };
  const endBusy = (n) => { // idle for the first `n` sockets, busy after
    let opens = 0;
    return async () => { const busy = opens++ >= n; return { send() {}, close() {}, get frames() { return [status(busy)]; } }; };
  };
  const passing = { ...journey, run: async () => ({ id: 'cos-x', state: 'PASS', detail: 'ok' }) };
  const endTimeout = await withCosTurnGate(passing, { open: endBusy(1), ...quick }).run({});
  assert.strictEqual(endTimeout.state, 'FAIL', 'an end-wait timeout fails a passing journey');
  assert.match(endTimeout.detail, /cos-x: the Chief of Staff turn had not ended .* after the journey's last step/);

  // Start-wait times out: FAIL, and the journey body never runs.
  let startRan = false;
  const startTimeout = await withCosTurnGate({ ...journey, run: async () => { startRan = true; return { state: 'PASS' }; } }, { open: endBusy(0), ...quick }).run({});
  assert.strictEqual(startTimeout.state, 'FAIL', 'a start-wait timeout is a FAIL');
  assert.match(startTimeout.detail, /cos-x: .* before the journey started/);
  assert.strictEqual(startRan, false, 'the journey does not run after a start-wait timeout');

  // A journey that already failed keeps its verdict when the end-wait times out.
  const failed = { id: 'cos-x', state: 'FAIL', detail: 'own failure' };
  const kept = await withCosTurnGate({ ...journey, run: async () => failed }, { open: endBusy(1), ...quick }).run({});
  assert.strictEqual(kept, failed, 'a failed journey keeps its own verdict');
}

main().then(() => console.log('devboxverify-cos-gate-selftest: ok'), (err) => { console.error(err); process.exit(1); });
