const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const express = require('express');

jest.mock('../../relay-client');
jest.mock('../../file-watcher');

const registerRoutes = require('../../routes/index');
const FileService = require('../../file-service');
const { Logger } = require('../../logger');
const { traceMiddleware } = require('../../trace');
const RelayClientMock = require('../../relay-client');
const FileWatcherMock = require('../../file-watcher');
const createWsHandler = require('../../ws-handler');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'logging-schema.json'), 'utf8'));
const TRACE_RE = new RegExp(schema.properties.trace_id.pattern);
const OP_RE = new RegExp(schema.properties.op.pattern);
const TS_RE = new RegExp(schema.properties.ts.pattern);
const VALID_TRACE = /^[A-Za-z0-9_-]{8,64}$/;

function collector() {
  const writes = [];
  const stream = { write: (s) => { writes.push(s); return true; } };
  return { stream, lines: () => writes.map((w) => JSON.parse(w)), raw: () => writes.join('') };
}

// Required keys, patterns and the status/level pairing from the logging standard.
function expectValidLine(line) {
  for (const k of schema.required) expect(line).toHaveProperty(k);
  expect(line.ts).toMatch(TS_RE);
  expect(line.op).toMatch(OP_RE);
  expect(line.msg.length).toBeLessThanOrEqual(500);
  expect(line.error.length).toBeLessThanOrEqual(500);
  expect(Number.isInteger(line.duration_ms) && line.duration_ms >= 0).toBe(true);
  expect(line.trace_id).toMatch(TRACE_RE);
  expect(['ok', 'error', 'denied']).toContain(line.status);
  const allowed = { ok: ['info', 'debug'], denied: ['warn'], error: ['warn', 'error'] }[line.status];
  expect(allowed).toContain(line.level);
  if (line.status === 'ok') expect(line.error).toBe('');
}

describe('proxied route logging and trace carriage', () => {
  let server;
  let baseUrl;
  let transport;
  let sink;

  beforeEach((done) => {
    delete process.env.EVE_NO_AUTH;
    sink = collector();
    transport = { fetch: jest.fn(), fetchRaw: jest.fn() };
    const app = express();
    app.use(express.json());
    app.use(traceMiddleware());
    registerRoutes(app, {
      authService: {
        isEnrolled: jest.fn(() => false), validateSession: jest.fn(() => false), checkRateLimit: jest.fn(() => true),
      },
      trustedNetwork: { isTrusted: jest.fn(() => false) },
      relayTransport: transport,
      refreshProjectCache: jest.fn(),
      removeFromProjectCache: jest.fn(),
      resolveProject: jest.fn(() => null),
      fileService: new FileService(),
      fileServiceFor: jest.fn(() => new FileService()),
      refreshHostCache: jest.fn(),
      removeFromHostCache: jest.fn(),
      hostPool: { disconnect: jest.fn() },
      ttsService: {},
      sttService: {},
      log: new Logger('info', { stream: sink.stream, service: 'eve' }),
    });
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterEach((done) => { server.close(done); });

  it('POST /api/tasks forwards the inbound trace id and logs one schedule.create line carrying job_id', async () => {
    transport.fetch.mockResolvedValue({ status: 200, data: { id: 'job-42', name: 'nightly' } });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace-id': 'trace-abc12345' },
      body: JSON.stringify({ name: 'nightly', secret: 'BODYCANARY' }),
    });
    expect(res.status).toBe(200);
    expect(transport.fetch).toHaveBeenCalledWith('POST', '/api/tasks', expect.anything(), { traceId: 'trace-abc12345' });

    const lines = sink.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      op: 'schedule.create', job_id: 'job-42', status: 'ok', level: 'info', trace_id: 'trace-abc12345',
    });
    expectValidLine(lines[0]);
  });

  it('a non-schedule proxied route logs op http.request with no job_id', async () => {
    transport.fetch.mockResolvedValue({ status: 200, data: { id: 'x-1', models: [] } });
    await fetch(`${baseUrl}/api/models`);
    const lines = sink.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ op: 'http.request', status: 'ok', level: 'info' });
    expect(lines[0]).not.toHaveProperty('job_id');
    expectValidLine(lines[0]);
  });

  it.each([
    [200, 'ok', 'info', 200],
    [401, 'denied', 'warn', 401],
    [403, 'denied', 'warn', 403],
    [404, 'error', 'warn', 404],
    [500, 'error', 'error', 500],
    ['throw', 'error', 'error', 502],
  ])('upstream %s -> status %s, level %s, answers %s, exactly one valid line', async (upstream, status, level, answer) => {
    if (upstream === 'throw') transport.fetch.mockRejectedValue(new Error('relay down'));
    else transport.fetch.mockResolvedValue({ status: upstream, data: { id: 'job-1' } });
    const res = await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'n' }),
    });
    expect(res.status).toBe(answer);
    const lines = sink.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status, level });
    expectValidLine(lines[0]);
  });

  it('never writes the request body or the query string', async () => {
    transport.fetch.mockResolvedValue({ status: 200, data: { id: 'job-9' } });
    await fetch(`${baseUrl}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'n', secret: 'BODYCANARY' }),
    });
    await fetch(`${baseUrl}/api/tasks?projectId=QUERYCANARY`);
    expect(transport.fetch).toHaveBeenCalledWith('GET', expect.stringContaining('QUERYCANARY'), undefined, expect.anything());
    expect(sink.lines()).toHaveLength(2);
    expect(sink.raw()).not.toContain('BODYCANARY');
    expect(sink.raw()).not.toContain('QUERYCANARY');
    expect(sink.raw()).not.toContain('projectId');
  });
});

describe('ws user_input trace and chat.turn line', () => {
  const flush = () => new Promise((r) => setImmediate(r));
  let relayClient;
  let sink;
  let ws;

  beforeEach(() => {
    delete process.env.EVE_NO_AUTH;
    sink = collector();
    relayClient = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
      sendMessage: jest.fn(),
      send: jest.fn(),
      currentSessionId: null,
      voiceMode: false,
    };
    RelayClientMock.mockImplementation(() => relayClient);
    FileWatcherMock.mockImplementation(() => ({ closeAll: jest.fn() }));
    const handler = createWsHandler({
      authService: { isEnrolled: () => false, validateSession: () => true },
      trustedNetwork: { isTrusted: () => true },
      relayTransport: { fetch: jest.fn(), createWebSocket: jest.fn() },
      fileHandlers: { fileServiceFor: jest.fn() },
      searchSummarizer: null,
      resolveProject: jest.fn(),
      ttsService: null,
      sttService: null,
      uiBus: { register: jest.fn(), unregister: jest.fn() },
      log: new Logger('info', { stream: sink.stream, service: 'eve' }),
    });
    ws = new EventEmitter();
    ws.send = jest.fn();
    ws.close = jest.fn();
    handler(ws, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  });

  async function send(obj) {
    ws.emit('message', Buffer.from(JSON.stringify(obj)));
    await flush();
  }
  const traceOf = (i) => relayClient.sendMessage.mock.calls[i][3].traceId;

  it('gives each turn its own valid trace id', async () => {
    await send({ type: 'user_input', text: 'one', sessionId: 's1' });
    await send({ type: 'user_input', text: 'two', sessionId: 's1' });
    expect(relayClient.sendMessage).toHaveBeenCalledTimes(2);
    expect(traceOf(0)).toMatch(VALID_TRACE);
    expect(traceOf(1)).toMatch(VALID_TRACE);
    expect(traceOf(0)).not.toBe(traceOf(1));
  });

  it('keeps a valid inbound trace_id and replaces an invalid one', async () => {
    await send({ type: 'user_input', text: 'a', sessionId: 's1', trace_id: 'client-trace-01' });
    await send({ type: 'user_input', text: 'b', sessionId: 's1', trace_id: 'bad id\n{"x":1}' });
    expect(traceOf(0)).toBe('client-trace-01');
    expect(traceOf(1)).toMatch(VALID_TRACE);
    expect(traceOf(1)).not.toContain('bad');
  });

  it('writes one chat.turn info line with session_id and never the text', async () => {
    await send({ type: 'user_input', text: 'TEXTCANARY hello', sessionId: 's-77', trace_id: 'client-trace-02' });
    const lines = sink.lines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      op: 'chat.turn', level: 'info', status: 'ok', session_id: 's-77', trace_id: 'client-trace-02',
    });
    expectValidLine(lines[0]);
    expect(sink.raw()).not.toContain('TEXTCANARY');
  });
});

describe('RelayClient resume path trace carriage', () => {
  it('the resume fetch and the resend reuse the original trace id', async () => {
    const Real = jest.requireActual('../../relay-client');
    const sent = [];
    const upstream = { readyState: 1, send: jest.fn((d) => sent.push(JSON.parse(d))), close: jest.fn() };
    const browser = { readyState: 1, send: jest.fn(), close: jest.fn() };
    const transport = { createWebSocket: jest.fn(), fetch: jest.fn().mockResolvedValue({ status: 200, data: {} }) };
    const client = new Real(transport, browser, null, null);
    client.ws = upstream;
    client.pendingUserMessage = { sessionId: 's1', text: 'hi', files: [], traceId: 'orig-trace-0001' };

    await client._handleRelayMessage({ type: 'error', code: 'resume_required', sessionId: 's1' });

    expect(transport.fetch).toHaveBeenCalledWith('POST', '/api/sessions/s1/resume', undefined, { traceId: 'orig-trace-0001' });
    const resend = sent.find((m) => m.type === 'send_message');
    expect(resend).toMatchObject({ sessionId: 's1', text: 'hi', trace_id: 'orig-trace-0001' });
    client.close();
  });
});
