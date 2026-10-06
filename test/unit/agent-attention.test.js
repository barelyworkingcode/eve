// AgentAttention (eve#195): the per-session state store behind the agent board.
// Run against the real EventBus, StateStore and constants, loaded as index.html
// loads them (plain scripts, one realm).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDocument, fakeLocalStorage } = require('./helpers/fake-dom');

const SCRIPTS = ['core/event-bus.js', 'core/constants.js', 'core/mode.js', 'core/state-store.js', 'agent-board.js'];

function setup() {
  const context = vm.createContext({
    console, document: createDocument(), localStorage: fakeLocalStorage(), navigator: { userAgent: '' }, setTimeout, clearTimeout,
  });
  context.window = context;
  for (const file of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'), context, { filename: file });
  }
  const g = vm.runInContext('({ EventBus, StateStore, AgentAttention, EVT })', context);
  const bus = new g.EventBus();
  const state = new g.StateStore(bus);
  const refreshList = jest.fn(() => Promise.resolve());
  const store = new g.AgentAttention({ bus, state, refreshList });
  const changed = [];
  bus.on(g.EVT.AGENTS_CHANGED, (d) => changed.push(d));
  const frame = (sessionId, st, since = '2026-10-05T10:00:00.000Z') =>
    bus.emit(g.EVT.SESSION_STATE, { type: 'session_state', sessionId, state: st, since });
  const list = (id, extra = {}) => state.addSession({ id, projectId: 'p1', name: id, model: 'claude-haiku-4-5-20251001', live: true, ...extra });
  return { g, bus, state, store, refreshList, changed, frame, list };
}

describe('AgentAttention', () => {
  beforeEach(() => jest.useFakeTimers());

  it('ignores a frame with no session id or a state outside the seven', () => {
    const t = setup();
    t.list('s1');
    t.frame(undefined, 'asking');
    t.frame('s1', 'napping');
    t.frame('s1', undefined);
    expect(t.store.get('s1')).toBeNull();
    expect(t.store.listedIds()).toEqual([]);
    expect(t.changed).toEqual([]);
  });

  it('a frame always overwrites the entry and announces the change', () => {
    const t = setup();
    t.list('s1');
    t.frame('s1', 'running', '2026-10-05T10:00:00.000Z');
    t.frame('s1', 'asking', '2026-10-05T10:00:05.000Z');
    expect(t.store.get('s1')).toEqual({ state: 'asking', since: '2026-10-05T10:00:05.000Z' });
    expect(t.changed.map((c) => c.sessionId)).toEqual(['s1', 's1']);
    expect(t.store.listedIds()).toEqual(['s1']);
  });

  it('seeds from the list row, and only a strictly newer `since` replaces an entry', () => {
    const t = setup();
    t.list('s1', { attention: { state: 'running', since: '2026-10-05T10:00:00.000Z' } });
    expect(t.store.get('s1').state).toBe('running');
    t.list('s1', { attention: { state: 'asking', since: '2026-10-05T10:00:00.000Z' } });   // equal: no change
    expect(t.store.get('s1').state).toBe('running');
    t.list('s1', { attention: { state: 'idle', since: '2026-10-05T09:59:00.000Z' } });     // older: no change
    expect(t.store.get('s1').state).toBe('running');
    t.list('s1', { attention: { state: 'errored', since: '2026-10-05T10:00:00.001Z' } });  // newer
    expect(t.store.get('s1')).toEqual({ state: 'errored', since: '2026-10-05T10:00:00.001Z' });
    t.list('s2', { attention: { state: 'napping', since: '2026-10-05T10:00:00.000Z' } });  // invalid
    expect(t.store.get('s2')).toBeNull();
  });

  it('a session with no attention and no frame is not listed; a task run never is', () => {
    const t = setup();
    t.list('old');
    t.list('run1', { attention: { state: 'running', since: '2026-10-05T10:00:00.000Z' } });
    t.state.taskRunIds.add('run1');
    expect(t.store.listedIds()).toEqual([]);
  });

  it('an unknown id asks for one list refresh after 500 ms, once per id, for a whole burst', () => {
    const t = setup();
    t.frame('x1', 'running');
    t.frame('x2', 'running');
    t.frame('x1', 'asking');
    expect(t.refreshList).not.toHaveBeenCalled();
    jest.advanceTimersByTime(499);
    expect(t.refreshList).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(t.refreshList).toHaveBeenCalledTimes(1);
    t.frame('x1', 'idle');
    jest.advanceTimersByTime(2000);
    expect(t.refreshList).toHaveBeenCalledTimes(1);
  });

  it('skips the refresh when the list has named every asking id by then', () => {
    const t = setup();
    t.frame('x1', 'asking');
    t.list('x1');
    jest.advanceTimersByTime(1000);
    expect(t.refreshList).not.toHaveBeenCalled();
  });

  it('an id the list never names is never listed; once named it appears', () => {
    const t = setup();
    t.frame('ghost', 'errored');
    jest.advanceTimersByTime(1000);
    expect(t.store.listedIds()).toEqual([]);
    t.list('ghost');
    expect(t.store.listedIds()).toEqual(['ghost']);
    expect(t.changed.at(-1)).toEqual({ sessionId: 'ghost' });
  });

  it('removing a session drops its entry', () => {
    const t = setup();
    t.list('s1');
    t.frame('s1', 'running');
    t.state.removeSession('s1');
    expect(t.store.get('s1')).toBeNull();
  });

  it('ended stays across a list refresh; a resume\'s starting frame returns it to Working', () => {
    const t = setup();
    t.list('s1');
    t.frame('s1', 'ended', '2026-10-05T10:00:10.000Z');
    t.list('s1', { live: false });   // the list reload carries no attention for a dead session
    expect(t.store.get('s1').state).toBe('ended');
    t.frame('s1', 'starting', '2026-10-05T10:05:00.000Z');
    expect(t.store.get('s1').state).toBe('starting');
  });

  it('reset drops live entries, keeps ended ones, and announces', () => {
    const t = setup();
    t.list('live1');
    t.list('done1');
    t.frame('live1', 'asking');
    t.frame('done1', 'ended');
    t.changed.length = 0;
    t.store.reset();
    expect(t.store.get('live1')).toBeNull();
    expect(t.store.get('done1').state).toBe('ended');
    expect(t.changed.length).toBe(1);
    // The reload that follows re-seeds a live session from the list.
    t.list('live1', { attention: { state: 'idle', since: '2026-10-05T10:09:00.000Z' } });
    expect(t.store.listedIds().sort()).toEqual(['done1', 'live1']);
  });

  it('an ended frame that beats the list keeps its entry and shows once the refresh names the session', async () => {
    const t = setup();
    t.refreshList.mockImplementation(() => { t.list('s1', { live: false }); return Promise.resolve(); });
    t.frame('s1', 'ended');
    jest.advanceTimersByTime(500);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(t.store.get('s1').state).toBe('ended');
    expect(t.store.listedIds()).toEqual(['s1']);
  });

  it('an ended id the refresh never names is dropped once the refresh resolves', async () => {
    const t = setup();
    t.frame('hidden', 'ended');
    jest.advanceTimersByTime(500);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(t.refreshList).toHaveBeenCalledTimes(1);
    expect(t.store.get('hidden')).toBeNull();
  });

  it('an ended frame for an id already asked about and never named is dropped at once', async () => {
    const t = setup();
    t.frame('hidden', 'starting');
    jest.advanceTimersByTime(500);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(t.store.get('hidden').state).toBe('starting');
    t.frame('hidden', 'ended');
    expect(t.store.get('hidden')).toBeNull();
    expect(t.refreshList).toHaveBeenCalledTimes(1);
  });
});
