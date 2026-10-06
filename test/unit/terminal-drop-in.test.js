// A drop-in terminal is already running when eve hears of it (relay made it in the
// POST /api/sessions/:id/drop-in answer), so eve registers the tab and then joins
// it, in that order: the join's output must find the tab.
const TerminalManager = require('../../public/terminal-manager');

describe('TerminalManager.openDropIn', () => {
  it('registers the terminal, then sends join_terminal for its id', () => {
    const calls = [];
    const self = {
      onReady: (fn) => fn(),
      onTerminalCreated: (...args) => calls.push(['created', ...args]),
      app: { wsClient: { send: (m) => calls.push(['send', m]) } },
    };
    const terminal = { terminalId: 't9', templateId: 'claude-code', name: 'Acme build (drop-in)', directory: '/work/acme', host: null };

    TerminalManager.prototype.openDropIn.call(self, terminal);

    expect(calls).toEqual([
      ['created', 't9', 'claude-code', 'Acme build (drop-in)', '/work/acme', null],
      ['send', { type: 'join_terminal', terminalId: 't9' }],
    ]);
  });
});
