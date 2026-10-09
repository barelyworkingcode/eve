const RelayClient = require('./relay-client');
const FileWatcher = require('./file-watcher');
const RateLimiter = require('./rate-limiter');
const { messages } = require('./ws/message-registry');
const { acceptTraceId } = require('./trace');

const EXPENSIVE_WINDOW_MS = parseInt(process.env.EVE_RATELIMIT_WINDOW_MS || '10000', 10);
const EXPENSIVE_MAX = parseInt(process.env.EVE_RATELIMIT_MAX || '30', 10);

function createWsHandler({ authService, trustedNetwork, relayTransport, fileHandlers, files, searchSummarizer, resolveProject, ensureProjectHost, ttsService, sttService, uiBus, chiefOfStaff, paths, log }) {
  // Shared across every connection this factory serves (the factory itself
  // runs once, at server.js startup) — a host_status change must reach every
  // authenticated browser tab, not just the one that happened to trigger it.
  // The statuses come from relay over /ws/files (relay-file-client.js).
  const authenticatedSockets = new Set();

  function sendHostStatus(ws, evt) {
    const frame = { type: 'host_status', hostId: evt.hostId, name: evt.name, status: evt.status };
    if (evt.error) frame.error = evt.error;
    try { ws.send(JSON.stringify(frame)); } catch { /* socket closing */ }
  }

  files?.on('host_status', (evt) => {
    for (const client of authenticatedSockets) sendHostStatus(client, evt);
  });

  return (ws, req) => {
    // Never consult req.headers.host or X-Forwarded-For here — both are
    // attacker-controllable. See docs/security-review-auth-transport.md Section A.
    const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !trustedNetwork.isTrusted(req);
    let isAuthenticated = !requiresAuth;

    // Sent once per newly-authenticated connection so a fresh browser tab is
    // caught up on the latest status relay has reported for every host.
    function onAuthenticated() {
      authenticatedSockets.add(ws);
      if (!files) return;
      for (const s of files.hostStatuses()) sendHostStatus(ws, s);
    }
    if (isAuthenticated) onAuthenticated();

    const relayClient = new RelayClient(relayTransport, ws, ttsService, log?.child('Relay'));

    // Marked alive by the server's heartbeat pong (see server.js); the
    // reaper terminates any socket still marked dead on the next tick.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    uiBus?.register(relayClient);
    const fileWatcher = new FileWatcher(ws, files, resolveProject);
    // File searches and SearchSummarizer track in-flight work by requestId
    // only, so this connection must track which IDs belong to it to cancel
    // cleanly on drop.
    const inflightSearchIds = new Set();
    const inflightAiIds = new Set();
    const expensiveLimiter = new RateLimiter({ windowMs: EXPENSIVE_WINDOW_MS, max: EXPENSIVE_MAX });

    relayClient.connect().catch(err => {
      log?.error('Failed to connect to relayLLM:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot connect to relay service' }));
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'auth') {
          if (!requiresAuth) {
            ws.send(JSON.stringify({ type: 'auth_success' }));
            return;
          }
          if (authService.validateSession(message.token)) {
            isAuthenticated = true;
            onAuthenticated();
            ws.send(JSON.stringify({ type: 'auth_success' }));
          } else {
            ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid or expired token' }));
            ws.close(4001, 'Unauthorized');
          }
          return;
        }

        // Deliberately answered before the auth gate and rate-limiter so the
        // probe is always cheap and never blocked. See public/ws-client.js _heartbeat().
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (!isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
          return;
        }

        // descriptor.expensive is the sole source of rate-limit truth.
        const descriptor = messages.get(message.type);
        const expensive = descriptor?.expensive === true;

        if (expensive && !expensiveLimiter.allow()) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Rate limit exceeded — too many requests, please slow down.',
            requestId: message.requestId,
          }));
          return;
        }

        // Lets eve-control MCP target ui_command pushes by project; idempotent.
        if (message.projectId) uiBus?.setProject(relayClient, message.projectId);

        // A descriptor is registered once per process — it must never capture
        // ws/relayClient/fileWatcher (per-connection objects), or later
        // connections leak into an earlier one's handler. Rebuilt fresh per message.
        if (descriptor) {
          // A host added in relay after startup is not in eve's host cache yet.
          const hostRefresh = message.projectId && ensureProjectHost ? ensureProjectHost(message.projectId) : null;
          if (hostRefresh) await hostRefresh;
          const traceId = descriptor.chatTurn ? acceptTraceId(message.trace_id) : undefined;
          await descriptor.handle({
            ws,
            traceId,
            req,
            message,
            relayClient,
            fileWatcher,
            inflightSearchIds,
            inflightAiIds,
            log,
            deps: { relayTransport, fileHandlers, searchSummarizer, resolveProject, ttsService, sttService, chiefOfStaff, paths },
          });
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      // Searches in relay and hidden relay sessions both stay alive until
      // their own timeouts otherwise.
      for (const id of inflightSearchIds) {
        fileHandlers.cancelSearch(id);
      }
      inflightSearchIds.clear();
      for (const id of inflightAiIds) {
        searchSummarizer?.stop(id);
      }
      inflightAiIds.clear();
      relayClient.close();
      fileWatcher.closeAll();
      uiBus?.unregister(relayClient);
      authenticatedSockets.delete(ws);
    });
  };
}

module.exports = createWsHandler;
