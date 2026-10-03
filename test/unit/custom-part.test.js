// The custom-card registrar (eve#117 contract): a terminal routine with an
// output file is a Today part in its project's mode, after the Morning brief,
// ordered by routine name. Run against the real StateStore, TodayRegistry and
// TodayHost, loaded as index.html loads them (plain scripts, one realm).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createDocument, fakeLocalStorage } = require('./helpers/fake-dom');

const SCRIPTS = [
  'core/event-bus.js', 'core/constants.js', 'core/mode.js', 'core/state-store.js', 'core/task-schedule.js',
  'core/routine-sentence.js', 'routine-history.js', 'today/brief.js', 'today/custom-output.js',
  'today/today-parts.js', 'today/sources.js', 'today/today-ui.js', 'today/parts/custom-part.js',
];

function loadGlobals(doc) {
  const context = vm.createContext({
    console, document: doc, localStorage: fakeLocalStorage(), navigator: { userAgent: '' }, setTimeout, clearTimeout,
  });
  context.window = context;
  for (const file of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'), context, { filename: file });
  }
  return vm.runInContext('({ EventBus, StateStore, TodayRegistry, TodayHost, CustomParts })', context);
}

const PROJECTS = [
  { id: 'wk', name: 'Acme', mode: 'work' },
  { id: 'hm', name: 'Home', mode: 'home' },
  { id: 'bo', name: 'Both', mode: 'both' },
];
const card = (id, name, projectId, extra = {}) => ({
  id, name, projectId, sessionType: 'pty', templateId: 'shell', outputFile: 'today.json',
  schedule: { type: 'on_demand' }, enabled: true, ...extra,
});

// A mounted host, so a card only shows when the registrar both registers it
// and has the host lay out again. `before` fills the store before start().
function today(before = () => {}) {
  const doc = createDocument();
  const g = loadGlobals(doc);
  const bus = new g.EventBus();
  const state = new g.StateStore(bus);
  const registry = new g.TodayRegistry();
  const sources = { tasks: { status: 'loading', ensure() {}, reload() {}, describe: () => '' } };
  const host = new g.TodayHost({
    registry, doc, bus,
    ctxFor: (part, on) => ({ state, bus, on, sources, container: { has: () => false, get: () => null } }),
  });
  const root = doc.createElement('div');
  host.mount(root, 'work');
  before(state);
  new g.CustomParts({ registry, host, state, bus }).start();
  return {
    state,
    // Switches the host's mode only when asked for the other one, so a change
    // in the current mode shows only if the registrar re-laid the host out.
    shown: (mode) => {
      if (mode !== host.mode) host.setMode(mode);
      return root.children.map((c) => c.dataset.testid);
    },
    part: (mode, id) => registry.partsFor(mode).find((p) => p.id === `custom-${id}`),
  };
}

describe('CustomParts', () => {
  it('registers card routines in their project\'s mode, ordered by name (locale order, then id), titled with the name', () => {
    const t = today((state) => {
      state.setProjects(PROJECTS);
      state.setTasks([
        card('c2', 'beta', 'wk'), card('c3', 'Alpha', 'wk'), card('c1', 'Alpha', 'wk'),
        card('h1', 'Home card', 'hm'), card('b1', 'Both card', 'bo'),
      ]);
    });
    expect(t.shown('work')).toEqual(['today-part-custom-c1', 'today-part-custom-c3', 'today-part-custom-c2', 'today-part-custom-b1']);
    expect(t.shown('home')).toEqual(['today-part-custom-b1', 'today-part-custom-h1']);
    expect(t.part('work', 'c2').title).toBe('beta');
    // After the Morning brief (15), before Needs you (20).
    for (const id of ['c1', 'c3', 'c2', 'b1']) {
      expect(t.part('work', id).order).toBeGreaterThan(15);
      expect(t.part('work', id).order).toBeLessThan(20);
    }
  });

  it('follows the store: a new card shows, a renamed one retitles and moves, a deleted one goes', () => {
    const t = today((state) => state.setProjects(PROJECTS));
    t.state.setTasks([card('c1', 'Alpha', 'wk'), card('c2', 'Beta', 'wk')]);
    expect(t.shown('work')).toEqual(['today-part-custom-c1', 'today-part-custom-c2']);
    t.state.addTask(card('c2', 'Aardvark', 'wk'));
    expect(t.shown('work')).toEqual(['today-part-custom-c2', 'today-part-custom-c1']);
    expect(t.part('work', 'c2').title).toBe('Aardvark');
    t.state.removeTask('c1');
    expect(t.shown('work')).toEqual(['today-part-custom-c2']);
  });

  it.each([
    ['a chat routine with an output file', card('x', 'Chat', 'wk', { sessionType: 'headless', prompt: 'p', model: 'm' })],
    ['a terminal routine without one', card('x', 'Plain', 'wk', { outputFile: undefined })],
    ['a terminal routine with an empty one', card('x', 'Empty', 'wk', { outputFile: '' })],
  ])('never registers %s', (_what, task) => {
    const t = today((state) => state.setProjects(PROJECTS));
    t.state.setTasks([task, card('ok', 'A card', 'wk')]);
    expect(t.shown('work')).toEqual(['today-part-custom-ok']);
  });

  it('waits for a task\'s project, then follows a change to its mode', () => {
    const t = today((state) => state.setTasks([card('c1', 'Later', 'late')]));
    expect(t.shown('work')).toEqual([]);
    expect(t.shown('home')).toEqual([]);
    t.state.addProject({ id: 'late', name: 'Late', mode: 'home' });
    expect(t.shown('home')).toEqual(['today-part-custom-c1']);
    expect(t.shown('work')).toEqual([]);
    t.state.addProject({ id: 'late', name: 'Late', mode: 'work' });
    expect(t.shown('work')).toEqual(['today-part-custom-c1']);
    expect(t.shown('home')).toEqual([]);
  });
});
