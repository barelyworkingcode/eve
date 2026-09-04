/**
 * WebSocket connection handler - dispatches messages to relay or local services.
 */
const RelayClient = require('./relay-client');
const FileWatcher = require('./file-watcher');
const RateLimiter = require('./rate-limiter');
const { messages } = require('./ws/message-registry');

const EXPENSIVE_WINDOW_MS = parseInt(process.env.EVE_RATELIMIT_WINDOW_MS || '10000', 10);
const EXPENSIVE_MAX = parseInt(process.env.EVE_RATELIMIT_MAX || '30', 10);

function createWsHandler({ authService, trustedNetwork, relayTransport, fileHandlers, moduleService, moduleInvoker, searchSummarizer, resolveProject, ttsService, sttService, uiBus, log }) {
  return (ws, req) => {
    // Trust is decided by the raw TCP source address via TrustedNetworkService.
    // Never consult req.headers.host or X-Forwarded-For here — both are
    // attacker-controllable. See docs/security-review-auth-transport.md Section A.
    const requiresAuth = authService.isEnrolled() && process.env.EVE_NO_AUTH !== '1' && !trustedNetwork.isTrusted(req);
    let isAuthenticated = !requiresAuth;

    const relayClient = new RelayClient(relayTransport, ws, ttsService, log?.child('Relay'));

    // Heartbeat liveness (graceful-reconnect, Issue 1): the server pings every
    // client on an interval (see server.js); a live browser auto-replies with a
    // protocol pong, which marks the socket alive. The reaper terminates any
    // socket still marked dead on the next tick — this is how a zombie
    // connection left behind by a phone network switch gets cleaned up instead
    // of lingering for the OS TCP timeout and holding a ghost relay session.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Track this connection so the eve-control MCP can target ui_command pushes
    // by project (project set is populated from message.projectId below).
    uiBus?.register(relayClient);
    const fileWatcher = new FileWatcher(ws, fileHandlers.fileService, resolveProject);
    // Per-connection in-flight tracking — used to cancel everything cleanly
    // if the browser drops mid-search. Both SearchService and SearchSummarizer
    // track by requestId only, so we need to know which IDs belong to us.
    const inflightSearchIds = new Set();
    const inflightAiIds = new Set();
    const expensiveLimiter = new RateLimiter({ windowMs: EXPENSIVE_WINDOW_MS, max: EXPENSIVE_MAX });

    // Connect to relayLLM immediately
    relayClient.connect().catch(err => {
      log?.error('Failed to connect to relayLLM:', err.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Cannot connect to relay service' }));
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        // Handle auth message first
        if (message.type === 'auth') {
          if (!requiresAuth) {
            ws.send(JSON.stringify({ type: 'auth_success' }));
            return;
          }
          if (authService.validateSession(message.token)) {
            isAuthenticated = true;
            ws.send(JSON.stringify({ type: 'auth_success' }));
          } else {
            ws.send(JSON.stringify({ type: 'auth_failed', message: 'Invalid or expired token' }));
            ws.close(4001, 'Unauthorized');
          }
          return;
        }

        // App-level heartbeat (graceful-reconnect, Issue 1): the browser
        // WebSocket API cannot send protocol pings, so the client pings at the
        // app layer to detect a dead link fast after a network change. Answer
        // before the auth gate and rate-limiter so the probe is always cheap
        // and never blocked. See public/ws-client.js _heartbeat().
        if (message.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        // Block all other messages until authenticated
        if (!isAuthenticated) {
          ws.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
          return;
        }

        // Every message type is a registered descriptor. descriptor.expensive
        // is the only source of rate-limit membership. See
        // docs/security-audit-frontend.md (M3) and C4 in ws/message-registry.js.
        const descriptor = messages.get(message.type);
        const expensive = descriptor?.expensive === true;

        // Throttle expensive operations per connection.
        if (expensive && !expensiveLimiter.allow()) {
          ws.send(JSON.stringify({
            type: 'error',
            message: 'Rate limit exceeded — too many requests, please slow down.',
            requestId: message.requestId,
          }));
          return;
        }

        // Remember which project(s) this browser is viewing so LLM-initiated UI
        // commands (eve-control MCP) reach it. Most project-scoped messages
        // carry projectId; setting it repeatedly is idempotent.
        if (message.projectId) uiBus?.setProject(relayClient, message.projectId);

        // Rebuilt fresh for this message, never captured by a descriptor:
        // ws, relayClient and fileWatcher are per-connection, not
        // per-process, and a descriptor is registered once per process
        // (see C1 in ws/message-registry.js).
        if (descriptor) {
          await descriptor.handle({
            ws,
            req,
            message,
            relayClient,
            fileWatcher,
            inflightSearchIds,
            inflightAiIds,
            log,
            deps: { relayTransport, fileHandlers, moduleService, moduleInvoker, searchSummarizer, resolveProject, ttsService, sttService },
          });
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      // Kill anything this browser kicked off — ripgrep children and hidden
      // relay sessions both stay alive until their own timeouts otherwise.
      for (const id of inflightSearchIds) {
        fileHandlers.searchService?.cancel(id);
      }
      inflightSearchIds.clear();
      for (const id of inflightAiIds) {
        searchSummarizer?.stop(id);
      }
      inflightAiIds.clear();
      relayClient.close();
      fileWatcher.closeAll();
      uiBus?.unregister(relayClient);
    });
  };
}

module.exports = createWsHandler;
