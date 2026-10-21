#!/usr/bin/env node
'use strict';

// Self-test for resuming an ended outside session (#593), from the issue's contract for
// ChiefOfStaffOutside#resume. A stub relayTransport serves the inventory and records every
// call; the POST answer is a promise the test controls. No waits on durations.
// The route (400s) is not covered here: no static selftest runs routes without the full server.

const assert = require('assert');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { ChiefOfStaffOutside } = require(path.join(EVE, 'chief-of-staff-outside'));

const ROOT = '/api/chief-of-staff/outside-sessions';
const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const UUID2 = 'f0e1d2c3-b4a5-4968-8776-655443322110';
const SIZE = { cols: 120, rows: 40 };

const ended = (n, extra = {}) => ({
  id: `outside:${n}`, name: `Claude — folder${n}`, machine: 'testbox', directory: `/work/folder${n}`,
  projectId: 'p1', state: 'ended', endedAt: '2026-10-01T00:00:00Z', outside: true, readOnly: true,
  claudeSessionId: UUID, ...extra,
});

function setup({ rows, project = { id: 'p1' } } = {}) {
  const f = { revision: 0, rows: rows || [], calls: [], post: null, frames: [] };
  f.transport = {
    async fetch(method, url, body, scope) {
      f.calls.push({ method, url, body, scope, argc: arguments.length });
      if (method === 'GET' && url === ROOT) {
        return { status: 200, data: { revision: ++f.revision, probeIntervalMs: 15000, sessions: f.rows, machines: [] } };
      }
      if (method === 'GET') {
        const id = decodeURIComponent(url.slice(ROOT.length + 1));
        const session = f.rows.find(r => r.id === id);
        return session ? { status: 200, data: { session, lastTurn: { text: 'hi', at: 'x', complete: true }, lastExcerpt: 'hi' } } : { status: 404, data: {} };
      }
      return f.post();
    },
  };
  f.outside = new ChiefOfStaffOutside({
    relayTransport: f.transport, onSnapshot: s => f.frames.push(s),
    resolveProject: id => (id === 'p1' ? project : null),
  });
  f.posts = () => f.calls.filter(c => c.method === 'POST');
  f.refresh = () => f.outside.list();
  return f;
}
const answer = (status, data) => () => Promise.resolve({ status, data });

(async () => {
  // Refusals, in contract order. None calls relay with a POST.
  {
    const f = setup({ rows: [ended(1)] });
    await f.refresh();
    f.post = () => { throw new Error('relay must not be called'); };

    let r = await f.outside.resume('outside:nope', SIZE);
    assert.deepStrictEqual(r, { status: 404, body: { error: 'outside_session_not_found', message: 'That session is no longer in the list.' } });
    assert.strictEqual(f.posts().length, 0);

    // Live row with no project: the live answer wins (check 2 before 3).
    f.rows = [{ ...ended(2), state: 'working', projectId: undefined, claudeSessionId: undefined }];
    await f.refresh();
    r = await f.outside.resume('outside:2', SIZE);
    assert.deepStrictEqual(r, { status: 409, body: { error: 'outside_session_live', message: 'This session is still running. Only an ended session can be resumed.' } });

    // No project (check 3), and a project that does not resolve; the host check comes after.
    const noProject = "Not in a project, so it can't be resumed.";
    f.rows = [ended(3, { projectId: undefined, hostId: 'h1' }), ended(4, { projectId: 'gone' })];
    await f.refresh();
    for (const id of ['outside:3', 'outside:4']) {
      r = await f.outside.resume(id, SIZE);
      assert.deepStrictEqual(r, { status: 409, body: { error: 'outside_resume_unavailable', message: noProject } }, id);
    }

    // Host: on the row, or on the project. Host check comes before the id check.
    const onHost = "On a host, so it can't be resumed here.";
    f.rows = [ended(5, { hostId: 'h1', claudeSessionId: 'bad' })];
    await f.refresh();
    r = await f.outside.resume('outside:5', SIZE);
    assert.deepStrictEqual(r, { status: 409, body: { error: 'outside_resume_unavailable', message: onHost } });
    const g = setup({ rows: [ended(6)], project: { id: 'p1', hostId: 'h2' } });
    await g.refresh();
    g.post = f.post;
    r = await g.outside.resume('outside:6', SIZE);
    assert.deepStrictEqual(r, { status: 409, body: { error: 'outside_resume_unavailable', message: onHost } });
    assert.strictEqual(g.posts().length, 0);

    // Bad or missing conversation id: not a UUID, extra characters, flag-like, absent.
    const noId = "Relay gave no conversation id, so it can't be resumed.";
    const bad = ['--dangerously-skip-permissions', 'not-a-uuid', `${UUID}x`, ` ${UUID}`, `${UUID}\n--x`, '', undefined, 42];
    for (const [i, v] of bad.entries()) {
      f.rows = [ended(7, { claudeSessionId: v })];
      await f.refresh();
      r = await f.outside.resume('outside:7', SIZE);
      assert.deepStrictEqual(r, { status: 409, body: { error: 'outside_resume_unavailable', message: noId } }, `bad id #${i}`);
    }
    assert.strictEqual(f.posts().length, 0, 'no relay POST on any refusal');
  }

  // Accepted: one POST with the exact body and no scope; uppercase UUID is accepted.
  {
    const f = setup({ rows: [ended(1, { claudeSessionId: UUID.toUpperCase() })] });
    await f.refresh();
    f.post = answer(201, { terminalId: 't1', name: 'x' });
    const r = await f.outside.resume('outside:1', SIZE);
    assert.deepStrictEqual(r, { status: 201, body: { terminal: { terminalId: 't1', name: 'x' } } });
    assert.strictEqual(f.posts().length, 1);
    const [call] = f.posts();
    assert.strictEqual(call.url, '/api/terminals');
    assert.strictEqual(call.argc, 3, 'no scope argument');
    assert.strictEqual(call.scope, undefined);
    assert.deepStrictEqual(call.body, {
      templateId: 'claude-code', name: 'Claude — folder1 (resumed)', directory: '/work/folder1',
      projectId: 'p1', cols: 120, rows: 40, extraArgs: ['--resume', UUID.toUpperCase()],
    });
  }

  // Relay answer mappings, and the busy guard.
  {
    const f = setup({ rows: [ended(1)] });
    await f.refresh();
    const cases = [
      [answer(200, {}), 502, { error: 'resume_failed', message: 'Relay did not return a terminal.' }],
      [answer(204, undefined), 502, { error: 'resume_failed', message: 'Relay did not return a terminal.' }],
      [answer(403, { code: 'forbidden', error: 'Nope.' }), 403, { error: 'forbidden', message: 'Nope.' }],
      [answer(500, {}), 500, { error: 'resume_failed', message: 'Relay answered 500.' }],
      [answer(422, undefined), 422, { error: 'resume_failed', message: 'Relay answered 422.' }],
      [() => Promise.reject(new Error('socket hang up')), 502, { error: 'Service unavailable' }],
      [() => { throw new Error('sync boom'); }, 502, { error: 'Service unavailable' }],
    ];
    for (const [post, status, body] of cases) {
      f.post = post;
      const r = await f.outside.resume('outside:1', SIZE);
      assert.deepStrictEqual(r, { status, body });
      assert.strictEqual(f.outside.resuming.size, 0, 'busy guard released after an answer');
    }

    // Second resume while the first is in flight: busy, and no second POST.
    let release;
    f.calls.length = 0;
    f.post = () => new Promise(res => { release = res; });
    const first = f.outside.resume('outside:1', SIZE);
    const second = await f.outside.resume('outside:1', SIZE);
    assert.deepStrictEqual(second, { status: 409, body: { error: 'outside_resume_busy', message: 'This session is already being resumed.' } });
    assert.strictEqual(f.posts().length, 1);
    release({ status: 201, data: { terminalId: 't9' } });
    assert.strictEqual((await first).status, 201);
    // The bad-id check (5) comes before the busy check (6): a resume in flight, then a snapshot
    // where the same row has no usable id, answers unavailable and not busy.
    f.post = () => new Promise(res => { release = res; });
    const held = f.outside.resume('outside:1', SIZE);
    f.rows = [ended(1, { claudeSessionId: 'not-a-uuid' })];
    await f.refresh();
    assert.deepStrictEqual(await f.outside.resume('outside:1', SIZE),
      { status: 409, body: { error: 'outside_resume_unavailable', message: "Relay gave no conversation id, so it can't be resumed." } });
    release({ status: 201, data: { terminalId: 't11' } });
    await held;
    f.rows = [ended(1)];
    await f.refresh();
    // Released: a later resume is accepted again.
    f.post = answer(201, { terminalId: 't10' });
    assert.strictEqual((await f.outside.resume('outside:1', SIZE)).status, 201);
  }

  // The Claude session id never leaves the class.
  {
    const f = setup({ rows: [ended(1), ended(2, { claudeSessionId: UUID2 })] });
    await f.refresh();
    const reads = [f.outside.getSnapshot(), f.outside.browserSnapshot(), await f.outside.list(),
      await f.outside.detail('outside:1'), await f.outside.detail('outside:2'), ...f.frames];
    // Let the ended-row turn fill finish so its frame is included.
    await f.outside._fillTurns();
    reads.push(...f.frames);
    assert.ok(f.frames.length > 0);
    for (const out of reads) {
      const text = JSON.stringify(out);
      assert.ok(!text.includes(UUID) && !text.includes(UUID2), 'conversation id leaked');
      assert.ok(!/claudeSessionId/i.test(text), 'conversation id field leaked');
    }
  }

  // The map follows each accepted snapshot.
  {
    const f = setup({ rows: [ended(1), ended(2)] });
    await f.refresh();
    f.post = answer(201, { terminalId: 't1' });
    assert.strictEqual((await f.outside.resume('outside:2', SIZE)).status, 201);
    f.rows = [ended(1)];
    await f.refresh();
    assert.strictEqual((await f.outside.resume('outside:2', SIZE)).status, 404);
    // A row that turns live is refused as live, not as a missing id.
    f.rows = [{ ...ended(1), state: 'working', claudeSessionId: undefined }];
    await f.refresh();
    const live = await f.outside.resume('outside:1', SIZE);
    assert.strictEqual(live.status, 409);
    assert.strictEqual(live.body.error, 'outside_session_live');
    // The id in an older snapshot is replaced, not kept: a new id is the one sent.
    f.rows = [ended(1, { claudeSessionId: UUID2 })];
    await f.refresh();
    f.calls.length = 0;
    await f.outside.resume('outside:1', SIZE);
    assert.deepStrictEqual(f.posts()[0].body.extraArgs, ['--resume', UUID2]);
  }

  console.log('outside-resume selftest: ok');
})().catch(e => { console.error(e); process.exit(1); });
