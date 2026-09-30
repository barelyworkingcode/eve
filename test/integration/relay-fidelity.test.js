/**
 * The fake relay is pinned to relay's source (see the header of fake-relay.js).
 * These tests hold the fake to that, and hold eve to what a relay that refuses,
 * drops or 404s does to it. Each expectation names the relay file it comes from;
 * relay-source-pins.test.js re-reads those files when ../relay is checked out.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { startEve } = require('./harness');
const { createFakeRelay } = require('./fake-relay');
const { relayFrames, validateRelayFrame } = require('./protocol');

const json = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('fake relay answers as relay does (direct)', () => {
  let relay;
  let base;
  beforeAll(async () => {
    relay = createFakeRelay();
    base = `http://127.0.0.1:${await relay.listen()}`;
  });
  afterAll(async () => { await relay.close(); });

  it('unmatched path: text/plain 404 "no service registered for this path" (frontend_dispatcher.go)', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('no service registered for this path\n');
  });

  it('project: 404 "project not found" for GET/PUT/DELETE of an unknown id; DELETE is 204 (project_routes.go)', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/api/projects/ghost`, { method, ...(method === 'PUT' ? json({ name: 'x' }) : {}) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'project not found' });
    }
    relay.addProject({ id: 'p1', name: 'P', path: '/tmp' });
    const del = await fetch(`${base}/api/projects/p1`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');
  });

  it('host: lowercase 404, 204 delete, 409 "host is used by one or more projects" (host_routes.go)', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await fetch(`${base}/api/hosts/ghost`, { method, ...(method === 'PUT' ? json({ name: 'x' }) : {}) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'host not found' });
    }
    relay.addHost({ id: 'h1', name: 'box' });
    relay.addProject({ id: 'ph', name: 'PH', path: '/srv/x', host_id: 'h1' });
    const busy = await fetch(`${base}/api/hosts/h1`, { method: 'DELETE' });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: 'host is used by one or more projects', projects: ['PH'] });
    await fetch(`${base}/api/projects/ph`, { method: 'DELETE' });
    const gone = await fetch(`${base}/api/hosts/h1`, { method: 'DELETE' });
    expect(gone.status).toBe(204);
  });

  it('sessions: create body is types.Session; list items are session.Summary (`id`, `live`); delete is 204', async () => {
    const created = await (await fetch(`${base}/api/sessions`, { method: 'POST', ...json({ directory: '/d', model: 'm', name: 'n' }) })).json();
    expect(created).toMatchObject({ sessionId: expect.any(String), providerType: 'claude', messages: [], directory: '/d', model: 'm', name: 'n' });
    expect(created.stats).toMatchObject({ inputTokens: 0, costUsd: 0 });

    const { sessions } = await (await fetch(`${base}/api/sessions`)).json();
    const row = sessions.find((s) => s.id === created.sessionId);
    expect(row).toMatchObject({ id: created.sessionId, live: true, messageCount: 0, directory: '/d', model: 'm', name: 'n', projectId: '' });
    expect(row).not.toHaveProperty('sessionId');

    const del = await fetch(`${base}/api/sessions/${created.sessionId}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });

  it('terminal log: text/plain for a known terminal, bare 404 for an unknown one (http_terminal.go)', async () => {
    relay.seedTerminal({ terminalId: 't1' });
    const ok = await fetch(`${base}/api/terminals/t1/log`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/plain/);
    const missing = await fetch(`${base}/api/terminals/t2/log`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('');
  });

  it('terminal create answers CreatedBody including `host` (terminal/types.go)', async () => {
    const created = await (await fetch(`${base}/api/terminals`, { method: 'POST', ...json({ directory: '/d' }) })).json();
    expect(created).toHaveProperty('host', null);
    expect(created).toHaveProperty('terminalId');
  });

  it('persistent sessions: 404 for a non-hosted project, list, kill 204, unknown name 404, bad name 400 (persistent_session_routes.go)', async () => {
    relay.addHost({ id: 'h2', name: 'box2' });
    relay.addProject({ id: 'pp', name: 'PP', path: '/srv/y', host_id: 'h2' });
    relay.addProject({ id: 'local', name: 'L', path: '/tmp' });
    relay.seedPersistentSessions('pp', [{ name: 'relay-pp-t-1', template_id: 't', n: 1, created: 1700000000 }]);

    const notHosted = await fetch(`${base}/api/projects/local/persistent-sessions`);
    expect(notHosted.status).toBe(404);
    expect(await notHosted.json()).toEqual({ error: 'hosted project "local" not found' });

    const list = await (await fetch(`${base}/api/projects/pp/persistent-sessions`)).json();
    expect(list).toEqual([{ name: 'relay-pp-t-1', template_id: 't', n: 1, created: 1700000000, attached: 0, attached_here: false }]);

    expect((await fetch(`${base}/api/projects/pp/persistent-sessions/nonsense`, { method: 'DELETE' })).status).toBe(400);
    expect((await fetch(`${base}/api/projects/pp/persistent-sessions/relay-pp-t-9`, { method: 'DELETE' })).status).toBe(404);
    expect((await fetch(`${base}/api/projects/pp/persistent-sessions/relay-pp-t-1`, { method: 'DELETE' })).status).toBe(204);
    expect(await (await fetch(`${base}/api/projects/pp/persistent-sessions`)).json()).toEqual([]);

    relay.failPersistentSessionsWith('pp', 409, 'host has no tmux');
    const noTmux = await fetch(`${base}/api/projects/pp/persistent-sessions`);
    expect(noTmux.status).toBe(409);
    expect(await noTmux.json()).toEqual({ error: 'host has no tmux' });
  });

  it('POST /api/sessions: frontend_model_guard.go refusals', async () => {
    relay.addProject({ id: 'locked', name: 'Locked', path: '/tmp', allowed_models: ['ok-model'] });
    relay.addProject({ id: 'open', name: 'Open', path: '/tmp', allowed_models: ['*'] });
    relay.addHost({ id: 'h3', name: 'box3' });
    relay.addProject({ id: 'remote', name: 'Remote', path: '/srv/z', host_id: 'h3' });
    const post = (body) => fetch(`${base}/api/sessions`, { method: 'POST', ...json(body) });

    const denied = await post({ projectId: 'locked', model: 'other', directory: '/tmp' });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'model not allowed for this project' });

    expect((await post({ projectId: 'locked', model: 'ok-model', directory: '/tmp' })).status).toBe(201);
    expect((await post({ projectId: 'locked', directory: '/tmp' })).status).toBe(201); // server-default model
    expect((await post({ projectId: 'open', model: 'anything', directory: '/tmp' })).status).toBe(201);
    expect((await post({ projectId: 'unknown-project', model: 'x', directory: '/tmp' })).status).toBe(201);

    const remote = await post({ projectId: 'remote', model: 'x', directory: '/srv/z' });
    expect(remote.status).toBe(400);
    expect(await remote.json()).toEqual({ error: 'project remote is a remote project and cannot host a session' });
  });

  it('auth: with a token required, absent / malformed / wrong bearers all get the same text/plain 401 (frontend_server.go)', async () => {
    relay.requireToken('s3cret');
    try {
      const answers = [];
      for (const headers of [{}, { Authorization: 's3cret' }, { Authorization: 'Bearer wrong' }]) {
        const res = await fetch(`${base}/api/projects`, { headers });
        answers.push([res.status, res.headers.get('content-type'), await res.text()]);
      }
      expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
      expect(answers[0]).toEqual([401, 'text/plain; charset=utf-8', 'unauthorized\n']);
      expect((await fetch(`${base}/api/projects`, { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(200);
      expect(relay.rejectedRequests).toHaveLength(3);

      const refused = await new Promise((resolve) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
        ws.on('open', () => resolve('open'));
        ws.on('error', () => {});
      });
      expect(refused).toBe(401);
    } finally {
      relay.requireToken(null);
    }
  });
});

describe('projects as relay serves them (project_dto.go, project_routes.go)', () => {
  let relay;
  let base;
  beforeAll(async () => {
    relay = createFakeRelay();
    base = `http://127.0.0.1:${await relay.listen()}`;
    relay.addProject({ id: 'a', name: 'Alpha', path: '/tmp/a' });
    relay.addProject({ id: 'w', name: 'Work only', path: '/tmp/w', mode: 'work' });
    relay.addHost({ id: 'h', name: 'box' });
    relay.addProject({ id: 'r', name: 'Remote', path: '/srv/r', host_id: 'h' });
  });
  afterAll(async () => { await relay.close(); });
  const put = (mode, body) => fetch(`${base}/api/default_project/${mode}`, { method: 'PUT', ...json(body) });

  it('every project carries the effective mode ("both" when unset) and the always-present lists', async () => {
    const list = await (await fetch(`${base}/api/projects`)).json();
    const alpha = list.find((x) => x.id === 'a');
    expect(alpha).toMatchObject({ mode: 'both', allowed_mcp_ids: [], allowed_models: [], allowed_templates: [] });
    expect(alpha).toHaveProperty('created_at');
    expect(alpha).not.toHaveProperty('default_for');
    expect(list.find((x) => x.id === 'w').mode).toBe('work');
    expect(await (await fetch(`${base}/api/projects/a`)).json()).toEqual(alpha);
  });

  it('PUT /api/default_project/{mode} sets, reports and clears a default, and default_for follows', async () => {
    expect(await (await put('work', { project_id: 'w' })).json()).toEqual({ home: '', work: 'w' });
    expect(await (await put('home', { project_id: 'a' })).json()).toEqual({ home: 'a', work: 'w' });
    const list = await (await fetch(`${base}/api/projects`)).json();
    expect(list.find((x) => x.id === 'w').default_for).toEqual(['work']);
    expect(list.find((x) => x.id === 'a').default_for).toEqual(['home']);
    expect(await (await put('work', { project_id: '' })).json()).toEqual({ home: 'a', work: '' });
    expect((await (await fetch(`${base}/api/projects/w`)).json())).not.toHaveProperty('default_for');
  });

  it('refuses what config.SetDefaultProject refuses, with 400 and its message', async () => {
    const cases = [
      [put('both', { project_id: 'a' }), 'invalid default project: mode "both" has no default project; want home or work'],
      [put('work', { project_id: 'nope' }), 'invalid default project: no project with id "nope"'],
      [put('work', { project_id: 'r' }), 'invalid default project: project "r" is an access profile and cannot be a default project'],
      [put('home', { project_id: 'w' }), 'invalid default project: project "w" is work-only and cannot be the default for home'],
      [put('home', {}), 'project_id is required; send "" to clear the default'],
    ];
    for (const [pending, message] of cases) {
      const res = await pending;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: message });
    }
  });
});

describe('tasks as relayScheduler serves them (api.go, task.go, scheduler.go)', () => {
  let relay;
  let base;
  beforeAll(async () => {
    relay = createFakeRelay();
    base = `http://127.0.0.1:${await relay.listen()}`;
  });
  afterAll(async () => { await relay.close(); });
  const chat = (over = {}) => ({ name: 'Nightly', projectId: 'p1', prompt: 'Say hello.', model: 'm', schedule: { type: 'on_demand' }, enabled: true, ...over });
  const post = (body) => fetch(`${base}/api/tasks`, { method: 'POST', ...json(body) });
  const until = async (pred) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it.each([
    [{ name: '' }, 'name is required'],
    [{ projectId: '' }, 'projectId is required'],
    [{ schedule: undefined }, 'schedule is required'],
    [{ schedule: { type: 'once', at: '2001-01-01T00:00:00Z' } }, "invalid schedule: once schedule 'at' is in the past: 2001-01-01T00:00:00Z"],
    [{ prompt: '' }, 'prompt is required for chat tasks'],
    [{ model: '  ' }, 'task "Nightly": model is required for chat tasks'],
    [{ sessionType: 'pty' }, 'templateId is required for PTY tasks'],
    [{ sessionType: 'other' }, 'invalid sessionType "other" (expected "headless" or "pty")'],
  ])('create refuses %j with 400 "%s"', async (over, message) => {
    const res = await post(chat(over));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: message });
  });

  it('create is 201 with id, RFC 3339 times and a derived view; list filters by projectId', async () => {
    const res = await post(chat());
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task).toMatchObject({ name: 'Nightly', projectId: 'p1', enabled: true, catchUp: false, view: { kind: 'interactive' } });
    expect(task.id).toEqual(expect.any(String));
    expect(task.createdAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(task.view).not.toHaveProperty('hasLastRun');
    await post(chat({ projectId: 'p2', name: 'Other' }));
    expect((await (await fetch(`${base}/api/tasks?projectId=p1`)).json()).map((t) => t.name)).toEqual(['Nightly']);
    expect((await (await fetch(`${base}/api/tasks`)).json()).length).toBeGreaterThanOrEqual(2);
  });

  it('get / put / delete answer 404 {"error":"task not found"} for an unknown id', async () => {
    for (const [method, suffix, body] of [['GET', '', null], ['PUT', '', chat()], ['DELETE', '', null], ['GET', '/history', null], ['POST', '/run', null]]) {
      const res = await fetch(`${base}/api/tasks/ghost${suffix}`, { method, ...(body ? json(body) : {}) });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/task not found/);
    }
  });

  it('a pty task reports a readonly view', async () => {
    const task = await (await post(chat({ sessionType: 'pty', templateId: 'shell', prompt: '', model: '' }))).json();
    expect(task.view).toEqual({ kind: 'readonly' });
  });

  it('run: 200 started, then task_started and task_completed on /ws/tasks, history newest first, run state survives a PUT', async () => {
    const task = await (await post(chat({ name: 'Runner' }))).json();
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/tasks`);
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
    await until(() => frames.length > 0);
    expect(frames[0]).toEqual({ type: 'task_status', running: null });

    const run = await fetch(`${base}/api/tasks/${task.id}/run`, { method: 'POST' });
    expect(run.status).toBe(200);
    expect(await run.json()).toEqual({ success: true, message: 'Task execution started' });
    await until(() => frames.some((f) => f.type === 'task_completed'));
    const started = frames.find((f) => f.type === 'task_started');
    const done = frames.find((f) => f.type === 'task_completed');
    expect(started).toMatchObject({ taskId: task.id, projectId: 'p1', taskName: 'Runner', view: { kind: 'interactive', runId: expect.any(String) } });
    expect(done).toMatchObject({ taskId: task.id, status: 'success', view: { runId: started.view.runId } });

    const history = await (await fetch(`${base}/api/tasks/${task.id}/history`)).json();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ taskId: task.id, taskName: 'Runner', projectId: 'p1', status: 'success', sessionId: started.view.runId });
    expect(history[0].completedAt).toBeDefined();

    const stored = await (await fetch(`${base}/api/tasks/${task.id}`)).json();
    expect(stored).toMatchObject({ lastStatus: 'success', lastSessionId: started.view.runId, view: { hasLastRun: true, runId: started.view.runId } });
    const updated = await (await fetch(`${base}/api/tasks/${task.id}`, { method: 'PUT', ...json(chat({ name: 'Renamed' })) })).json();
    expect(updated).toMatchObject({ name: 'Renamed', lastStatus: 'success', lastSessionId: started.view.runId });
    ws.close();
  });

  it('a held run is running (409 on a second run, listed in task_status) until it fails with task_error', async () => {
    relay.holdTaskRuns();
    try {
      const task = await (await post(chat({ name: 'Slow' }))).json();
      expect((await fetch(`${base}/api/tasks/${task.id}/run`, { method: 'POST' })).status).toBe(200);
      const again = await fetch(`${base}/api/tasks/${task.id}/run`, { method: 'POST' });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: 'task is already running' });

      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/tasks`);
      const frames = [];
      ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
      await new Promise((r) => ws.once('open', r));
      await until(() => frames.length > 0);
      expect(frames[0].running).toEqual([expect.objectContaining({ taskId: task.id, taskName: 'Slow', projectId: 'p1' })]);

      relay.finishTask(task.id, { status: 'error', error: 'boom' });
      await until(() => frames.some((f) => f.type === 'task_error'));
      expect(frames.find((f) => f.type === 'task_error')).toMatchObject({ taskId: task.id, status: 'error', error: 'boom' });
      expect(relay.taskHistory(task.id)[0]).toMatchObject({ status: 'error', error: 'boom' });
      ws.close();
    } finally { relay.holdTaskRuns(false); }
  });

  it('delete is 200 {"deleted":true}; by-project reports the count', async () => {
    const a = await (await post(chat({ projectId: 'gone', name: 'A' }))).json();
    await post(chat({ projectId: 'gone', name: 'B' }));
    const del = await fetch(`${base}/api/tasks/${a.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ deleted: true });
    const bulk = await fetch(`${base}/api/tasks/by-project/gone`, { method: 'DELETE' });
    expect(await bulk.json()).toEqual({ deleted: 1 });
  });
});

describe('frame shapes (ws_session.go)', () => {
  let relay;
  let ws;
  beforeAll(async () => {
    relay = createFakeRelay();
    const port = await relay.listen();
    ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.frames = [];
    ws.on('message', (d) => ws.frames.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once('open', r));
  });
  afterAll(async () => { ws.close(); await relay.close(); });
  const next = async (pred) => {
    for (let i = 0; i < 100; i++) {
      const f = ws.frames.find(pred);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no frame');
  };

  it('session_joined carries the full frame and a live flag', async () => {
    ws.send(JSON.stringify({ type: 'join_session', sessionId: 'any' }));
    const joined = await next((f) => f.type === 'session_joined');
    expect(Object.keys(joined).sort()).toEqual(['directory', 'folder', 'history', 'host', 'headless', 'live', 'model', 'name', 'projectId', 'protocolVersion', 'sessionId', 'stats', 'type'].sort());
    expect(joined.live).toBe(true);
    expect(validateRelayFrame(joined).ok).toBe(true);
  });

  it('strictJoin: an unknown id gets an error frame with no sessionId; an empty id gets nothing', async () => {
    relay.strictJoin(true);
    ws.send(JSON.stringify({ type: 'join_session', sessionId: '' }));
    ws.send(JSON.stringify({ type: 'join_session', sessionId: 'nope' }));
    const err = await next((f) => f.type === 'error');
    expect(err).toEqual({ type: 'error', message: 'session not found: nope' });
    relay.strictJoin(false);
  });

  it('resume_required carries a message', () => {
    expect(relayFrames.resumeRequired({ sessionId: 's' })).toMatchObject({ code: 'resume_required', sessionId: 's', message: expect.any(String) });
  });
});

describe('eve against a relay that refuses, drops or rejects', () => {
  let projectDir;
  beforeAll(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-fid-')); });
  afterAll(() => { fs.rmSync(projectDir, { recursive: true, force: true }); });

  const project = (extra = {}) => ({ id: 'p1', name: 'T', path: projectDir, ...extra });

  it('with a matching token every call works and nothing is rejected', async () => {
    const eve = await startEve({ projects: [project()], relayToken: 'test-token' });
    try {
      const res = await eve.get('/api/projects');
      expect(res.status).toBe(200);
      expect(eve.relay.rejectedRequests).toEqual([]);
    } finally { await eve.stop(); }
  });

  it('with the wrong token relay 401s eve; the upstream leg stays down and no session is created', async () => {
    const eve = await startEve({ projects: [project()], relayToken: 'the-real-one' });
    try {
      const res = await eve.get('/api/models');
      expect(res.status).toBe(401); // relay's status passes through; body is its text/plain, JSON-quoted
      expect(eve.relay.rejectedRequests.length).toBeGreaterThan(0);

      const ws = await eve.connectWs();
      try {
        ws.send({ type: 'create_session', projectId: 'p1' });
        // The upgrade itself is refused, so the upstream leg never opens.
        await ws.waitFor((f) => f.type === 'relay_status' && f.connected === false);
        const err = await ws.waitFor((f) => f.type === 'error');
        expect(err.message).toBe('Failed to create session');
        expect(ws.frames.some((f) => f.type === 'session_created')).toBe(false);
      } finally { await ws.close(); }
    } finally { await eve.stop(); }
  });

  it('a model outside the project allowlist: the browser gets relay\'s own error and no session', async () => {
    const eve = await startEve({ projects: [project({ allowed_models: ['ok-model'] })] });
    const ws = await eve.connectWs();
    try {
      ws.send({ type: 'create_session', projectId: 'p1', model: 'other-model' });
      const err = await ws.waitFor((f) => f.type === 'error');
      expect(err.message).toBe('model not allowed for this project');
      expect(eve.relay.listSessions()).toHaveLength(0);

      const from = ws.mark();
      ws.send({ type: 'create_session', projectId: 'p1', model: 'ok-model' });
      await ws.waitFor((f) => f.type === 'session_created', 5000, from);
    } finally { await ws.close(); await eve.stop(); }
  });

  it('a session on a remote (host) project is refused with relay\'s 400 text', async () => {
    const eve = await startEve({
      hosts: [{ id: 'h1', name: 'box' }],
      projects: [project({ id: 'rp', path: '/srv/app', host_id: 'h1' })],
    });
    const ws = await eve.connectWs();
    try {
      ws.send({ type: 'create_session', projectId: 'rp', directory: '/srv/app', model: 'x' });
      const err = await ws.waitFor((f) => f.type === 'error');
      expect(err.message).toBe('project rp is a remote project and cannot host a session');
    } finally { await ws.close(); await eve.stop(); }
  });

  it.each([
    [502, { error: 'launch failed' }],
    [503, { error: 'session host unavailable' }],
  ])('a %s from session create reaches the browser as relay\'s error text', async (status, body) => {
    const eve = await startEve({ projects: [project()] });
    const ws = await eve.connectWs();
    try {
      eve.relay.failSessionCreateWith(status, body);
      ws.send({ type: 'create_session', projectId: 'p1' });
      const err = await ws.waitFor((f) => f.type === 'error');
      expect(err.message).toBe(body.error);
      expect(ws.frames.some((f) => f.type === 'session_created')).toBe(false);
    } finally { await ws.close(); await eve.stop(); }
  });

  it('relay closing the socket with 1011 "upstream unreachable": eve reports it down, reconnects and joins again', async () => {
    const eve = await startEve({ projects: [project()] });
    const ws = await eve.connectWs();
    try {
      ws.send({ type: 'create_session', projectId: 'p1' });
      const created = await ws.waitFor((f) => f.type === 'session_created');
      await eve.relay.waitForInbound((f) => f.type === 'join_session' && f.sessionId === created.sessionId);
      await new Promise((r) => setTimeout(r, 200));

      const from = ws.mark();
      eve.relay.closeRelaySockets(1011, 'upstream unreachable');
      await ws.waitFor((f) => f.type === 'relay_status' && f.connected === false, 5000, from);
      await ws.waitFor((f) => f.type === 'relay_status' && f.connected === true, 10000, from);

      const from2 = ws.mark();
      ws.send({ type: 'join_session', sessionId: created.sessionId });
      const joined = await ws.waitFor((f) => f.type === 'session_joined', 5000, from2);
      expect(joined.sessionId).toBe(created.sessionId);
    } finally { await ws.close(); await eve.stop(); }
  });

  it('a permission_response from a connection that never joined the session is refused, and nobody else sees the request', async () => {
    const eve = await startEve({ projects: [project()] });
    const joiner = await eve.connectWs();
    const bystander = await eve.connectWs();
    try {
      joiner.send({ type: 'create_session', projectId: 'p1' });
      const created = await joiner.waitFor((f) => f.type === 'session_created');
      await eve.relay.waitForInbound((f) => f.type === 'join_session' && f.sessionId === created.sessionId);
      await new Promise((r) => setTimeout(r, 200));

      const delivered = eve.relay.emitToSession(created.sessionId, relayFrames.permissionRequest({
        sessionId: created.sessionId, permissionId: 'perm-x', toolName: 'Bash', toolInput: '{}', toolUseId: 'tu',
      }));
      expect(delivered).toBe(1);
      await joiner.waitFor((f) => f.type === 'permission_request' && f.permissionId === 'perm-x');
      expect(bystander.frames.some((f) => f.type === 'permission_request')).toBe(false);

      // The bystander answers a request it never saw: relay refuses.
      bystander.send({ type: 'permission_response', permissionId: 'perm-x', approved: true });
      const refusal = await bystander.waitFor((f) => f.type === 'error');
      expect(refusal.message).toBe(`permission response refused: this connection has not joined session ${created.sessionId}`);

      // The joined connection's answer resolves it; a second answer is a silent no-op.
      joiner.send({ type: 'permission_response', permissionId: 'perm-x', approved: true });
      await eve.relay.waitForInbound((f) => f.type === 'permission_response' && f.permissionId === 'perm-x' && f.__relaySocketId !== undefined);
      const before = joiner.frames.length;
      joiner.send({ type: 'permission_response', permissionId: 'perm-x', approved: true });
      await new Promise((r) => setTimeout(r, 300));
      expect(joiner.frames.slice(before).some((f) => f.type === 'error')).toBe(false);
    } finally { await joiner.close(); await bystander.close(); await eve.stop(); }
  });

  it('persistent sessions: list and kill proxy through with relay\'s statuses', async () => {
    const eve = await startEve({
      hosts: [{ id: 'h1', name: 'box' }],
      projects: [project({ id: 'rp', path: '/srv/app', host_id: 'h1' })],
    });
    try {
      eve.relay.seedPersistentSessions('rp', [{ name: 'relay-rp-t-1', template_id: 't', n: 1, created: 1 }]);
      const list = await eve.get('/api/projects/rp/persistent-sessions');
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual([expect.objectContaining({ name: 'relay-rp-t-1', template_id: 't' })]);

      const kill = await eve.get('/api/projects/rp/persistent-sessions/relay-rp-t-1', { method: 'DELETE' });
      expect(kill.status).toBe(204);
      const again = await eve.get('/api/projects/rp/persistent-sessions/relay-rp-t-1', { method: 'DELETE' });
      expect(again.status).toBe(404);

      eve.relay.failPersistentSessionsWith('rp', 502, 'host unreachable');
      const down = await eve.get('/api/projects/rp/persistent-sessions');
      expect(down.status).toBe(502);
      expect(await down.json()).toEqual({ error: 'host unreachable' });
    } finally { await eve.stop(); }
  });

  it('GET /api/sessions through eve hands the browser relay\'s Summary rows (`id`, `live`)', async () => {
    const eve = await startEve({ projects: [project()] });
    try {
      eve.relay.seedSession({ sessionId: 's-dormant', directory: projectDir, projectId: 'p1', model: 'm', name: 'old', live: false });
      const rows = await (await eve.get('/api/sessions')).json();
      expect(rows).toEqual([expect.objectContaining({ id: 's-dormant', live: false, name: 'old' })]);
      expect(rows[0]).not.toHaveProperty('sessionId');
    } finally { await eve.stop(); }
  });
});
