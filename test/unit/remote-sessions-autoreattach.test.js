// autoReattachPersistentSessions(projectId): on opening a host project, reattach
// every persistent (tmux) session relay lists that no eve client holds and that
// isn't already an open eve terminal. It reuses the Reattach path:
// TerminalManager.createTerminal(template_id, dir, projectId, session.name).
//
// Where it lives is resolved at call time so the tests don't pin a shape:
// a property on public/remote-sessions.js's export (static or named), a
// classic-script global, or a TerminalManager method. It is invoked with
// `this` = a TerminalManager-shaped object (app.api / app.state / terminals /
// allTerminals / createTerminal), with those deps also reachable via
// window.app / app.terminal, and a deps object as a harmless second argument.
global.document = { createElement: () => ({}) };
global.EVT = { HOST_STATUS: 'host:status', TERMINAL_TEMPLATES_LOADED: 'terminal:templatesLoaded' };
const RemoteSessionsSection = require('../../public/remote-sessions');
const TerminalManager = require('../../public/terminal-manager');

function resolveAutoReattach() {
  const fn = RemoteSessionsSection.autoReattachPersistentSessions
    || global.autoReattachPersistentSessions
    || TerminalManager.prototype.autoReattachPersistentSessions;
  if (typeof fn !== 'function') throw new Error('autoReattachPersistentSessions is not exposed');
  return fn;
}

function httpError(status, body) {
  const err = new Error(body?.error || `HTTP ${status}`);
  err.status = status;
  err.body = body;
  return err;
}

const flush = () => new Promise((r) => setImmediate(r));

// openNames: eve terminals already open, as { name, projectId }.
function build({ list = [], getError = null, openNames = [] } = {}) {
  const api = {
    getPersistentSessions: getError
      ? jest.fn().mockRejectedValue(getError)
      // Resolve on a later tick so a second call can start before the first lands.
      : jest.fn(() => new Promise((r) => setImmediate(() => r(list)))),
  };
  const project = { id: 'p1', path: '/w', directory: '/w', host: { id: 'h1', name: 'devbox' } };
  const state = {
    getProject: (id) => (id === 'p1' ? project : null),
    hostStatus: () => 'connected',
    terminalTemplates: [{ id: 'shell', name: 'Shell' }, { id: 'claude-code', name: 'Claude Code' }],
  };
  const createTerminal = jest.fn();
  const wsClient = { send: jest.fn() };
  const app = { api, state, wsClient, bus: { on: () => () => {}, emit: () => {} } };

  const tm = Object.create(TerminalManager.prototype);
  tm.app = app;
  tm.log = { info() {}, warn() {}, error() {}, debug() {} };
  tm.createTerminal = createTerminal;
  tm.terminals = new Map();
  tm.allTerminals = new Map();
  openNames.forEach(({ name, projectId }, i) => {
    const rec = { id: `t${i}`, templateId: 'shell', name, projectId, directory: '/w', host: project.host, state: 'running' };
    tm.terminals.set(rec.id, { ...rec });
    tm.allTerminals.set(rec.id, rec);
  });
  app.terminal = tm;
  app.terminalManager = tm;
  global.window = { app };

  const fn = resolveAutoReattach();
  const deps = { api, state, app, terminalManager: tm, createTerminal };
  const run = () => Promise.resolve(fn.call(tm, 'p1', deps));
  return { run, api, createTerminal };
}

const launched = (createTerminal) => createTerminal.mock.calls.map((c) => c[3]).sort();

afterEach(() => { delete global.window; });

describe('autoReattachPersistentSessions', () => {
  it('reattaches each detached session with its template id and name as persistSession', async () => {
    const { run, api, createTerminal } = build({
      list: [
        { name: 'eve-p1-shell-1', template_id: 'shell', n: 1, attached: 0, attached_here: false },
        { name: 'eve-p1-claude-code-1', template_id: 'claude-code', n: 1, attached: 0, attached_here: false },
      ],
    });
    await run();
    await flush();
    expect(api.getPersistentSessions).toHaveBeenCalledWith('p1');
    expect(createTerminal).toHaveBeenCalledTimes(2);
    expect(createTerminal).toHaveBeenCalledWith('shell', expect.anything(), 'p1', 'eve-p1-shell-1');
    expect(createTerminal).toHaveBeenCalledWith('claude-code', expect.anything(), 'p1', 'eve-p1-claude-code-1');
  });

  it('skips sessions attached_here and names already open as eve terminals for the project', async () => {
    const { run, createTerminal } = build({
      list: [
        { name: 'eve-p1-shell-1', template_id: 'shell', n: 1, attached: 1, attached_here: true },
        { name: 'eve-p1-shell-2', template_id: 'shell', n: 2, attached: 0, attached_here: false },
        { name: 'eve-p1-shell-3', template_id: 'shell', n: 3, attached: 0, attached_here: false },
      ],
      openNames: [{ name: 'eve-p1-shell-2', projectId: 'p1' }],
    });
    await run();
    await flush();
    expect(launched(createTerminal)).toEqual(['eve-p1-shell-3']);
  });

  it('a second concurrent call for the same project does not double-launch', async () => {
    const { run, createTerminal } = build({
      list: [
        { name: 'eve-p1-shell-1', template_id: 'shell', n: 1, attached: 0, attached_here: false },
        { name: 'eve-p1-shell-2', template_id: 'shell', n: 2, attached: 0, attached_here: false },
      ],
    });
    await Promise.all([run(), run()]);
    await flush();
    expect(launched(createTerminal)).toEqual(['eve-p1-shell-1', 'eve-p1-shell-2']);
  });

  it.each([
    [404, { error: 'not found' }],
    [409, { error: 'tmux not installed on devbox' }],
    [502, { error: 'ssh: connect timed out' }],
  ])('a %i from the session list launches nothing and does not throw', async (status, body) => {
    const { run, api, createTerminal } = build({ getError: httpError(status, body) });
    await run(); // must resolve, not reject
    await flush();
    expect(api.getPersistentSessions).toHaveBeenCalledWith('p1');
    expect(createTerminal).not.toHaveBeenCalled();
  });
});
