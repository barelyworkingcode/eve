/**
 * Drift guard for the fake relay. Every behaviour fake-relay.js / protocol.js
 * copies from relay is listed here with the relay file and the exact text it
 * was read from. When a relay checkout is present (../relay, or
 * EVE_RELAY_SOURCE) each needle must still be in its file, so a relay change
 * that moves a status, a message or a JSON key fails here instead of leaving
 * the fake quietly wrong. The fake side runs everywhere: each pin also names
 * the text the fake must carry, so the two cannot be edited apart.
 *
 * Without a relay checkout (CI, other machines) the relay half is reported as
 * a todo, not a pass.
 */
const fs = require('fs');
const path = require('path');

const FAKE = fs.readFileSync(path.join(__dirname, 'fake-relay.js'), 'utf8')
  + fs.readFileSync(path.join(__dirname, 'protocol.js'), 'utf8');

function relayRoot() {
  const candidates = [process.env.EVE_RELAY_SOURCE, path.resolve(__dirname, '..', '..', '..', 'relay')].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'cmd', 'relay', 'frontend_server.go')));
}

// [what, relay file, needle in that file, needle the fake must carry]
const PINS = [
  ['401 is text/plain "unauthorized"', 'cmd/relay/frontend_server.go', 'http.Error(w, "unauthorized", http.StatusUnauthorized)', "sendText(401, 'unauthorized')"],
  ['unmatched path is a text/plain 404', 'cmd/relay/frontend_dispatcher.go', 'http.Error(w, "no service registered for this path", http.StatusNotFound)', "sendText(404, 'no service registered for this path')"],
  ['upstream dial failure closes 1011', 'cmd/relay/frontend_dispatcher.go', 'websocket.CloseInternalServerErr, "upstream unreachable"', "code = 1011, reason = 'upstream unreachable'"],
  ['model allowlist refusal', 'cmd/relay/frontend_model_guard.go', '"error": "model not allowed for this project"', "error: 'model not allowed for this project'"],
  ['remote project refusal', 'cmd/relay/frontend_model_guard.go', 'is a remote project and cannot host a session', 'is a remote project and cannot host a session'],
  ['project 404 body', 'cmd/relay/project_routes.go', '"error": "project not found"', "error: 'project not found'"],
  ['project delete is 204', 'cmd/relay/project_routes.go', 'w.WriteHeader(http.StatusNoContent)', "projects.delete(id); return send(204)"],
  ['host 404 body', 'cmd/relay/host_routes.go', '"error": "host not found"', "error: 'host not found'"],
  ['host in use 409', 'cmd/relay/host_routes.go', '"host is used by one or more projects"', "error: 'host is used by one or more projects'"],
  ['persistent sessions list route', 'cmd/relay/persistent_session_routes.go', '"GET /api/projects/{id}/persistent-sessions"', 'persistent-sessions'],
  ['persistent sessions kill route', 'cmd/relay/persistent_session_routes.go', '"DELETE /api/projects/{id}/persistent-sessions/{name}"', 'persistent-sessions'],
  ['persistent sessions unhosted project text', 'cmd/relay/persistent_session_ops.go', 'hosted project %q not found', 'hosted project "${projectId}" not found'],
  ['persistent sessions no-tmux kind', 'cmd/relay/persistent_session_ops.go', 'errors.New("host has no tmux")', 'persistentFailures'],
  ['persistent session row keys', 'cmd/relay/persistent_session_ops.go', 'json:"attached_here"', 'attached_here'],
  ['session delete is 204', 'internal/sessions/api/http_session.go', 'w.WriteHeader(http.StatusNoContent)', "sessions.delete(sm[1]); return send(204)"],
  ['session list row uses id', 'internal/sessions/session/manager.go', 'ID            string            `json:"id"`', 'id: sess.sessionId'],
  ['session list row has live', 'internal/sessions/session/manager.go', '`json:"live"`', 'live: sess.live !== false'],
  ['session list row has messageCount', 'internal/sessions/session/manager.go', '`json:"messageCount"`', 'messageCount'],
  ['session create body key', 'internal/sessions/types/session.go', '`json:"sessionId"`', 'sessionId,'],
  ['session create body providerType', 'internal/sessions/types/session.go', '`json:"providerType"`', "providerType: 'claude'"],
  ['terminal created body has host', 'internal/sessions/terminal/types.go', 'Host       map[string]string `json:"host"`', 'host: null'],
  ['terminal log is text/plain', 'internal/sessions/api/http_terminal.go', 'w.Header().Set("Content-Type", "text/plain; charset=utf-8")', "'text/plain; charset=utf-8' });\n        return res.end(Buffer.from('TERMINAL-LOG-BYTES'))"],
  ['join of an unknown session', 'internal/sessions/api/ws_session.go', 'sendWSError(c, "session not found: "+req.SessionID)', 'session not found: ${msg.sessionId}'],
  ['session_joined has live', 'internal/sessions/api/ws_session.go', '"live": p != nil && p.Alive(),', 'live: session.live !== false'],
  ['session_joined has protocolVersion', 'internal/sessions/api/ws_session.go', '"protocolVersion": events.ProtocolVersion,', 'protocolVersion: EVENT_PROTOCOL_VERSION'],
  ['session_joined has history', 'internal/sessions/api/ws_session.go', '"history":         history,', 'history: []'],
  ['permission response needs a joined connection', 'internal/sessions/api/ws_session.go', 'permission response refused: this connection has not joined session ', 'permission response refused: this connection has not joined session ${sessionId}'],
  ['resume_required carries message', 'internal/sessions/api/ws_session.go', '"message":   err.Error(),', "code: 'resume_required', sessionId, message"],
];

describe('fake relay carries what the pins say (no relay checkout needed)', () => {
  it.each(PINS.map((p) => [p[0], p[3]]))('%s', (_what, fakeNeedle) => {
    expect(FAKE).toContain(fakeNeedle);
  });
});

const root = relayRoot();
if (!root) {
  test.todo('relay checkout not found at ../relay (set EVE_RELAY_SOURCE): relay-side pins not verified');
} else {
  describe(`relay source still says what the fake copies (${root})`, () => {
    it.each(PINS.map((p) => [p[0], p[1], p[2]]))('%s', (_what, file, needle) => {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      expect(text).toContain(needle);
    });
  });
}
