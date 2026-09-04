module.exports = [
  {
    type: 'terminal_create',
    handle(ctx) {
      // Forward projectId so relay can resolve a project-scoped token for
      // the PTY (validating directory against the project). Empty/absent
      // projectId yields a token-free ad-hoc terminal.
      ctx.relayClient.send({
        type: 'terminal_create',
        templateId: ctx.message.templateId,
        name: ctx.message.name,
        directory: ctx.message.directory,
        projectId: ctx.message.projectId || '',
        cols: ctx.message.cols,
        rows: ctx.message.rows,
      });
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

  {
    type: 'terminal_templates',
    handle(ctx) {
      ctx.relayClient.send({ type: 'terminal_templates' });
    },
  },
];
