// eve#274: the shared AgentBoard as the rail and the phone sheet use it: four groups, three-line
// rows, no row cap, a collapsible Done, counts, and every project. Real EventBus, StateStore,
// AgentAttention and AgentBoard against a fake DOM; renders are synchronous.
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
  const t = { g, bus, state, mgr, app, container, doc };
  for (const s of sessions) addSession(t, s);
  return t;
}

function addSession(t, s) {
  t.state.addSession({ id: s.id, projectId: s.projectId || '', name: s.name || s.id, model: s.model || 'haiku', headless: s.headless ?? true, live: true });
  t.bus.emit(t.g.EVT.SESSION_STATE, { type: 'session_state', sessionId: s.id, state: s.state, since: s.since || '2026-10-05T10:00:00.000Z' });
}

const term = (id, extra = {}) => ({ id, name: id, state: 'running', directory: '/nowhere', ...extra });
const mountRail = (t, opts = {}) => {
  const board = new t.g.AgentBoard({
    container: t.container, testidPrefix: 'rail', filter: () => true, maxRows: Infinity, layout: 'rail', collapseDone: true, ...opts,
  });
  const el = t.doc.createElement('div');
  board.mount(el);
  return { board, el };
};
const ids = (el, group) => el.querySelectorAll('[data-kind]')
  .filter((r) => r.dataset.testid.startsWith('rail-agent-') && (!group || r.parentNode.parentNode.dataset.testid === `rail-agents-group-${group}`))
  .map((r) => r.dataset.testid.replace('rail-agent-', ''));
const text = (el, testid) => byTestId(el, testid)?.textContent;

describe('groups and words', () => {
  it.each([
    ['asking', 'needs'], ['errored', 'needs'], ['stalled', 'needs'],
    ['running', 'working'], ['starting', 'working'],
    ['idle', 'idle'],
    ['ended', 'done'],
  ])('%s belongs to %s', (st, group) => {
    expect(setup().g.AgentBoard.groupOf(st)).toBe(group);
  });

  it('lists the groups Needs you, Working, Idle, Done, with a count each', () => {
    const t = setup({
      sessions: [
        { id: 'a', state: 'ended' }, { id: 'b', state: 'idle' }, { id: 'c', state: 'running' }, { id: 'd', state: 'asking' }, { id: 'e', state: 'idle' },
      ],
    });
    const { el } = mountRail(t, { collapseDone: false });
    const heads = el.querySelectorAll('section').map((sec) => sec.dataset.testid);
    expect(heads).toEqual(['rail-agents-group-needs', 'rail-agents-group-working', 'rail-agents-group-idle', 'rail-agents-group-done']);
    expect(ids(el)).toEqual(['d', 'c', 'b', 'e', 'a']);
    expect(text(el, 'rail-agents-group-idle-count')).toBe('2');
    expect(text(el, 'rail-agents-group-needs')).toContain('Needs you');
    expect(text(el, 'rail-agents-group-idle')).toContain('Idle');
  });
});

describe('ago', () => {
  const NOW = Date.parse('2026-10-05T12:00:00.000Z');
  const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
  it.each([
    [0, 'now'], [59, 'now'],
    [60, '1m'], [4 * 60 + 10, '4m'], [59 * 60 + 59, '59m'],
    [3600, '1h'], [2 * 3600 + 5, '2h'], [23 * 3600 + 3599, '23h'],
    [86400, '1d'], [3 * 86400 + 100, '3d'],
  ])('%is ago is %s', (secs, expected) => {
    expect(setup().g.AgentBoard.ago(at(secs), NOW)).toBe(expected);
  });

  it.each([[''], ['not a date'], [undefined], [null]])('%j is empty', (v) => {
    expect(setup().g.AgentBoard.ago(v, NOW)).toBe('');
  });
});

describe('rail row lines', () => {
  const NOTE = (kind, source, textValue = 'Wants approval to push') => ({ kind, source, text: textValue });

  it('line 1 has the label and the age, line 2 the project and the state in words', () => {
    const since = new Date(Date.now() - (4 * 60 + 5) * 1000).toISOString();
    const t = setup({
      projects: [{ id: 'p1', name: 'Acme', mode: 'work' }],
      sessions: [{ id: 's1', name: 'Fix login flake', projectId: 'p1', state: 'asking', since }, { id: 's2', name: 'Loose', state: 'stalled' }],
    });
    const { el } = mountRail(t);
    const row = byTestId(el, 'rail-agent-s1');
    expect(row.dataset.kind).toBe('session');
    expect(row.dataset.state).toBe('asking');
    expect(row.textContent).toContain('Fix login flake');
    expect(text(el, 'rail-agent-age-s1')).toBe('4m');
    expect(text(el, 'rail-agent-meta-s1')).toBe('Acme · Waiting on you');
    expect(text(el, 'rail-agent-meta-s2')).toBe('Gone quiet'); // no project: just the words
  });

  it.each([
    ['asking', 'Waiting on you'], ['errored', 'Stopped with an error'], ['stalled', 'Gone quiet'],
    ['running', 'Working'], ['starting', 'Starting'], ['idle', 'Idle'], ['ended', 'Done'],
  ])('a %s session says "%s"', (st, words) => {
    const t = setup({ sessions: [{ id: 's1', state: st }] });
    const { el } = mountRail(t, { collapseDone: false });
    expect(text(el, 'rail-agent-meta-s1')).toBe(words);
  });

  // The table in the contract: which note, if any, becomes line 3 of which row.
  it.each([
    ['needs, alert note', 'asking', NOTE('alert', 'model'), { kind: 'alert', source: 'model' }],
    ['needs, alert note from the template', 'errored', NOTE('alert', 'template'), { kind: 'alert', source: 'template' }],
    ['needs, summary note', 'asking', NOTE('summary', 'model'), null],
    ['working, summary note', 'running', NOTE('summary', 'model'), null],
    ['working, alert note', 'starting', NOTE('alert', 'model'), null],
    ['idle, pending summary', 'idle', NOTE('summary', 'pending'), { kind: 'summary', source: 'pending' }],
    ['idle, template summary', 'idle', NOTE('summary', 'template'), { kind: 'summary', source: 'template' }],
    ['idle, model summary', 'idle', NOTE('summary', 'model'), { kind: 'summary', source: 'model' }],
    ['idle, alert note', 'idle', NOTE('alert', 'model'), null],
    ['done, summary note', 'ended', NOTE('summary', 'model'), { kind: 'summary', source: 'model' }],
    ['idle, no note', 'idle', null, null],
  ])('%s', (_what, st, note, expected) => {
    const t = setup({ sessions: [{ id: 's1', state: st }] });
    const { el } = mountRail(t, { collapseDone: false, note: (id) => (id === 's1' ? note : null) });
    const line = byTestId(el, 'rail-agent-line-s1');
    if (!expected) { expect(line).toBeNull(); return; }
    expect(line.textContent).toBe(note.text);
    expect(line.dataset.kind).toBe(expected.kind);
    expect(line.dataset.source).toBe(expected.source);
  });

  it('shows note text as text, never as markup', () => {
    const t = setup({ sessions: [{ id: 's1', state: 'idle' }] });
    const { el } = mountRail(t, { note: () => NOTE('summary', 'model', '<img src=x onerror=alert(1)>') });
    const line = byTestId(el, 'rail-agent-line-s1');
    expect(line.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(line.querySelectorAll('img')).toHaveLength(0);
  });

  it('a terminal row shows its live last line as kind last, its own words, and no age', () => {
    const t = setup({ terminals: [term('t1', { name: 'Shell' }), term('t2', { name: 'Build', state: 'stopped', exitCode: 2 })] });
    t.mgr.lastLineOf = (id) => (id === 't1' ? '> Reading todo.md' : null);
    const { el } = mountRail(t, { note: () => NOTE('summary', 'model') });
    const line = byTestId(el, 'rail-agent-line-t1');
    expect(line.textContent).toBe('> Reading todo.md');
    expect(line.dataset.kind).toBe('last');
    expect(line.classList.contains('agent-row__last')).toBe(true);
    expect(text(el, 'rail-agent-meta-t1')).toBe('open');
    expect(text(el, 'rail-agent-meta-t2')).toBe('exited 2');
    expect(byTestId(el, 'rail-agent-age-t1')).toBeNull();
  });

  it('Today\'s board layout is unchanged: no age, meta or third line, and it ignores a note', () => {
    const t = setup({ sessions: [{ id: 's1', state: 'idle' }] });
    const board = new t.g.AgentBoard({ container: t.container, testidPrefix: 'today', filter: () => true, note: () => NOTE('summary', 'model') });
    const el = t.doc.createElement('div');
    board.mount(el);
    expect(byTestId(el, 'today-agent-s1')).not.toBeNull();
    for (const kind of ['age', 'meta', 'line']) expect(byTestId(el, `today-agent-${kind}-s1`)).toBeNull();
    expect(byTestId(el, 'today-agents-group-idle')).not.toBeNull();
  });

  it('a row keeps its place when its note changes', () => {
    const notes = {};
    const t = setup({ sessions: [{ id: 'a', name: 'Alpha', state: 'idle' }, { id: 'b', name: 'Beta', state: 'idle' }, { id: 'c', name: 'Gamma', state: 'idle' }] });
    const { board, el } = mountRail(t, { note: (id) => notes[id] || null });
    expect(ids(el, 'idle')).toEqual(['a', 'b', 'c']);
    notes.c = NOTE('summary', 'pending', 'Zzz first words');
    board.render();
    notes.c = NOTE('summary', 'model', 'Aaa the summary');
    notes.a = NOTE('summary', 'model', 'Zzz other');
    board.render();
    expect(ids(el, 'idle')).toEqual(['a', 'b', 'c']);
    expect(text(el, 'rail-agent-line-c')).toBe('Aaa the summary');
    expect(byTestId(el, 'rail-agent-line-c').dataset.source).toBe('model');
  });
});

describe('maxRows', () => {
  it('Infinity shows all 25 rows and no "+N more"', () => {
    const t = setup({ terminals: Array.from({ length: 25 }, (_, i) => term(`t${String(i).padStart(2, '0')}`)) });
    const { el } = mountRail(t);
    expect(ids(el)).toHaveLength(25);
    expect(el.textContent).not.toContain('more');
    expect(text(el, 'rail-agents-group-working-count')).toBe('25');
  });
});

describe('collapseDone', () => {
  const build = () => {
    const t = setup({ sessions: [{ id: 'a', state: 'ended' }, { id: 'b', state: 'ended' }, { id: 'c', state: 'running' }] });
    return { t, ...mountRail(t) };
  };
  const toggle = (el) => byTestId(el, 'rail-agents-group-done').querySelector('button[aria-expanded]');

  it('starts collapsed: the header is a toggle with aria-expanded false, the count shows, no Done rows', () => {
    const { el } = build();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
    expect(text(el, 'rail-agents-group-done-count')).toBe('2');
    expect(ids(el, 'done')).toEqual([]);
    expect(ids(el, 'working')).toEqual(['c']);
  });

  it('the toggle opens the list and closes it again', () => {
    const { el } = build();
    toggle(el).click();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
    expect(ids(el, 'done')).toEqual(['a', 'b']);
    toggle(el).click();
    expect(toggle(el).getAttribute('aria-expanded')).toBe('false');
    expect(ids(el, 'done')).toEqual([]);
  });

  it('stays open across a state change, per board instance', () => {
    const { t, el } = build();
    toggle(el).click();
    addSession(t, { id: 'd', state: 'ended' });
    expect(ids(el, 'done')).toEqual(['a', 'b', 'd']);
    expect(toggle(el).getAttribute('aria-expanded')).toBe('true');
    const other = mountRail(t);
    expect(toggle(other.el).getAttribute('aria-expanded')).toBe('false');
  });

  it('without collapseDone the Done rows show and the header is no button', () => {
    const t = setup({ sessions: [{ id: 'a', state: 'ended' }] });
    const { el } = mountRail(t, { collapseDone: false });
    expect(ids(el, 'done')).toEqual(['a']);
    expect(byTestId(el, 'rail-agents-group-done').querySelector('button[aria-expanded]')).toBeNull();
  });
});

describe('onCounts', () => {
  const lastOf = (calls) => calls[calls.length - 1];

  it('gives the rows per group', () => {
    const t = setup({ sessions: [{ id: 'a', state: 'asking' }, { id: 'b', state: 'stalled' }, { id: 'c', state: 'running' }, { id: 'd', state: 'idle' }, { id: 'e', state: 'ended' }] });
    const calls = [];
    mountRail(t, { onCounts: (c) => calls.push(c) });
    expect(lastOf(calls)).toEqual({ needs: 2, working: 1, idle: 1, done: 1 });
  });

  it('gives zeros, not null, when there are no agents', () => {
    const t = setup();
    const calls = [];
    const { el } = mountRail(t, { onCounts: (c) => calls.push(c) });
    expect(lastOf(calls)).toEqual({ needs: 0, working: 0, idle: 0, done: 0 });
    expect(text(el, 'rail-agents-empty')).toBe('No agents running');
  });

  it('gives null while relay is unreachable and while the terminal list is loading, and shows the offline note', () => {
    const t = setup({ sessions: [{ id: 'a', state: 'asking' }] });
    const calls = [];
    const { el } = mountRail(t, { onCounts: (c) => calls.push(c) });
    expect(lastOf(calls)).toEqual({ needs: 1, working: 0, idle: 0, done: 0 });
    t.state.setConnection({ relay: false });
    expect(lastOf(calls)).toBeNull();
    expect(text(el, 'rail-agents-offline')).toBe("Can't reach relay.");
    t.state.setConnection({ relay: true });
    expect(lastOf(calls)).not.toBeNull();

    const loading = setup({ sessions: [{ id: 'a', state: 'asking' }] });
    loading.mgr.listLoaded = false;
    const calls2 = [];
    mountRail(loading, { onCounts: (c) => calls2.push(c) });
    expect(lastOf(calls2)).toBeNull();
  });
});

describe('onOpen', () => {
  it('a row tap joins the session, then calls onOpen with the row', () => {
    const t = setup({ sessions: [{ id: 's1', name: 'One', state: 'idle' }] });
    const opened = [];
    const { el } = mountRail(t, { onOpen: (r) => opened.push(r) });
    byTestId(el, 'rail-agent-s1').click();
    expect(t.app.joinSession).toHaveBeenCalledWith('s1');
    expect(opened.map((r) => [r.kind, r.id, r.state, r.group])).toEqual([['session', 's1', 'idle', 'idle']]);
  });

  it('a terminal tap opens the terminal, then calls onOpen', () => {
    const t = setup({ terminals: [term('t1')] });
    const opened = [];
    const { el } = mountRail(t, { onOpen: (r) => opened.push(r.id) });
    byTestId(el, 'rail-agent-t1').click();
    expect(t.mgr.openTaskTerminal).toHaveBeenCalledWith('t1');
    expect(opened).toEqual(['t1']);
  });

  it('Drop in on a Needs-you row calls onOpen too, and a plain tap works without onOpen', () => {
    const t = setup({ sessions: [{ id: 's1', state: 'errored' }] });
    t.container.get('api').dropIn = jest.fn(() => new Promise(() => {}));
    const opened = [];
    const { el } = mountRail(t, { onOpen: (r) => opened.push(r.id) });
    byTestId(el, 'rail-drop-in-s1').click();
    expect(t.container.get('api').dropIn).toHaveBeenCalledWith('s1', expect.anything());
    expect(opened).toEqual(['s1']);

    const bare = setup({ sessions: [{ id: 's2', state: 'idle' }] });
    const b = mountRail(bare);
    expect(() => byTestId(b.el, 'rail-agent-s2').click()).not.toThrow();
    expect(bare.app.joinSession).toHaveBeenCalledWith('s2');
  });
});

describe('every project', () => {
  const projects = [
    { id: 'pw', name: 'Acme', mode: 'work', path: '/work/acme' },
    { id: 'ph', name: 'Garden', mode: 'home', path: '/home/garden' },
    { id: 'px', name: 'Remote', mode: 'home', hostId: 'host1', path: '/srv/app' },
  ];

  it('with filter () => true, shows work, home, hosted and project-less rows while the mode is work', () => {
    const t = setup({
      projects,
      sessions: [
        { id: 'sw', projectId: 'pw', state: 'idle' }, { id: 'sh', projectId: 'ph', state: 'idle' },
        { id: 'sx', projectId: 'px', state: 'asking' }, { id: 'sn', projectId: '', state: 'idle' },
      ],
    });
    const { el } = mountRail(t);
    expect(ids(el).sort()).toEqual(['sh', 'sn', 'sw', 'sx']);
    expect(text(el, 'rail-agent-meta-sx')).toBe('Remote · Waiting on you');
    expect(text(el, 'rail-agent-meta-sh')).toBe('Garden · Idle');
  });

  it('maps a terminal to a hosted project only on the same host', () => {
    const t = setup({
      projects,
      terminals: [
        term('th', { name: 'Remote shell', directory: '/srv/app/sub', host: { id: 'host1' } }),
        term('tl', { name: 'Local shell', directory: '/srv/app/sub' }),
      ],
    });
    const { el } = mountRail(t);
    expect(text(el, 'rail-agent-meta-th')).toBe('Remote · open');
    expect(text(el, 'rail-agent-meta-tl')).toBe('open');
  });

  it('keeps a task run out of the rail', () => {
    const t = setup({ terminals: [term('run1'), term('t1')] });
    t.state.taskRunIds.add('run1');
    expect(ids(mountRail(t).el)).toEqual(['t1']);
  });
});
