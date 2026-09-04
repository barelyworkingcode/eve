/**
 * Fake relay — an in-process contract double for relay's frontend, used by
 * the integration harness. No real relay / relayLLM / LLM involved.
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const { relayFrames, EVENT_PROTOCOL_VERSION } = require('./protocol');

// Built from the protocol contract so the fake can't silently diverge from it.
function defaultStream(sessionId) {
  return [
    relayFrames.assistantDelta({ sessionId, text: 'Hello ' }),
    relayFrames.assistantDelta({ sessionId, text: 'from fake relay' }),
    relayFrames.messageComplete({ sessionId }),
  ];
}

// The real browser drops version-less llm_event frames, so the fake must
// never emit them — otherwise a test could pass against frames production
// would silently discard.
function stampFrame(f, sessionId) {
  const out = { ...f, sessionId };
  if (out.type === 'llm_event' && out.event && out.event.v === undefined) {
    out.event = { ...out.event, v: EVENT_PROTOCOL_VERSION };
  }
  return out;
}

function createFakeRelay() {
  const projects = new Map();
  const sessions = new Map();
  const sessionScripts = new Map();
  const requests = [];
  const inbound = [];
  const inboundWaiters = [];
  const relayWs = new Set();
  // Lets a test tell which of eve's (possibly several) relay upstreams a
  // frame arrived on — the only cover for the two-connection isolation tests.
  const relaySocketIds = new WeakMap();
  let relaySocketSeq = 0;
  const schedulerWs = new Set();
  const schedulerResolvers = [];
  const relayResolvers = [];
  let seq = 0;
  let closed = false;
  let sessionCreateGate = null;

  const recordInbound = (msg) => {
    inbound.push(msg);
    for (let i = inboundWaiters.length - 1; i >= 0; i--) {
      if (inboundWaiters[i].pred(msg)) { inboundWaiters[i].resolve(msg); inboundWaiters.splice(i, 1); }
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://relay.local');
    const p = url.pathname;
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, path: p });
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}

      // Mirrors the real relay's path validation (filepath.IsAbs): the
      // frontend sends "~/..." verbatim and the backend does not expand it,
      // so relative paths get a 400, not a 201.
      const isAbsPath = (pth) => typeof pth === 'string' && pth.startsWith('/');
      const absPathError = (pth) => send(400, { error: `project path must be an absolute path: ${JSON.stringify(pth ?? '')}` });
      if (p === '/api/projects' && req.method === 'GET') return send(200, [...projects.values()]);
      if (p === '/api/projects' && req.method === 'POST') {
        if (!isAbsPath(parsed.path)) return absPathError(parsed.path);
        const id = parsed.id || `proj-${++seq}`;
        const proj = { ...parsed, id };
        projects.set(id, proj);
        return send(201, proj);
      }
      const pm = p.match(/^\/api\/projects\/([^/]+)$/);
      if (pm) {
        const id = pm[1];
        if (req.method === 'GET') return projects.has(id) ? send(200, projects.get(id)) : send(404, { error: 'Project not found' });
        if (req.method === 'PUT') {
          if (parsed.path !== undefined && !isAbsPath(parsed.path)) return absPathError(parsed.path);
          const proj = { ...(projects.get(id) || {}), ...parsed, id };
          projects.set(id, proj);
          return send(200, proj);
        }
        if (req.method === 'DELETE') { projects.delete(id); return send(200, {}); }
      }

      // Tracked in `sessions` so a later GET /api/sessions — the reconnect/
      // reload restore path's only session source — can see it. Real
      // relayLLM has no concept of eve's UI-only `sessionType` ("chat" vs
      // "voice"), so it's deliberately not stored here: restoring that
      // distinction after a reload is `eve-session-meta`'s job alone.
      if (p === '/api/sessions' && req.method === 'POST') {
        const respond = () => {
          const sessionId = parsed.sessionId || `sess-${++seq}`;
          const session = {
            sessionId,
            directory: parsed.directory || '/fake',
            projectId: parsed.projectId || null,
            model: parsed.model || 'fake-model',
            name: parsed.name || '',
          };
          sessions.set(sessionId, session);
          return send(201, session);
        };
        // Held open until the test releases it — see holdSessionCreate().
        if (sessionCreateGate) return sessionCreateGate.then(respond);
        return respond();
      }
      const sm = p.match(/^\/api\/sessions\/([^/]+)$/);
      if (sm && req.method === 'DELETE') { sessions.delete(sm[1]); return send(200, {}); }
      if (p === '/api/sessions' && req.method === 'GET') return send(200, [...sessions.values()]);

      if (p === '/api/models' && req.method === 'GET') return send(200, [{ id: 'fake-model', name: 'Fake Model' }]);
      if (p === '/api/mcps' && req.method === 'GET') return send(200, []);
      if (p === '/api/tasks' && req.method === 'GET') return send(200, []);
      // GET /api/tasks/:id is deliberately left unimplemented (falls through
      // to the 404 below): it must 404, not return [] — a wrong shape, since
      // the real endpoint returns one object.

      if (p.startsWith('/api/generated/') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(Buffer.from('FAKE-PNG-BYTES'));
      }
      if (/^\/api\/terminals\/.+\/log$/.test(p) && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(Buffer.from('TERMINAL-LOG-BYTES'));
      }

      return send(404, { error: `fake-relay: unhandled ${req.method} ${p}` });
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const isScheduler = (req.url || '').startsWith('/ws/tasks');
    (isScheduler ? schedulerWs : relayWs).add(ws);
    if (!isScheduler) relaySocketIds.set(ws, ++relaySocketSeq);
    (isScheduler ? schedulerResolvers : relayResolvers).splice(0).forEach((r) => r());

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!isScheduler) msg.__relaySocketId = relaySocketIds.get(ws);
      recordInbound(msg);
      if (isScheduler) return;
      if (msg.type === 'join_session') {
        ws.send(JSON.stringify(relayFrames.sessionJoined({ sessionId: msg.sessionId })));
      } else if (msg.type === 'send_message') {
        const script = sessionScripts.get(msg.sessionId);
        const frames = script
          ? script.map((f) => stampFrame(f, msg.sessionId))
          : defaultStream(msg.sessionId);
        for (const f of frames) ws.send(JSON.stringify(f));
      }
    });
    ws.on('close', () => { relayWs.delete(ws); schedulerWs.delete(ws); });
    ws.on('error', () => {});
  });

  return {
    addProject: (proj) => { projects.set(proj.id, proj); },
    // For reload/restore tests that need GET /api/sessions to already know
    // about an id a localStorage fixture references, without a real POST.
    seedSession: (session) => { sessions.set(session.sessionId, session); },
    getProject: (id) => projects.get(id),
    listProjects: () => [...projects.values()],
    listSessions: () => [...sessions.values()],
    scriptSession: (sessionId, frames) => { sessionScripts.set(sessionId, frames); },
    emitToRelay: (frame) => { for (const ws of relayWs) ws.send(JSON.stringify(frame)); },
    emitToScheduler: (frame) => { for (const ws of schedulerWs) ws.send(JSON.stringify(frame)); },
    waitForRelay: () => (relayWs.size > 0 ? Promise.resolve() : new Promise((r) => relayResolvers.push(r))),
    relayConnectionCount: () => relayWs.size,
    // Delays the reply to POST /api/sessions until release() is called, so a
    // test can pin down a state window that would otherwise race the real
    // cross-process round trip (HTTP POST, then a WS session_created push).
    holdSessionCreate: () => {
      let release;
      sessionCreateGate = new Promise((resolve) => { release = resolve; });
      return { release: () => { release(); sessionCreateGate = null; } };
    },
    waitForScheduler: () => (schedulerWs.size > 0 ? Promise.resolve() : new Promise((r) => schedulerResolvers.push(r))),
    inbound,
    waitForInbound: (pred, timeoutMs = 5000) => new Promise((resolve, reject) => {
      const existing = inbound.find(pred);
      if (existing) return resolve(existing);
      const t = setTimeout(() => reject(new Error('waitForInbound: timed out')), timeoutMs);
      inboundWaiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    }),
    requests,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      if (closed) return resolve(); // a resilience test may close the relay before the harness does
      closed = true;
      for (const ws of [...relayWs, ...schedulerWs]) { try { ws.terminate(); } catch {} }
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

module.exports = { createFakeRelay };
