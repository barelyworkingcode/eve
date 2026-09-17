module.exports = [
  {
    type: 'terminal_create',
    // C11: creation moved off the WS frame and onto relay's own
    // POST /api/terminals — relay authorizes and launches synchronously and
    // answers with the 201 body, so eve only joins the resulting terminal
    // over WS afterward. The old WS `terminal_create` path is retired
    // relay-side (internal/sessions/api/ws_terminal.go answers it with an
    // error frame telling the caller to use the HTTP route instead), so this
    // type must never be sent to relay directly again.
    async handle(ctx) {
      const { ws, relayClient, message } = ctx;
      const { relayTransport } = ctx.deps;
      let status, data;
      try {
        ({ status, data } = await relayTransport.fetch('POST', '/api/terminals', {
          templateId: message.templateId,
          name: message.name,
          directory: message.directory,
          // Forward projectId so relay can resolve a project-scoped token for
          // the PTY (validating directory against the project). Empty/absent
          // projectId yields a token-free ad-hoc terminal.
          projectId: message.projectId || '',
          cols: message.cols,
          rows: message.rows,
        }));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'terminal create failed: relay unavailable' }));
        return;
      }

      if (status < 200 || status >= 300) {
        ws.send(JSON.stringify({ type: 'error', message: `terminal create failed (${status})` }));
        return;
      }

      // relay's 201 body is its own WS `terminal_created` frame minus
      // `type` (relay internal/sessions/terminal/types.go CreatedBody) — its
      // id field is `terminalId`, not `id`, confirmed directly against
      // relay's source rather than this unit's own plan prose, which named
      // it `id`.
      ws.send(JSON.stringify({ type: 'terminal_created', ...data }));
      relayClient.send({ type: 'join_terminal', terminalId: data.terminalId });
    },
  },

  {
    type: 'terminal_input',
    handle(ctx) {
      ctx.relayClient.send({ type: 'terminal_input', terminalId: ctx.message.terminalId, data: ctx.message.data });
    },
  },

  {
    type: 'terminal_resize',
    handle(ctx) {
      ctx.relayClient.send({ type: 'terminal_resize', terminalId: ctx.message.terminalId, cols: ctx.message.cols, rows: ctx.message.rows });
    },
  },

  {
    type: 'terminal_close',
    handle(ctx) {
      ctx.relayClient.send({ type: 'terminal_close', terminalId: ctx.message.terminalId });
    },
  },

  {
    type: 'terminal_list',
    handle(ctx) {
      ctx.relayClient.send({ type: 'terminal_list' });
    },
  },

  {
    type: 'terminal_reconnect',
    handle(ctx) {
      ctx.relayClient.send({ type: 'terminal_reconnect', terminalId: ctx.message.terminalId, cols: ctx.message.cols, rows: ctx.message.rows });
    },
  },

  {
    type: 'join_terminal',
    handle(ctx) {
      ctx.relayClient.send({ type: 'join_terminal', terminalId: ctx.message.terminalId });
    },
  },

  {
    type: 'leave_terminal',
    handle(ctx) {
      ctx.relayClient.send({ type: 'leave_terminal', terminalId: ctx.message.terminalId });
    },
  },

  // terminal_templates is retired: the template catalog is relay's own
  // (GET /api/terminal/templates), reached by the browser directly over
  // HTTP (public/terminal-manager.js's requestTemplates, via
  // api-client.js's getTerminalTemplates) rather than round-tripped through
  // this WS relay. relay-sessions never mounted a handler for the WS
  // message this used to forward, so this path only ever hung.
];
