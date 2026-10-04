/**
 * Trace id on the wire (RelayTransport against real loopback and unix-socket
 * servers) and end to end (the real eve process's stderr against the fake relay).
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { RelayTransport } = require('../../relay-transport');
const { startEve } = require('./harness');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'logging-schema.json'), 'utf8'));
const HEX32 = /^[0-9a-f]{32}$/;
const GIVEN = 'abcd1234efgh5678';

// Test-local checker for the keywords the schema uses; throws on any other.
const OK_KEYS = new Set(['$schema', '$id', 'title', 'description', 'type', 'required', 'enum', 'pattern', 'maxLength', 'minLength', 'minimum', 'additionalProperties', 'properties']);
function check(s, v, at = '$') {
  for (const k of Object.keys(s)) if (!OK_KEYS.has(k)) throw new Error(`unsupported schema keyword: ${k}`);
  const errs = [];
  const types = { object: (x) => x && typeof x === 'object' && !Array.isArray(x), string: (x) => typeof x === 'string', integer: Number.isInteger };
  if (s.type && !types[s.type](v)) return [`${at}: not ${s.type}`];
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: not in enum`);
  if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${at}: pattern`);
  if (s.maxLength !== undefined && v.length > s.maxLength) errs.push(`${at}: too long`);
  if (s.minLength !== undefined && v.length < s.minLength) errs.push(`${at}: too short`);
  if (s.minimum !== undefined && v < s.minimum) errs.push(`${at}: below minimum`);
  if (s.type === 'object') {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${at}.${r}: missing`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) errs.push(...check(sub, v[k], `${at}.${k}`));
  }
  return errs;
}

const jsonLines = (text) => text.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));

async function until(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('RelayTransport carries X-Trace-Id on-box', () => {
  let dir;
  const servers = [];

  // Echo server: answers every request with 200 and records the trace header
  // of every request and every WebSocket upgrade.
  function startServer(listenArg) {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.headers['x-trace-id']); res.end('{}'); });
    const wss = new WebSocket.Server({ server });
    wss.on('connection', (_ws, req) => seen.push(req.headers['x-trace-id']));
    servers.push(server);
    return new Promise((resolve) => server.listen(listenArg, () => resolve({ server, seen })));
  }

  afterAll(() => {
    servers.forEach((s) => s.close());
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const modes = [
    ['loopback http', async () => {
      const { server, seen } = await startServer({ port: 0, host: '127.0.0.1' });
      return { seen, transport: new RelayTransport({ socketPath: null, url: `http://127.0.0.1:${server.address().port}`, token: 't' }) };
    }],
    ['unix socket', async () => {
      dir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'eve-trace-'));
      const sock = path.join(dir, `r${servers.length}.sock`);
      const { seen } = await startServer(sock);
      return { seen, transport: new RelayTransport({ socketPath: sock, url: 'http://localhost:3001', token: null }) };
    }],
  ];

  const calls = {
    fetch: (t, opts) => t.fetch('POST', '/api/x', { a: 1 }, opts),
    fetchRaw: (t, opts) => t.fetchRaw('GET', '/api/x', opts),
    createWebSocket: (t, opts) => new Promise((resolve, reject) => {
      const ws = t.createWebSocket('/ws', opts);
      ws.on('open', () => { ws.close(); resolve(); });
      ws.on('error', reject);
    }),
  };

  describe.each(modes)('%s', (_mode, build) => {
    let ctx;
    beforeAll(async () => { ctx = await build(); });

    describe.each(Object.keys(calls))('%s', (name) => {
      const header = async (opts) => {
        const before = ctx.seen.length;
        await calls[name](ctx.transport, opts);
        await until(() => ctx.seen.length > before);
        return ctx.seen[ctx.seen.length - 1];
      };
      it('sends the given valid id', async () => { expect(await header({ traceId: GIVEN })).toBe(GIVEN); });
      it('sends a fresh id when none is given', async () => { expect(await header(undefined)).toMatch(HEX32); });
      it('replaces an invalid id', async () => {
        const sent = await header({ traceId: 'bad id\n!' });
        expect(sent).toMatch(HEX32);
      });
    });
  });
});

describe('RelayTransport off-box never sends X-Trace-Id', () => {
  afterEach(() => jest.restoreAllMocks());

  it('fetch and fetchRaw over https to a remote host', async () => {
    const sent = [];
    jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
      sent.push(opts.headers);
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => { const res = new EventEmitter(); cb(res); res.emit('end'); };
      return req;
    });
    const t = new RelayTransport({ socketPath: null, url: 'https://relay.example:8443', token: 'tok' });
    await t.fetch('GET', '/api/x', undefined, { traceId: GIVEN });
    await t.fetchRaw('GET', '/api/x', { traceId: GIVEN });
    expect(sent).toHaveLength(2);
    for (const h of sent) expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('x-trace-id');
  });

  it('createWebSocket to a remote host', () => {
    let RT;
    let captured;
    jest.isolateModules(() => {
      jest.doMock('ws', () => jest.fn().mockImplementation(function (url, options) { captured = options; }));
      RT = require('../../relay-transport').RelayTransport;
    });
    new RT({ socketPath: null, url: 'https://relay.example:8443', token: 'tok' }).createWebSocket('/ws', { traceId: GIVEN });
    expect(Object.keys(captured.headers || {}).map((k) => k.toLowerCase())).not.toContain('x-trace-id');
    jest.dontMock('ws');
  });
});

describe('eve end to end (stderr at RELAY_LOG_LEVEL=info)', () => {
  let eve;
  let ws;
  const task = { name: 'Acme brief', projectId: 'p1', sessionType: 'headless', prompt: 'p', model: 'fake-model', schedule: { type: 'on_demand' }, enabled: true };

  beforeAll(async () => {
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: os.tmpdir() }], env: { RELAY_LOG_LEVEL: 'info' } });
    ws = await eve.connectWs();
    await eve.relay.waitForRelay();
  });
  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
  });

  it('a task create logs schedule.create with the inbound trace id and the created job id', async () => {
    const res = await fetch(`${eve.baseUrl}/api/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trace-Id': GIVEN }, body: JSON.stringify(task),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    const line = await until(() => jsonLines(eve.stderr()).find((l) => l.op === 'schedule.create'));
    expect(line).toMatchObject({ trace_id: GIVEN, job_id: created.id, status: 'ok', level: 'info' });
  });

  it('a user_input reaches relay with the trace id its chat.turn line logs', async () => {
    const from = ws.mark();
    ws.send({ type: 'create_session', projectId: 'p1' });
    const { sessionId } = await ws.waitFor((f) => f.type === 'session_created', 5000, from);
    ws.send({ type: 'user_input', text: 'hello there', sessionId });
    const sent = await eve.relay.waitForInbound((m) => m.type === 'send_message' && m.sessionId === sessionId);
    expect(sent.trace_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const line = await until(() => jsonLines(eve.stderr()).find((l) => l.op === 'chat.turn' && l.session_id === sessionId));
    expect(line.trace_id).toBe(sent.trace_id);
  });

  it('every JSON line on stderr matches the schema', () => {
    const lines = jsonLines(eve.stderr());
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(check(schema, l)).toEqual([]);
  });
});

describe('eve never logs content at RELAY_LOG_LEVEL=debug', () => {
  it('keeps prompt, task body, query, session token and relay token out of stderr', async () => {
    const eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: os.tmpdir() }], env: { RELAY_LOG_LEVEL: 'debug' } });
    const ws = await eve.connectWs();
    try {
      await eve.relay.waitForRelay();
      const from = ws.mark();
      ws.send({ type: 'auth', token: 'canary-ws-token' });
      ws.send({ type: 'create_session', projectId: 'p1' });
      const { sessionId } = await ws.waitFor((f) => f.type === 'session_created', 5000, from);
      ws.send({ type: 'user_input', text: 'canary-prompt-text', sessionId });
      await eve.relay.waitForInbound((m) => m.type === 'send_message' && m.sessionId === sessionId);
      const post = await fetch(`${eve.baseUrl}/api/tasks?secret=canary-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': 'canary-session-token' },
        body: JSON.stringify({ name: 'Acme', projectId: 'p1', sessionType: 'headless', prompt: 'canary-task-body', model: 'fake-model', schedule: { type: 'on_demand' } }),
      });
      expect(post.status).toBe(201);
      await until(() => jsonLines(eve.stderr()).some((l) => l.op === 'schedule.create'));
      await new Promise((r) => setTimeout(r, 300));

      const out = eve.stderr();
      expect(jsonLines(out).length).toBeGreaterThan(0);
      for (const canary of ['canary-prompt-text', 'canary-task-body', 'canary-query', 'canary-session-token', 'canary-ws-token', 'test-token']) {
        expect(out).not.toContain(canary);
      }
      for (const l of jsonLines(out)) expect(check(schema, l)).toEqual([]);
    } finally {
      await ws.close();
      await eve.stop();
    }
  });
});
