#!/usr/bin/env node
'use strict';

// Self-test for ended outside sessions in the Chief of Staff (#578). A fake
// relayTransport serves the outside inventory and one detail route. Waits are
// on onSnapshot calls and the fake's returned promises, never on a duration:
// a "nothing was read again" claim is checked after a later snapshot that
// proves the pass finished.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { ChiefOfStaffOutside } = require(path.join(EVE, 'chief-of-staff-outside'));
const { ChiefOfStaff } = require(path.join(EVE, 'chief-of-staff'));
const actions = require(path.join(EVE, 'chief-of-staff-actions'));

const ROOT = '/api/chief-of-staff/outside-sessions';
const row = (n, extra = {}) => ({
  id: `outside:${n}`, name: `Claude — folder${n}`, machine: 'testbox', directory: `/work/folder${n}`,
  state: 'working', outside: true, readOnly: true, viewable: false, viewReason: 'not_in_tmux', ...extra,
});
const ended = (n, endedAt) => row(n, { state: 'ended', endedAt });

const inertSocket = () => ({ on() {}, close() {}, terminate() {} });

// Fake relay: set .rows and .revision; detail answers come from .turns[id]
// (a string, or an Error to fail). Reads yield before answering, so a parallel
// reader would overlap and raise maxInflight.
function fakeRelay() {
  const f = { rows: [], revision: 0, turns: {}, reads: [], inflight: 0, maxInflight: 0 };
  f.snapshot = () => ({ type: 'outside_sessions', revision: ++f.revision, probeIntervalMs: 15000, sessions: f.rows, machines: [] });
  f.transport = {
    async fetch(_method, url) {
      if (url === ROOT) return { status: 200, data: f.snapshot() };
      const id = decodeURIComponent(url.slice(ROOT.length + 1));
      f.reads.push(id);
      f.maxInflight = Math.max(f.maxInflight, ++f.inflight);
      for (let i = 0; i < 3; i++) await Promise.resolve();
      f.inflight--;
      const turn = f.turns[id];
      if (turn instanceof Error) return { status: 502, data: {} };
      const session = f.rows.find(r => r.id === id);
      if (!session || turn === undefined) return { status: 404, data: {} };
      return { status: 200, data: { session, lastTurn: { text: turn, at: '2026-10-19T10:00:00Z', complete: true }, lastExcerpt: turn } };
    },
    // An inert socket: the reader is started so it is not "stopped", but frames come through list().
    createWebSocket: inertSocket,
  };
  return f;
}

// Resolves on the first onSnapshot call satisfying pred.
function snapshotWaiter() {
  const waiting = [];
  const seen = [];
  return {
    seen,
    onSnapshot(s) { seen.push(s); for (const w of [...waiting]) if (w.pred(s)) { waiting.splice(waiting.indexOf(w), 1); w.resolve(s); } },
    until: pred => new Promise(resolve => { const hit = seen.find(pred); if (hit) resolve(hit); else waiting.push({ pred, resolve }); }),
  };
}
const excerptOf = (s, n) => s.sessions.find(r => r.id === `outside:${n}`).lastExcerpt;

// A wait that never resolves empties the event loop and would exit 0; fail that.
let finished = false;
process.on('exit', () => { if (!finished) { console.error('FAIL a wait never resolved (the awaited snapshot never came)'); process.exitCode = 1; } });

const failures = [];
async function run(name, fn) {
  try { await fn(); } catch (e) { failures.push(`${name}: ${e && e.message || e}`); }
}

async function main() {
  // B1: one read per ended row and endedAt, one at a time; a new endedAt reads again.
  await run('B1', async () => {
    const relay = fakeRelay();
    const w = snapshotWaiter();
    const outside = new ChiefOfStaffOutside({ relayTransport: relay.transport, onSnapshot: w.onSnapshot });
    outside.start();
    relay.rows = [row(1), ended(2, '2026-10-18T10:00:00Z'), ended(3, '2026-10-17T10:00:00Z')];
    relay.turns = { 'outside:2': 'two done', 'outside:3': 'three done' };
    await outside.list();
    await w.until(s => excerptOf(s, 2) === 'two done' && excerptOf(s, 3) === 'three done');
    assert.deepStrictEqual(relay.reads, ['outside:2', 'outside:3'], 'B1 live row never read; each ended row once');
    await outside.list(); // same rows, same endedAt: no reads
    relay.rows = [row(1), ended(2, '2026-10-19T09:00:00Z'), ended(3, '2026-10-17T10:00:00Z')];
    relay.turns['outside:2'] = 'two again';
    await outside.list();
    await w.until(s => excerptOf(s, 2) === 'two again');
    assert.deepStrictEqual(relay.reads, ['outside:2', 'outside:3', 'outside:2'], 'B1 only the changed endedAt reads again');
    assert.strictEqual(relay.maxInflight, 1, 'B1 reads are sequential');
    outside.stop();
  });

  // B2: a failed read stores nothing and is retried on the next accepted snapshot.
  await run('B2', async () => {
    const relay = fakeRelay();
    const w = snapshotWaiter();
    const outside = new ChiefOfStaffOutside({ relayTransport: relay.transport, onSnapshot: w.onSnapshot });
    outside.start();
    relay.rows = [ended(1, '2026-10-18T10:00:00Z'), ended(2, '2026-10-17T10:00:00Z')];
    relay.turns = { 'outside:1': new Error('down'), 'outside:2': 'two done' };
    await outside.list();
    // Row 2 is read after row 1 failed, so its snapshot closes the first pass.
    const first = await w.until(s => excerptOf(s, 2) === 'two done');
    assert.ok(!('lastExcerpt' in first.sessions.find(r => r.id === 'outside:1')), 'B2 failed read stores nothing');
    relay.turns['outside:1'] = 'one done';
    await outside.list();
    await w.until(s => excerptOf(s, 1) === 'one done');
    assert.deepStrictEqual(relay.reads, ['outside:1', 'outside:2', 'outside:1'], 'B2 failed row retried, cached row not');
    outside.stop();
  });

  // B3: list() and getSnapshot() carry no turn text; browserSnapshot() adds it for cached ended rows only.
  await run('B3', async () => {
    const relay = fakeRelay();
    const w = snapshotWaiter();
    const outside = new ChiefOfStaffOutside({ relayTransport: relay.transport, onSnapshot: w.onSnapshot });
    outside.start();
    relay.rows = [row(1), ended(2, '2026-10-18T10:00:00Z'), ended(3, '2026-10-17T10:00:00Z')];
    relay.turns = { 'outside:2': 'two done', 'outside:3': new Error('down') };
    await outside.list();
    await w.until(s => excerptOf(s, 2) === 'two done');
    for (const [label, rows] of [['list', await outside.list()], ['getSnapshot', outside.getSnapshot().sessions]]) {
      assert.ok(rows.every(r => !('lastExcerpt' in r)), `B3 ${label} rows carry no lastExcerpt`);
      assert.strictEqual(rows.find(r => r.id === 'outside:2').endedAt, '2026-10-18T10:00:00Z', `B3 ${label} keeps endedAt`);
    }
    const browser = outside.browserSnapshot();
    assert.strictEqual(excerptOf(browser, 2), 'two done', 'B3 cached ended row has lastExcerpt');
    assert.ok(!('lastExcerpt' in browser.sessions.find(r => r.id === 'outside:1')), 'B3 live row has none');
    assert.ok(!('lastExcerpt' in browser.sessions.find(r => r.id === 'outside:3')), 'B3 uncached ended row has none');
    outside.stop();
  });

  // B4: ended rows count in neither watching nor needYou; the browser snapshot carries the turn.
  await run('B4', async () => {
    const relay = fakeRelay();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-outside-ended-selftest-'));
    process.on('exit', () => fs.rmSync(dataDir, { recursive: true, force: true }));
    const cos = new ChiefOfStaff({
      relayTransport: {
        fetch: (m, u, ...rest) => (u.startsWith(ROOT) ? relay.transport.fetch(m, u, ...rest) : Promise.resolve({ status: 200, data: { sessions: [] } })),
        createWebSocket: inertSocket,
      },
      listProjects: () => [{ id: 'p1', name: 'Acme', path: dataDir }],
      model: { sessionId: 'sess-1', turn: async () => ({ text: 'ok' }) },
      dataDir,
      settings: { enabled: true, projectId: 'p1', model: 'haiku' },
    });
    const w = snapshotWaiter();
    cos.outside.start();
    cos.subscribe({ readyState: 1, send(json) { const f = JSON.parse(json); if (f.type === 'cos_outside_sessions') w.onSnapshot(f); } });
    relay.rows = [row(1, { state: 'asking' }), row(2), ended(3, '2026-10-18T10:00:00Z'), ended(4, '2026-10-17T10:00:00Z')];
    relay.turns = { 'outside:3': 'three done', 'outside:4': 'four done' };
    await cos.outside.list();
    await w.until(s => excerptOf(s, 3) === 'three done' && excerptOf(s, 4) === 'four done');
    const status = cos.getStatus();
    assert.deepStrictEqual([status.watching, status.needYou], [2, 1], 'B4 only live rows count');
    assert.strictEqual(excerptOf({ sessions: cos.getSnapshot().outsideSessions }, 3), 'three done', 'B4 cos_snapshot rows carry the turn');
    cos.stop();
  });

  // B5: the model's tools see endedAt on an ended row and read it by id, with no excerpt on the list.
  await run('B5', async () => {
    const relay = fakeRelay();
    const outside = new ChiefOfStaffOutside({ relayTransport: relay.transport, onSnapshot: () => {} });
    outside.start();
    relay.rows = [row(1), ended(2, '2026-10-18T10:00:00Z')];
    relay.turns = { 'outside:2': 'two done' };
    const cos = {
      settings: { enabled: true }, off: false, _stopped: false, personModel: { projectId: 'p1' },
      _turn: { settled: false, claim: async () => {} }, _fetchRoster: async () => {}, roster: new Map(),
      _labelOf: (_r, id) => id, _projectName: () => '', log: { error() {}, warn() {} }, outside,
    };
    const call = (tool, args) => actions.handleCall(cos, { tool, args, meta: { project_id: 'p1' } });
    const list = await call('cos_list_sessions', {});
    const rows = list.body.result.sessions;
    assert.strictEqual(rows.find(r => r.sessionId === 'outside:2').endedAt, '2026-10-18T10:00:00Z', 'B5 list row carries endedAt');
    assert.ok(!('endedAt' in rows.find(r => r.sessionId === 'outside:1')), 'B5 live row has no endedAt');
    assert.ok(rows.every(r => !('lastExcerpt' in r)), 'B5 list rows carry no lastExcerpt');
    const status = await call('cos_session_status', { sessionId: 'outside:2' });
    assert.strictEqual(status.body.result.endedAt, '2026-10-18T10:00:00Z', 'B5 status carries endedAt');
    assert.strictEqual(status.body.result.lastTurn.text, 'two done', 'B5 status reads the ended session last turn');
    outside.stop();
  });

  finished = true;
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log('cos-outside-ended-selftest: all cases passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
