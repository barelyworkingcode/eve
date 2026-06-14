/**
 * Fake relay — an in-process contract double for relay's frontend, used by the
 * integration harness. It plays the project + session store, answers the HTTP
 * endpoints eve proxies, and scripts the relay→eve WS frame stream. NO real
 * relay / relayLLM / LLM involved.
 *
 * The WS contract eve depends on (consumed in relay-client.js / module-invoker.js):
 *   eve → relay:  { type:'join_session', sessionId }
 *                 { type:'send_message', text, files, sessionId }
 *   relay → eve:  { type:'session_joined', sessionId, directory }
 *                 { type:'llm_event', sessionId, event:{ type:'assistant',
 *                     delta:{ type:'text_delta', text } } }
 *                 { type:'message_complete', sessionId, error? }
 *
 * Scriptable surface:
 *   addProject(p) / getProject(id) / listProjects()
 *   scriptSession(sessionId, frames)  — frames streamed in reply to send_message
 *                                       (sessionId is stamped on automatically)
 *   requests   — recorded [{method, path}] for assertions
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const { relayFrames } = require('./protocol');

// Default streamed reply to any send_message without a per-session script, built
// from the protocol contract so the fake can't silently diverge from it.
function defaultStream(sessionId) {
  return [
    relayFrames.assistantDelta({ sessionId, text: 'Hello ' }),
    relayFrames.assistantDelta({ sessionId, text: 'from fake relay' }),
    relayFrames.messageComplete({ sessionId }),
  ];
}

function createFakeRelay() {
  const projects = new Map();        // id -> relay-shape project
  const sessionScripts = new Map();  // sessionId -> [frames]
  const requests = [];
  const wsClients = new Set();
  let seq = 0;
  let closed = false;

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
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* leave {} */ }

      // --- Projects (file ops depend on this for path resolution) ---
      if (p === '/api/projects' && req.method === 'GET') return send(200, [...projects.values()]);
      if (p === '/api/projects' && req.method === 'POST') {
        const id = parsed.id || `proj-${++seq}`;
        const proj = { ...parsed, id };
        projects.set(id, proj);
        return send(201, proj);
      }
      const pm = p.match(/^\/api\/projects\/([^/]+)$/);
      if (pm) {
        const id = pm[1];
        if (req.method === 'GET') return projects.has(id) ? send(200, projects.get(id)) : send(404, { error: 'Project not found' });
        if (req.method === 'PUT') { const proj = { ...(projects.get(id) || {}), ...parsed, id }; projects.set(id, proj); return send(200, proj); }
        if (req.method === 'DELETE') { projects.delete(id); return send(200, {}); }
      }

      // --- Sessions (create returns an id; delete is the invoker's cleanup) ---
      if (p === '/api/sessions' && req.method === 'POST') {
        const sessionId = parsed.sessionId || `sess-${++seq}`;
        return send(201, {
          sessionId,
          directory: parsed.directory || '/fake',
          projectId: parsed.projectId || null,
          model: parsed.model || 'fake-model',
          name: parsed.name || '',
        });
      }
      if (/^\/api\/sessions\/.+$/.test(p) && req.method === 'DELETE') return send(200, {});
      if (p === '/api/sessions' && req.method === 'GET') return send(200, []);

      // --- Misc endpoints eve may touch at boot ---
      if (p === '/api/models' && req.method === 'GET') return send(200, [{ id: 'fake-model', name: 'Fake Model' }]);
      if (p === '/api/mcps' && req.method === 'GET') return send(200, []);
      if (p.startsWith('/api/tasks') && req.method === 'GET') return send(200, []);

      return send(404, { error: `fake-relay: unhandled ${req.method} ${p}` });
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    wsClients.add(ws);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'join_session') {
        // eve suppresses the first join after create; harmless either way.
        ws.send(JSON.stringify(relayFrames.sessionJoined({ sessionId: msg.sessionId })));
      } else if (msg.type === 'send_message') {
        const script = sessionScripts.get(msg.sessionId);
        const frames = script
          ? script.map((f) => ({ ...f, sessionId: msg.sessionId })) // stamp test-authored frames
          : defaultStream(msg.sessionId);
        for (const f of frames) ws.send(JSON.stringify(f));
      }
    });
    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => {});
  });

  return {
    addProject: (proj) => { projects.set(proj.id, proj); },
    getProject: (id) => projects.get(id),
    listProjects: () => [...projects.values()],
    scriptSession: (sessionId, frames) => { sessionScripts.set(sessionId, frames); },
    requests,
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      if (closed) return resolve(); // a resilience test may close the relay before the harness does
      closed = true;
      for (const c of wsClients) { try { c.terminate(); } catch { /* ignore */ } }
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

module.exports = { createFakeRelay };
