// AgentBoard (eve#195): states, groups, rows, cap, tap and the phone badge.
// Real EventBus, StateStore, AgentAttention and AgentBoard against a fake DOM.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDocument, fakeLocalStorage, byTestId } = require('./helpers/fake-dom');

const SCRIPTS = ['core/event-bus.js', 'core/constants.js', 'core/mode.js', 'core/state-store.js', 'core/ui-utils.js', 'agent-board.js'];

function setup({ terminals = [], sessions = [], projects = [] } = {}) {
  const doc = createDocument();
  const context = vm.createContext({
    console, document: doc, localStorage: fakeLocalStorage(), navigator: { userAgent: '' }, setTimeout, clearTimeout,
  });
  context.window = context;
  for (const file of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'), context, { filename: file });
  }
  const g = vm.runInContext('({ EventBus, StateStore, AgentAttention, AgentBoard, EVT })', context);
  const bus = new g.EventBus();
  const state = new g.StateStore(bus);
  state.setMode('work');
  state.setProjects(projects);
  const mgr = {
    listLoaded: true,
    allTerminals: new Map(terminals.map((t) => [t.id, t])),
    lastLineOf: () => null,
    openTaskTerminal: jest.fn(),
  };
  const app = { joinSession: jest.fn() };
  const attention = new g.AgentAttention({ bus, state, refreshList: () => Promise.resolve() });
  const services = { state, bus, terminalManager: mgr, agentAttention: attention, app, api: { getTerminalLog: () => Promise.reject(new Error('none')) } };
  const container = { has: (k) => k in services, get: (k) => services[k] };
  for (const s of sessions) {
    state.addSession({ id: s.id, projectId: s.projectId || '', name: s.name || s.id, model: 'claude-haiku-4-5-20251001', live: true });
    if (s.state) bus.emit(g.EVT.SESSION_STATE, { type: 'session_state', sessionId: s.id, state: s.state, since: '2026-10-05T10:00:00.000Z' });
  }
  return { g, bus, state, mgr, app, attention, container, doc };
}

const term = (id, extra = {}) => ({ id, name: id, state: 'running', directory: '/nowhere', ...extra });
const mountBoard = (t, opts = {}) => {
  const board = new t.g.AgentBoard({ container: t.container, testidPrefix: 'today', filter: () => true, ...opts });
  const el = t.doc.createElement('div');
  board.mount(el);
  return { board, el };
};
const rowIds = (el, group) => el.querySelectorAll('[data-kind]')
  .filter((r) => !group || r.parentNode.parentNode.dataset.testid === `today-agents-group-${group}`)
  .map((r) => r.dataset.testid.replace('today-agent-', ''));

describe('AgentBoard states and groups', () => {
  it.each([
    [{ state: 'running' }, 'running'],
    [{ state: 'stopped', exitCode: 0 }, 'ended'],
    [{ state: 'stopped' }, 'ended'],
    [{ state: 'stopped', exitCode: 1 }, 'errored'],
  ])('a terminal %j is %s', (t, expected) => {
    const { g } = setup();
    expect(g.AgentBoard.terminalState(t)).toBe(expected);
  });

  it.each([
    ['asking', 'needs'], ['errored', 'needs'], ['stalled', 'needs'],
    ['running', 'working'], ['idle', 'working'], ['starting', 'working'],
    ['ended', 'done'],
  ])('%s belongs to %s', (st, group) => {
    const { g } = setup();
    expect(g.AgentBoard.groupOf(st)).toBe(group);
  });

  it('renders one dot per row with the row\'s state, grouped Needs you, Working, Done, sorted by label then id; empty groups have no section', () => {
    const t = setup({
      sessions: [
        { id: 's-b', name: 'Beta', state: 'running' },
        { id: 's-a', name: 'Alpha', state: 'running' },
        { id: 's-c', name: 'Alpha', state: 'asking' },
        { id: 's-d', name: 'Delta', state: 'stalled' },
      ],
      terminals: [term('t1', { name: 'Shell' }), term('t2', { name: 'Build', state: 'stopped', exitCode: 1 }), term('t3', { name: 'Old', state: 'stopped', exitCode: 0 })],
    });
    const { el } = mountBoard(t);
    expect(el.dataset.state).toBe('ready');
    expect(rowIds(el)).toEqual(['s-c', 't2', 's-d', 's-a', 's-b', 't1', 't3']);
    expect(rowIds(el, 'needs')).toEqual(['s-c', 't2', 's-d']);
    expect(rowIds(el, 'done')).toEqual(['t3']);
    expect(byTestId(el, 'today-agents-group-needs-count').textContent).toBe('3');
    expect(byTestId(el, 'today-agents-group-working-count').textContent).toBe('3');
    const row = byTestId(el, 'today-agent-s-d');
    expect(row.dataset.state).toBe('stalled');
    expect(row.querySelectorAll('.agent-row__dot').length).toBe(1);
    expect(row.querySelector('.agent-row__dot').dataset.state).toBe('stalled');
    expect(row.textContent).toContain('stalled');
    expect(byTestId(el, 'today-agent-t2').textContent).toContain('exited 1');
    expect(byTestId(el, 'today-agent-t1').textContent).toContain('open');

    const none = setup({ terminals: [term('t1')] });
    const board = mountBoard(none);
    expect(byTestId(board.el, 'today-agents-group-needs')).toBeNull();
    expect(byTestId(board.el, 'today-agents-group-done')).toBeNull();
    expect(byTestId(board.el, 'today-agents-group-working')).not.toBeNull();
  });

  it('a state frame moves the mounted row to its new group with no remount', () => {
    const t = setup({ sessions: [{ id: 's1', state: 'running' }] });
    const { el } = mountBoard(t);
    expect(rowIds(el, 'working')).toEqual(['s1']);
    t.bus.emit(t.g.EVT.SESSION_STATE, { type: 'session_state', sessionId: 's1', state: 'asking', since: '2026-10-05T10:00:05.000Z' });
    expect(rowIds(el, 'needs')).toEqual(['s1']);
    expect(rowIds(el, 'working')).toEqual([]);
  });

  it('the 20-row cap fills Needs you first and keeps full group counts', () => {
    const terminals = Array.from({ length: 22 }, (_, i) => term(`w${String(i).padStart(2, '0')}`, { name: `A ${i}` }));
    const t = setup({ terminals, sessions: [{ id: 'n1', name: 'Zed', state: 'asking' }, { id: 'n2', name: 'Zee', state: 'errored' }] });
    const { el } = mountBoard(t);
    expect(rowIds(el).length).toBe(20);
    expect(rowIds(el, 'needs')).toEqual(['n1', 'n2']);
    expect(byTestId(el, 'today-agents-group-working-count').textContent).toBe('22');
    expect(el.textContent).toContain('+4 more');
  });

  it('the filter decides the rows; a task run is never a row; the count is the total rows', () => {
    const t = setup({
      projects: [{ id: 'p1', name: 'Acme', mode: 'work' }, { id: 'p2', name: 'Home', mode: 'home' }],
      sessions: [{ id: 's1', projectId: 'p1', state: 'asking' }, { id: 's2', projectId: 'p2', state: 'asking' }],
      terminals: [term('run1')],
    });
    t.state.taskRunIds.add('run1');
    const counts = [];
    const { el } = mountBoard(t, { filter: (_i, p) => !p || p.id === 'p1', onCount: (n) => counts.push(n) });
    expect(rowIds(el)).toEqual(['s1']);
    expect(counts.at(-1)).toBe(1);
  });

  it('shows the empty note with no rows, and the offline note when relay is down', () => {
    const t = setup();
    const { el } = mountBoard(t);
    expect(el.dataset.state).toBe('empty');
    expect(el.textContent).toContain('No agents running');
    t.state.setConnection({ relay: false });
    expect(el.dataset.state).toBe('offline');
  });
});

describe('AgentBoard tap', () => {
  it('a session row joins that session; a terminal row opens its terminal', () => {
    const t = setup({ sessions: [{ id: 's1', state: 'asking' }], terminals: [term('t1')] });
    const { el } = mountBoard(t);
    byTestId(el, 'today-agent-s1').click();
    expect(t.app.joinSession).toHaveBeenCalledWith('s1');
    expect(t.mgr.openTaskTerminal).not.toHaveBeenCalled();
    byTestId(el, 'today-agent-t1').click();
    expect(t.mgr.openTaskTerminal).toHaveBeenCalledWith('t1');
    expect(t.app.joinSession).toHaveBeenCalledTimes(1);
  });
});

describe('AgentBoard.mountBadge', () => {
  const badgeOf = (t) => {
    const button = t.doc.createElement('button');
    const off = t.g.AgentBoard.mountBadge(button, t.container);
    return { button, off, badge: byTestId(button, 'nav-today-badge') };
  };

  it('counts Needs-you rows with Today\'s filter (in-mode or project-less), and hides at 0', () => {
    const t = setup({
      projects: [{ id: 'p1', name: 'Acme', mode: 'work' }, { id: 'p2', name: 'Home', mode: 'home' }],
      sessions: [
        { id: 's1', projectId: 'p1', state: 'asking' },
        { id: 's2', projectId: 'p2', state: 'asking' },   // other mode
        { id: 's3', projectId: '', state: 'stalled' },    // project-less
        { id: 's4', projectId: 'p1', state: 'running' },  // not needing me
      ],
      terminals: [term('t1', { state: 'stopped', exitCode: 2 })],
    });
    const { button, badge } = badgeOf(t);
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('3 need you');
    expect(button.getAttribute('aria-describedby')).toBe(badge.id);
    expect(button.getAttribute('aria-label')).toBeNull();

    for (const id of ['s1', 's3']) t.bus.emit(t.g.EVT.SESSION_STATE, { type: 'session_state', sessionId: id, state: 'ended', since: '2026-10-05T11:00:00.000Z' });
    t.mgr.allTerminals.clear();
    t.bus.emit(t.g.EVT.TERMINAL_LIST, {});
    expect(badge.hidden).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('is hidden while the terminal list has not loaded and while relay is down', () => {
    const t = setup({ sessions: [{ id: 's1', state: 'asking' }] });
    t.mgr.listLoaded = false;
    const { badge } = badgeOf(t);
    expect(badge.hidden).toBe(true);
    t.mgr.listLoaded = true;
    t.bus.emit(t.g.EVT.TERMINAL_LIST, {});
    expect(badge.hidden).toBe(false);
    t.state.setConnection({ relay: false });
    expect(badge.hidden).toBe(true);
  });
});
