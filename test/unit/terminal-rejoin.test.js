// relayLLM routes terminal_input to a PTY by id from any connection, but sends
// terminal_output only to connections it has registered as viewers. A browser
// reconnect creates a fresh upstream connection with an empty viewer set, so an
// already-open pane keeps typing into the live shell and never receives another
// byte back — the "terminal froze, and a reload shows everything I typed" bug.
// Only a reload used to recover, because a reload is the one path that rebuilds
// this.terminals from empty and therefore re-joins.
const TerminalManager = require('../../public/terminal-manager');

// terminal-manager.js reads the EVT map as a browser global (constants.js).
beforeAll(() => { global.EVT = { TERMINAL_LIST: 'terminal:list' }; });
afterAll(() => { delete global.EVT; });

function fakeEntry({ cols = 80, rows = 24, exited = false } = {}) {
  const writes = [];
  return {
    exited,
    needsReconnect: false,
    replayPending: false,
    term: { cols, rows, reset: jest.fn(), write: (d) => writes.push(d) },
    _writes: writes,
  };
}

function ctx({ terminals = new Map(), activeTerminalId = null } = {}) {
  const sent = [];
  return {
    terminals,
    allTerminals: new Map(),
    activeTerminalId,
    app: { wsClient: { send: (m) => sent.push(m) }, bus: { emit: jest.fn() } },
    _sendReconnect: TerminalManager.prototype._sendReconnect,
    _decodeBase64: TerminalManager.prototype._decodeBase64,
    reconnectTerminal: jest.fn(),
    setupTerminal: jest.fn(),
    _sent: sent,
  };
}

describe('TerminalManager.markTerminalsForRejoin', () => {
  const mark = TerminalManager.prototype.markTerminalsForRejoin;

  it('marks every live terminal so the list/show paths re-join them', () => {
    const t1 = fakeEntry();
    const t2 = fakeEntry();
    const self = ctx({ terminals: new Map([['t1', t1], ['t2', t2]]), activeTerminalId: 't1' });

    mark.call(self);

    expect(t1.needsReconnect).toBe(true);
    expect(t2.needsReconnect).toBe(true);
    // Marking alone must not talk to the server: the terminal list decides.
    expect(self._sent).toEqual([]);
  });

  it('leaves exited terminals alone', () => {
    const dead = fakeEntry({ exited: true });
    const self = ctx({ terminals: new Map([['t1', dead]]), activeTerminalId: 't1' });

    mark.call(self);

    expect(dead.needsReconnect).toBe(false);
  });

  it('is a no-op on a first connect, when nothing is open yet', () => {
    const self = ctx();
    expect(() => mark.call(self)).not.toThrow();
    expect(self._sent).toEqual([]);
  });
});

describe('TerminalManager.onTerminalList after a reconnect', () => {
  const mark = TerminalManager.prototype.markTerminalsForRejoin;
  const list = TerminalManager.prototype.onTerminalList;

  it('re-joins the visible terminal it already holds, at its current grid size', () => {
    const t1 = fakeEntry({ cols: 120, rows: 40 });
    const self = ctx({ terminals: new Map([['t1', t1]]), activeTerminalId: 't1' });

    mark.call(self);
    list.call(self, [{ id: 't1', templateId: 'zsh', name: 'sh', directory: '/p', state: 'running' }]);

    expect(self._sent).toEqual([
      { type: 'terminal_reconnect', terminalId: 't1', cols: 120, rows: 40 },
    ]);
    expect(self.reconnectTerminal).not.toHaveBeenCalled();
  });

  it('defers hidden terminals to showTerminal rather than re-joining them blind', () => {
    // A hidden pane has not been fit() against a visible container, so its
    // cols/rows would resize the PTY to a stale size.
    const t1 = fakeEntry();
    const t2 = fakeEntry();
    const self = ctx({ terminals: new Map([['t1', t1], ['t2', t2]]), activeTerminalId: 't1' });

    mark.call(self);
    list.call(self, [
      { id: 't1', state: 'running' },
      { id: 't2', state: 'running' },
    ]);

    expect(self._sent.map((m) => m.terminalId)).toEqual(['t1']);
    expect(t2.needsReconnect).toBe(true);
  });

  it('still sets up terminals it does not hold locally', () => {
    const self = ctx();
    list.call(self, [{ id: 'new', templateId: 'zsh', name: 'sh', directory: '/p', state: 'running' }]);

    expect(self.reconnectTerminal).toHaveBeenCalledWith('new', 'zsh', 'sh', '/p', false);
    expect(self._sent).toEqual([]);
  });

  it('does not re-send for a terminal that has already re-joined', () => {
    const t1 = fakeEntry();
    const self = ctx({ terminals: new Map([['t1', t1]]), activeTerminalId: 't1' });
    const frames = [{ id: 't1', state: 'running' }];

    mark.call(self);
    list.call(self, frames);
    list.call(self, frames);

    expect(self._sent).toHaveLength(1);
  });
});

describe('TerminalManager.onTerminalJoined replay', () => {
  const joined = TerminalManager.prototype.onTerminalJoined;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  it('clears the grid before a re-join replay so the screen is not doubled', () => {
    const t1 = fakeEntry();
    t1.replayPending = true;
    const self = ctx({ terminals: new Map([['t1', t1]]) });

    joined.call(self, { terminalId: 't1', scrollback: b64('hello') });

    expect(t1.term.reset).toHaveBeenCalledTimes(1);
    expect(Buffer.from(t1._writes[0]).toString()).toBe('hello');
    expect(t1.replayPending).toBe(false);
  });

  it('does not clear the grid for a first join, which lands on an empty one', () => {
    const t1 = fakeEntry();
    const self = ctx({ terminals: new Map([['t1', t1]]) });

    joined.call(self, { terminalId: 't1', scrollback: b64('hello') });

    expect(t1.term.reset).not.toHaveBeenCalled();
    expect(Buffer.from(t1._writes[0]).toString()).toBe('hello');
  });
});
