// Sidebar Changes tab (docs/design-git-changes.md, "Sidebar: a fifth panel
// tab" + "Client bus events"). changes-panel.js and project-panel.js are
// classic <script> globals, so they're evaluated into this realm by
// helpers/fake-dom.js#loadScript (jest fake timers and Date reach them) and
// render into the small fake DOM there — the repo has no jsdom.
const {
  createDocument,
  fakeLocalStorage,
  byTestId,
  allTestIds,
  loadScript,
  loadConstants,
  loadEventBus,
} = require('./helpers/fake-dom');

const { EVT } = loadConstants();
const EventBus = loadEventBus();

const LRM = '‎';

function repoMeta(overrides) {
  return {
    branch: null, head: '0000000', detached: false, upstream: null, ahead: 0, behind: 0,
    defaultBranch: 'main', base: null, truncated: false, files: [], ...overrides,
  };
}

// Server order is discovery order; the clean one deliberately comes first so
// "clean sorts last" is actually exercised.
function fixtureRepos() {
  return [
    repoMeta({ path: '/main', name: 'main', branch: 'main', head: 'aaaaaaa', files: [] }),
    repoMeta({
      path: '/feat-login', name: 'feat-login', branch: 'feat/login', head: 'bbbbbbb',
      upstream: 'origin/feat/login', ahead: 3, behind: 1,
      files: [
        { path: 'routes/auth.js', status: 'M', staged: false },
        { path: 'token-store.js', status: 'A', staged: true },
        { path: 'old-session.js', status: 'D', staged: false },
        { path: 'notes.md', status: '?', staged: false },
        { path: 'public/login.css', oldPath: 'public/signin.css', status: 'R', staged: true },
      ],
    }),
    repoMeta({
      path: '/fix-timeouts', name: 'fix-timeouts', branch: null, head: 'ccccccc', detached: true,
      files: [{ path: 'relay-client.js', status: 'M', staged: false }],
    }),
  ];
}

function setup({ storage = {}, projects, hostStatus = 'connected', withApp = true } = {}) {
  global.document = createDocument();
  global.localStorage = fakeLocalStorage(storage);
  global.EVT = EVT;
  global.UI_ICONS = { caret: () => '<svg></svg>' };
  global.PANEL_ICONS = { branchSmall: '<svg></svg>' };
  global.getFileIconSVG = () => document.createElement('svg');
  const { ChangesPanel } = loadScript('sidebar/changes-panel.js', ['ChangesPanel']);

  const bus = new EventBus();
  const ws = { send: jest.fn() };
  const projectMap = new Map((projects || [{ id: 'p1', name: 'P1', path: '/work/p1' }]).map((p) => [p.id, p]));
  const hosts = { status: hostStatus };
  const state = {
    getProject: (id) => projectMap.get(id),
    hostStatus: jest.fn(() => hosts.status),
  };
  const app = { closeSidebarOnMobile: jest.fn() };
  const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
  const services = { bus, ws, state, logger, ...(withApp ? { app } : {}) };
  const container = {
    get: (k) => services[k],
    has: (k) => Object.prototype.hasOwnProperty.call(services, k),
  };
  const panel = new ChangesPanel(container);
  panel.onUpdate = jest.fn();
  return { ChangesPanel, panel, bus, ws, state, hosts, app, container };
}

function render(panel) {
  const root = document.createElement('div');
  panel.render(root);
  return root;
}

function sentFrames(ws) {
  return ws.send.mock.calls.map(([f]) => f);
}

// Pass `repo` for a single-repo reply: the server echoes it only when the
// request named one, and that echo is what makes the panel merge.
function reply(bus, repos = fixtureRepos(), { projectId = 'p1', scope = 'uncommitted', repo } = {}) {
  const frame = { type: 'git_changes', projectId, scope, repos };
  if (repo !== undefined) frame.repo = repo;
  bus.emit(EVT.GIT_CHANGES, frame);
}

// Loaded panel for p1 with the fixture list in the uncommitted scope.
function loaded(opts) {
  const ctx = setup(opts);
  ctx.panel.setProject('p1');
  reply(ctx.bus);
  ctx.ws.send.mockClear();
  ctx.panel.onUpdate.mockClear();
  return ctx;
}

function groupOrder(root) {
  return allTestIds(root).filter((id) => /^changes-repo-\//.test(id));
}

describe('ChangesPanel requests', () => {
  it('requests git_changes in the default "uncommitted" scope when a project is set', () => {
    const { panel, ws } = setup();
    panel.setProject('p1');
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('requests in the persisted scope from eve-changes-scope', () => {
    const { panel, ws } = setup({ storage: { 'eve-changes-scope': 'base' } });
    panel.setProject('p1');
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'base' }]);
  });

  it('ignores an unknown persisted scope and falls back to uncommitted', () => {
    const { panel, ws } = setup({ storage: { 'eve-changes-scope': 'everything' } });
    panel.setProject('p1');
    expect(sentFrames(ws)[0].scope).toBe('uncommitted');
  });

  it('does not re-request while a request is in flight or the list is fresh', () => {
    const { panel, ws, bus } = setup();
    panel.setProject('p1');
    panel.setProject('p1');
    expect(ws.send).toHaveBeenCalledTimes(1);
    reply(bus);
    panel.setProject('p1');
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('refresh() forces a full request even when fresh', () => {
    const { panel, ws } = loaded();
    panel.refresh();
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('sends nothing without a project', () => {
    const { panel, ws } = setup();
    panel.setProject(null);
    panel.refresh();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('ChangesPanel count (tab badge)', () => {
  it('is null before any data arrives', () => {
    const { panel } = setup();
    panel.setProject('p1');
    expect(panel.count()).toBeNull();
  });

  it('totals changed files across all repos and notifies the owner', () => {
    const { panel, bus } = setup();
    panel.setProject('p1');
    reply(bus);
    expect(panel.count()).toBe(6);
    expect(panel.onUpdate).toHaveBeenCalled();
  });

  it('is 0 (badge hidden by ProjectPanel) when every repo is clean', () => {
    const { panel, bus } = setup();
    panel.setProject('p1');
    reply(bus, [repoMeta({ path: '/main', name: 'main', branch: 'main' })]);
    expect(panel.count()).toBe(0);
  });

  it('does not notify for a reply belonging to another project', () => {
    const { panel, bus } = setup({ projects: [{ id: 'p1' }, { id: 'p2' }] });
    panel.setProject('p1');
    reply(bus, fixtureRepos(), { projectId: 'p2' });
    expect(panel.onUpdate).not.toHaveBeenCalled();
    expect(panel.count()).toBeNull();
  });
});

describe('ChangesPanel rendering', () => {
  it('shows a loading note before data arrives', () => {
    const { panel } = setup();
    panel.setProject('p1');
    const root = render(panel);
    expect(byTestId(root, 'changes-panel')).not.toBeNull();
    expect(byTestId(root, 'changes-loading')).not.toBeNull();
  });

  it('renders the scope toggle with the active scope pressed', () => {
    const { panel } = loaded();
    const root = render(panel);
    expect(byTestId(root, 'changes-scope-uncommitted').getAttribute('aria-pressed')).toBe('true');
    expect(byTestId(root, 'changes-scope-base').getAttribute('aria-pressed')).toBe('false');
  });

  it('sorts clean repos last, keeping server order among the dirty ones', () => {
    const { panel } = loaded();
    expect(groupOrder(render(panel))).toEqual([
      'changes-repo-/feat-login', 'changes-repo-/fix-timeouts', 'changes-repo-/main',
    ]);
  });

  it('starts a clean repo collapsed with a "clean" count and no rows', () => {
    const { panel } = loaded();
    const root = render(panel);
    const header = byTestId(root, 'changes-repo-/main');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(header.classList.contains('changes-panel__repo--collapsed')).toBe(true);
    expect(header.querySelector('.changes-panel__count').textContent).toBe('clean');
    const body = header.parentNode.querySelector('.changes-panel__files');
    expect(body.hidden).toBe(true);
    expect(body.children).toHaveLength(0);
  });

  it('shows the branch name in the chip, ahead/behind, and the file count', () => {
    const { panel } = loaded();
    const header = byTestId(render(panel), 'changes-repo-/feat-login');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(header.querySelector('.changes-panel__repo-name').textContent).toBe('feat-login');
    const chip = header.querySelector('.changes-panel__branch');
    expect(chip.querySelector('.changes-panel__branch-text').textContent).toBe('feat/login');
    expect(chip.classList.contains('changes-panel__branch--detached')).toBe(false);
    expect(chip.title).toBe('Branch feat/login → origin/feat/login');
    expect(header.querySelector('.changes-panel__sync').textContent).toBe('↑3 ↓1');
    expect(header.querySelector('.changes-panel__count').textContent).toBe('5');
  });

  it('shows the short SHA in the chip for a detached HEAD, and no sync marker at 0/0', () => {
    const { panel } = loaded();
    const header = byTestId(render(panel), 'changes-repo-/fix-timeouts');
    const chip = header.querySelector('.changes-panel__branch');
    expect(chip.querySelector('.changes-panel__branch-text').textContent).toBe('ccccccc');
    expect(chip.classList.contains('changes-panel__branch--detached')).toBe(true);
    expect(chip.title).toBe('Detached HEAD at ccccccc');
    expect(header.querySelector('.changes-panel__sync')).toBeNull();
    expect(header.querySelector('.changes-panel__count').textContent).toBe('1');
  });

  it('renders a file row: status letter, file name, dimmed parent dir', () => {
    const { panel } = loaded();
    const row = byTestId(render(panel), 'changes-file-/feat-login:routes/auth.js');
    expect(row.tagName).toBe('BUTTON');
    const letter = row.querySelector('.changes-panel__status');
    expect(letter.textContent).toBe('M');
    expect(letter.classList.contains('changes-panel__status--M')).toBe(true);
    expect(row.querySelector('.changes-panel__name').textContent).toBe('auth.js');
    expect(row.querySelector('.changes-panel__dir').textContent).toBe(`${LRM}routes/${LRM}`);
    expect(row.title).toBe('routes/auth.js');
    expect(row.getAttribute('aria-label')).toBe('Modified: routes/auth.js');
  });

  it('omits the dir span for a file at the repo root', () => {
    const { panel } = loaded();
    const row = byTestId(render(panel), 'changes-file-/feat-login:token-store.js');
    expect(row.querySelector('.changes-panel__status').textContent).toBe('A');
    expect(row.querySelector('.changes-panel__dir')).toBeNull();
  });

  it('marks deleted names and untracked letters with their own classes', () => {
    const { panel } = loaded();
    const root = render(panel);
    const deleted = byTestId(root, 'changes-file-/feat-login:old-session.js');
    expect(deleted.querySelector('.changes-panel__name').classList.contains('changes-panel__name--deleted')).toBe(true);
    const untracked = byTestId(root, 'changes-file-/feat-login:notes.md');
    const letter = untracked.querySelector('.changes-panel__status');
    expect(letter.textContent).toBe('?');
    expect(letter.classList.contains('changes-panel__status--untracked')).toBe(true);
  });

  it('shows "old → new" as the title of a renamed row', () => {
    const { panel } = loaded();
    const row = byTestId(render(panel), 'changes-file-/feat-login:public/login.css');
    expect(row.querySelector('.changes-panel__status').textContent).toBe('R');
    expect(row.title).toBe('public/signin.css → public/login.css');
    expect(row.getAttribute('aria-label')).toBe('Renamed: public/signin.css renamed to public/login.css');
  });

  it('shows the empty note when the project holds no repos', () => {
    const { panel, bus } = setup();
    panel.setProject('p1');
    reply(bus, []);
    const root = render(panel);
    expect(byTestId(root, 'changes-empty').textContent).toBe('No git repositories in this project');
    expect(panel.count()).toBe(0);
  });

  it('shows a truncation note under a capped repo', () => {
    const { panel, bus } = setup();
    panel.setProject('p1');
    const repos = fixtureRepos();
    repos[1].truncated = true;
    reply(bus, repos);
    const note = byTestId(render(panel), 'changes-truncated-/feat-login');
    expect(note.textContent).toBe('Showing first 5,000 files');
  });

  it('shows a per-repo error inline, with "!" as the count, and does not sort it as clean', () => {
    const { panel, bus } = setup();
    panel.setProject('p1');
    const repos = fixtureRepos();
    repos[0] = { ...repos[0], error: { code: 'TIMEOUT', message: 'git timed out after 10s' } };
    reply(bus, repos);
    const root = render(panel);
    const header = byTestId(root, 'changes-repo-/main');
    expect(header.querySelector('.changes-panel__count').textContent).toBe('!');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(byTestId(root, 'changes-repo-error-/main').textContent).toBe('git timed out');
    expect(groupOrder(root)[0]).toBe('changes-repo-/main');
  });
});

describe('ChangesPanel collapse persistence (eve-changes-collapsed)', () => {
  it('collapses an expanded repo on header click, persists it, and asks to refocus the header', () => {
    const { panel } = loaded();
    byTestId(render(panel), 'changes-repo-/feat-login').click();
    expect(JSON.parse(localStorage.getItem('eve-changes-collapsed'))).toEqual({ 'p1:/feat-login': true });
    expect(panel.onUpdate).toHaveBeenCalledWith({ focusTestId: 'changes-repo-/feat-login' });

    const header = byTestId(render(panel), 'changes-repo-/feat-login');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(byTestId(render(panel), 'changes-file-/feat-login:routes/auth.js')).toBeNull();
  });

  it('remembers that a clean repo was expanded, overriding the clean default', () => {
    const { panel } = loaded();
    byTestId(render(panel), 'changes-repo-/main').click();
    expect(JSON.parse(localStorage.getItem('eve-changes-collapsed'))).toEqual({ 'p1:/main': false });
    expect(byTestId(render(panel), 'changes-repo-/main').getAttribute('aria-expanded')).toBe('true');
  });

  it('restores collapse state from storage', () => {
    const { panel } = loaded({ storage: { 'eve-changes-collapsed': JSON.stringify({ 'p1:/fix-timeouts': true }) } });
    expect(byTestId(render(panel), 'changes-repo-/fix-timeouts').getAttribute('aria-expanded')).toBe('false');
  });

  it('survives a corrupt stored value', () => {
    const { panel } = loaded({ storage: { 'eve-changes-collapsed': '{nope' } });
    expect(byTestId(render(panel), 'changes-repo-/feat-login').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ChangesPanel scope toggle (eve-changes-scope)', () => {
  it('switching to "vs base" persists, requests that scope, and re-renders', () => {
    const { panel, ws } = loaded();
    byTestId(render(panel), 'changes-scope-base').click();
    expect(localStorage.getItem('eve-changes-scope')).toBe('base');
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'base' }]);
    expect(panel.onUpdate).toHaveBeenCalled();
    expect(panel.count()).toBeNull(); // no base-scope data yet
    expect(byTestId(render(panel), 'changes-scope-base').getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps each scope cached separately and does not refetch a fresh one', () => {
    const { panel, ws, bus } = loaded();
    byTestId(render(panel), 'changes-scope-base').click();
    reply(bus, [repoMeta({ path: '/feat-login', name: 'feat-login', branch: 'feat/login', base: 'ddddddd',
      files: [{ path: 'routes/session.js', status: 'A' }] })], { scope: 'base' });
    expect(panel.count()).toBe(1);
    ws.send.mockClear();

    byTestId(render(panel), 'changes-scope-uncommitted').click();
    expect(ws.send).not.toHaveBeenCalled();
    expect(panel.count()).toBe(6);
  });

  it('clicking the already-active scope does nothing', () => {
    const { panel, ws } = loaded();
    byTestId(render(panel), 'changes-scope-uncommitted').click();
    expect(ws.send).not.toHaveBeenCalled();
    expect(localStorage.getItem('eve-changes-scope')).toBeNull();
  });
});

describe('ChangesPanel merging replies', () => {
  it('a single-repo reply replaces just that group', () => {
    const { panel, bus } = loaded();
    reply(bus, [repoMeta({ path: '/fix-timeouts', name: 'fix-timeouts', head: 'ccccccc', detached: true,
      files: [{ path: 'relay-client.js', status: 'M' }, { path: 'retry.js', status: '?' }] })],
    { repo: '/fix-timeouts' });
    expect(panel.count()).toBe(7);
    const root = render(panel);
    expect(byTestId(root, 'changes-file-/fix-timeouts:retry.js')).not.toBeNull();
    expect(byTestId(root, 'changes-file-/feat-login:routes/auth.js')).not.toBeNull();
    expect(groupOrder(root)).toHaveLength(3);
  });

  it('a single-repo reply for an unknown repo appends it', () => {
    const { panel, bus } = loaded();
    reply(bus, [repoMeta({ path: '/docs-update', name: 'docs-update', branch: 'docs/update',
      files: [{ path: 'README.md', status: 'M' }] })], { repo: '/docs-update' });
    expect(groupOrder(render(panel))).toContain('changes-repo-/docs-update');
    expect(panel.count()).toBe(7);
  });

  it('a full reply (answering a full request) replaces the whole list', () => {
    const { panel, bus } = loaded();
    panel.refresh();
    reply(bus, fixtureRepos().filter((r) => r.path !== '/fix-timeouts'));
    const root = render(panel);
    expect(groupOrder(root)).toEqual(['changes-repo-/feat-login', 'changes-repo-/main']);
    expect(panel.count()).toBe(5);
  });

  // Regression: before the `repo` echo, a single-repo reply landing while a
  // full request was pending was taken as the full answer and the other
  // groups vanished until the full reply arrived.
  it('a single-repo reply arriving while a full request is pending does not drop the other repos', () => {
    jest.useFakeTimers();
    const { panel, bus, ws } = loaded();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/fix-timeouts' });
    jest.advanceTimersByTime(300); // sends the single-repo request
    panel.refresh();                // user hits ⟳: full request now pending
    expect(sentFrames(ws).map((f) => f.repo || null)).toEqual(['/fix-timeouts', null]);

    // The cheap single-repo answer lands first.
    reply(bus, [fixtureRepos()[2]], { repo: '/fix-timeouts' });
    expect(groupOrder(render(panel))).toHaveLength(3);
  });

  it('a reply without `repo` replaces the full list even with no full request pending', () => {
    const { panel, bus } = loaded();
    reply(bus, [fixtureRepos()[2]]);
    const root = render(panel);
    expect(groupOrder(root)).toEqual(['changes-repo-/fix-timeouts']);
  });
});

// Contract "Streaming": a full request is answered first by a full-list frame
// with every repo `pending: true`, then by one single-repo frame per repo.
describe('ChangesPanel streamed replies (pending repos)', () => {
  const pendingRepo = (p) => repoMeta({ path: p, name: p.slice(1), branch: p.slice(1), pending: true, files: [] });

  // Server order: /alpha, /beta, /gamma — all pending.
  function streaming() {
    const ctx = setup();
    ctx.panel.setProject('p1');
    reply(ctx.bus, ['/alpha', '/beta', '/gamma'].map(pendingRepo));
    return ctx;
  }

  function arrive(bus, p, files, extra = {}) {
    reply(bus, [repoMeta({ path: p, name: p.slice(1), branch: p.slice(1), pending: false, files, ...extra })], { repo: p });
  }

  it('renders a group header per pending repo with a pending marker and no count', () => {
    const { panel } = streaming();
    const root = render(panel);
    expect(byTestId(root, 'changes-loading')).toBeNull();
    for (const p of ['/alpha', '/beta', '/gamma']) {
      const header = byTestId(root, `changes-repo-${p}`);
      expect(header).not.toBeNull();
      expect(header.querySelector('.changes-panel__repo-name').textContent).toBe(p.slice(1));
      expect(byTestId(header, `changes-repo-pending-${p}`)).not.toBeNull();
      // Not "clean", not "0": the count is simply absent until status arrives.
      expect(header.querySelector('.changes-panel__count')).toBeNull();
    }
  });

  it('the badge counts nothing while every repo is pending', () => {
    const { panel } = streaming();
    expect(panel.count() || 0).toBe(0);
  });

  it('the badge sums only the repos that have arrived', () => {
    const { panel, bus } = streaming();
    arrive(bus, '/beta', [{ path: 'b1.js', status: 'M' }, { path: 'b2.js', status: '?' }]);
    expect(panel.count()).toBe(2);
    arrive(bus, '/gamma', [{ path: 'g.js', status: 'A' }]);
    expect(panel.count()).toBe(3);
    expect(panel.onUpdate).toHaveBeenCalled();
  });

  it('a later single-repo frame fills its group in and drops the pending marker', () => {
    const { panel, bus } = streaming();
    arrive(bus, '/beta', [{ path: 'src/b1.js', status: 'M' }], { upstream: 'origin/beta', ahead: 2, behind: 0 });
    const root = render(panel);
    const header = byTestId(root, 'changes-repo-/beta');
    expect(byTestId(root, 'changes-repo-pending-/beta')).toBeNull();
    expect(header.querySelector('.changes-panel__count').textContent).toBe('1');
    expect(header.querySelector('.changes-panel__sync').textContent).toBe('↑2');
    expect(byTestId(root, 'changes-file-/beta:src/b1.js')).not.toBeNull();
    // The others are still pending.
    expect(byTestId(root, 'changes-repo-pending-/alpha')).not.toBeNull();
    expect(byTestId(root, 'changes-repo-pending-/gamma')).not.toBeNull();
    expect(groupOrder(root)).toHaveLength(3);
  });

  it('re-sorts as repos arrive: clean repos go last', () => {
    const { panel, bus } = streaming();
    arrive(bus, '/alpha', []); // clean
    expect(groupOrder(render(panel))[2]).toBe('changes-repo-/alpha');

    arrive(bus, '/gamma', [{ path: 'g.js', status: 'M' }]);
    arrive(bus, '/beta', [{ path: 'b.js', status: 'M' }]);
    const root = render(panel);
    expect(groupOrder(root)).toEqual(['changes-repo-/beta', 'changes-repo-/gamma', 'changes-repo-/alpha']);
    const alpha = byTestId(root, 'changes-repo-/alpha');
    expect(alpha.querySelector('.changes-panel__count').textContent).toBe('clean');
    expect(alpha.getAttribute('aria-expanded')).toBe('false');
    expect(allTestIds(root).some((id) => id.startsWith('changes-repo-pending-'))).toBe(false);
  });

  it('a per-repo error frame replaces the pending marker with the error', () => {
    const { panel, bus } = streaming();
    reply(bus, [repoMeta({ path: '/gamma', name: 'gamma', pending: false, files: [],
      error: { code: 'TIMEOUT', message: 'git timed out' } })], { repo: '/gamma' });
    const root = render(panel);
    expect(byTestId(root, 'changes-repo-pending-/gamma')).toBeNull();
    expect(byTestId(root, 'changes-repo-error-/gamma').textContent).toBe('git timed out');
    expect(byTestId(root, 'changes-repo-/gamma').querySelector('.changes-panel__count').textContent).toBe('!');
  });

  it('a pending group has no file rows and is not collapsed as clean', () => {
    const { panel } = streaming();
    const header = byTestId(render(panel), 'changes-repo-/alpha');
    expect(header.classList.contains('changes-panel__repo--collapsed')).toBe(false);
    expect(render(panel).querySelectorAll('.changes-panel__file')).toHaveLength(0);
  });
});

describe('ChangesPanel git:changed debounce', () => {
  beforeEach(() => jest.useFakeTimers());

  it('coalesces a burst for a known repo into one single-repo request after 300 ms', () => {
    const { bus, ws } = loaded();
    bus.emit(EVT.GIT_CHANGED, { type: 'git_changed', projectId: 'p1', repo: '/feat-login' });
    jest.advanceTimersByTime(200);
    bus.emit(EVT.GIT_CHANGED, { type: 'git_changed', projectId: 'p1', repo: '/feat-login' });
    jest.advanceTimersByTime(299);
    expect(ws.send).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(sentFrames(ws)).toEqual([
      { type: 'git_changes', projectId: 'p1', scope: 'uncommitted', repo: '/feat-login' },
    ]);
  });

  it('sends one request per distinct known repo in the window', () => {
    const { bus, ws } = loaded();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/fix-timeouts' });
    jest.advanceTimersByTime(300);
    expect(sentFrames(ws).map((f) => f.repo).sort()).toEqual(['/feat-login', '/fix-timeouts']);
  });

  it('"*" triggers a full request', () => {
    const { bus, ws } = loaded();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
    jest.advanceTimersByTime(300);
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('an unknown repo (maybe a new worktree) triggers a full request', () => {
    const { bus, ws } = loaded();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/docs-update' });
    jest.advanceTimersByTime(300);
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('a missing repo field triggers a full request', () => {
    const { bus, ws } = loaded();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1' });
    jest.advanceTimersByTime(300);
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('before any data, any change triggers a full request', () => {
    const { panel, bus, ws } = setup();
    panel.setProject('p1');
    ws.send.mockClear();
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    jest.advanceTimersByTime(300);
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('a change in another project sends nothing but makes that project refetch when shown', () => {
    const { panel, bus, ws } = setup({ projects: [{ id: 'p1' }, { id: 'p2' }] });
    panel.setProject('p2');
    reply(bus, fixtureRepos(), { projectId: 'p2' });
    panel.setProject('p1');
    reply(bus);
    ws.send.mockClear();

    bus.emit(EVT.GIT_CHANGED, { projectId: 'p2', repo: '/feat-login' });
    jest.advanceTimersByTime(300);
    expect(ws.send).not.toHaveBeenCalled();

    panel.setProject('p2'); // fresh by age, but marked stale
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p2', scope: 'uncommitted' }]);
  });

  it('switching project drops a pending refresh for the old one', () => {
    const { panel, bus, ws } = loaded({ projects: [{ id: 'p1' }, { id: 'p2' }] });
    bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    panel.setProject('p2');
    ws.send.mockClear();
    jest.advanceTimersByTime(300);
    expect(sentFrames(ws).filter((f) => f.projectId === 'p1')).toEqual([]);
  });
});

describe('ChangesPanel git_error handling', () => {
  it('NOT_A_REPO for a repo removes its group (worktree deleted)', () => {
    const { panel, bus } = loaded();
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/fix-timeouts', code: 'NOT_A_REPO', error: 'Not a git repository' });
    expect(groupOrder(render(panel))).toEqual(['changes-repo-/feat-login', 'changes-repo-/main']);
    expect(panel.count()).toBe(5);
    expect(panel.onUpdate).toHaveBeenCalled();
  });

  it('another error for a repo marks that group errored and keeps the rest', () => {
    const { panel, bus } = loaded();
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/feat-login', code: 'FAILED', error: 'fatal: bad object' });
    const root = render(panel);
    expect(byTestId(root, 'changes-repo-error-/feat-login').textContent).toBe('fatal: bad object');
    expect(byTestId(root, 'changes-repo-/feat-login').querySelector('.changes-panel__count').textContent).toBe('!');
    expect(groupOrder(root)).toHaveLength(3);
  });

  it('ignores errors carrying a path (they belong to the diff pane)', () => {
    const { panel, bus } = loaded();
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', repo: '/feat-login', path: 'routes/auth.js', code: 'NOT_A_REPO', error: 'x' });
    expect(panel.onUpdate).not.toHaveBeenCalled();
    expect(groupOrder(render(panel))).toHaveLength(3);
  });

  it('a top-level error settles the pending full request and renders it', () => {
    const { panel, bus, ws } = setup();
    panel.setProject('p1');
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', code: 'TIMEOUT', error: 'git timed out' });
    const root = render(panel);
    expect(byTestId(root, 'changes-error').textContent).toBe('git timed out');
    expect(byTestId(root, 'changes-loading')).toBeNull();
    // Settled, so a later refresh goes out.
    ws.send.mockClear();
    panel.refresh();
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('GIT_MISSING on a local project says git is missing on this machine', () => {
    const { panel, bus } = setup();
    panel.setProject('p1');
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', code: 'GIT_MISSING', error: 'spawn git ENOENT' });
    expect(byTestId(render(panel), 'changes-git-missing').textContent).toBe('Git is not installed on this machine.');
  });

  it('GIT_MISSING on a host project says git is missing on the host', () => {
    const { panel, bus } = setup({ projects: [{ id: 'p1', host: { id: 'h1', name: 'devbox' } }] });
    panel.setProject('p1');
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', code: 'GIT_MISSING', error: 'git: not found' });
    expect(byTestId(render(panel), 'changes-git-missing').textContent).toBe('Git is not installed on this host.');
  });

  it('a successful reply clears an earlier top-level error', () => {
    const { panel, bus } = setup();
    panel.setProject('p1');
    bus.emit(EVT.GIT_ERROR, { projectId: 'p1', code: 'FAILED', error: 'boom' });
    panel.refresh();
    reply(bus);
    expect(byTestId(render(panel), 'changes-error')).toBeNull();
  });
});

describe('ChangesPanel remote host reachability', () => {
  const hostProject = [{ id: 'p1', name: 'Remote', path: '/srv/p1', host: { id: 'h1', name: 'devbox' } }];

  it('sends nothing while the host is unreachable and shows the host note', () => {
    const { panel, ws } = setup({ projects: hostProject, hostStatus: 'unreachable' });
    panel.setProject('p1');
    panel.refresh();
    expect(ws.send).not.toHaveBeenCalled();
    const root = render(panel);
    expect(byTestId(root, 'changes-host-note').textContent).toBe('Host unreachable.');
    expect(byTestId(root, 'changes-loading')).toBeNull();
  });

  it('greys the last known list and disables its rows while unreachable', () => {
    const ctx = loaded({ projects: hostProject });
    ctx.hosts.status = 'unreachable';
    const root = render(ctx.panel);
    expect(byTestId(root, 'changes-host-note').textContent).toBe('Host unreachable. Showing the last known changes.');
    const list = root.querySelector('.changes-panel__list');
    expect(list.classList.contains('changes-panel__list--stale')).toBe(true);
    expect(list.getAttribute('aria-disabled')).toBe('true');
    expect(byTestId(root, 'changes-file-/feat-login:routes/auth.js').disabled).toBe(true);
  });

  it('suppresses watcher-driven requests while unreachable', () => {
    jest.useFakeTimers();
    const ctx = loaded({ projects: hostProject });
    ctx.hosts.status = 'unreachable';
    ctx.bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    ctx.bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
    jest.advanceTimersByTime(300);
    expect(ctx.ws.send).not.toHaveBeenCalled();
  });

  it('refetches on reconnect when there is no data yet', () => {
    const { panel, ws, hosts } = setup({ projects: hostProject, hostStatus: 'unreachable' });
    panel.setProject('p1');
    hosts.status = 'connected';
    panel.onHostStatus();
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('refetches on reconnect when a change arrived while unreachable', () => {
    jest.useFakeTimers();
    const ctx = loaded({ projects: hostProject });
    ctx.hosts.status = 'unreachable';
    ctx.bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/feat-login' });
    jest.advanceTimersByTime(300);
    ctx.hosts.status = 'connected';
    ctx.panel.onHostStatus();
    expect(sentFrames(ctx.ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('does not request on a status event while still unreachable', () => {
    const { panel, ws } = setup({ projects: hostProject, hostStatus: 'unreachable' });
    panel.setProject('p1');
    panel.onHostStatus();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe('ChangesPanel pending-request timeout', () => {
  it('abandons an unanswered request after 15 s so the next setProject re-sends', () => {
    jest.useFakeTimers();
    const { panel, ws } = setup();
    panel.setProject('p1');
    jest.advanceTimersByTime(14999);
    panel.setProject('p1');
    expect(ws.send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    panel.setProject('p1');
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('refetches once the list is older than 5 s', () => {
    jest.useFakeTimers();
    const { panel, ws, bus } = setup();
    panel.setProject('p1');
    reply(bus);
    jest.advanceTimersByTime(4999);
    panel.setProject('p1');
    expect(ws.send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    panel.setProject('p1');
    expect(ws.send).toHaveBeenCalledTimes(2);
  });
});

describe('ChangesPanel opening a diff', () => {
  function captureOpen(bus) {
    const opened = [];
    bus.on(EVT.GIT_OPEN_DIFF, (p) => opened.push(p));
    return opened;
  }

  it('a row click emits git:open-diff with the full payload and closes the mobile sidebar', () => {
    const { panel, bus, app } = loaded();
    const opened = captureOpen(bus);
    byTestId(render(panel), 'changes-file-/feat-login:routes/auth.js').click();
    expect(opened).toEqual([{
      projectId: 'p1', repo: '/feat-login', repoName: 'feat-login', branch: 'feat/login',
      path: 'routes/auth.js', oldPath: null, status: 'M', scope: 'uncommitted',
    }]);
    expect(app.closeSidebarOnMobile).toHaveBeenCalled();
  });

  it('carries oldPath for a rename and the short SHA as branch when detached', () => {
    const { panel, bus } = loaded();
    const opened = captureOpen(bus);
    const root = render(panel);
    byTestId(root, 'changes-file-/feat-login:public/login.css').click();
    byTestId(root, 'changes-file-/fix-timeouts:relay-client.js').click();
    expect(opened[0]).toMatchObject({ status: 'R', path: 'public/login.css', oldPath: 'public/signin.css' });
    expect(opened[1]).toMatchObject({ repo: '/fix-timeouts', branch: 'ccccccc', status: 'M' });
  });

  it('carries the current scope', () => {
    const { panel, bus } = loaded({ storage: { 'eve-changes-scope': 'base' } });
    reply(bus, fixtureRepos(), { scope: 'base' });
    const opened = captureOpen(bus);
    byTestId(render(panel), 'changes-file-/feat-login:notes.md').click();
    expect(opened[0]).toMatchObject({ scope: 'base', status: '?' });
  });

  // Keyboard: rows are real <button>s, so Enter/Space become click natively.
  it('rows are buttons, so Enter activates them without a keydown handler', () => {
    const { panel } = loaded();
    const rows = render(panel).querySelectorAll('.changes-panel__file');
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.tagName).toBe('BUTTON');
      expect(row.type).toBe('button');
    }
  });

  it('works without an app service registered', () => {
    const { panel, bus } = loaded({ withApp: false });
    const opened = captureOpen(bus);
    expect(() => byTestId(render(panel), 'changes-file-/feat-login:notes.md').click()).not.toThrow();
    expect(opened).toHaveLength(1);
  });
});

// ─── ProjectPanel: the fifth tab ────────────────────────────────────────────

function setupProjectPanel({ storage = {}, project = { id: 'p1', name: 'P1', path: '/work/p1' } } = {}) {
  const ctx = setup({ storage, projects: [project] });
  global.UI_ICONS = {
    caret: () => '<svg></svg>', refresh: () => '<svg></svg>', search: () => '<svg></svg>',
    more: () => '<svg></svg>', newFolder: () => '<svg></svg>',
  };
  const { ChangesPanel } = loadScript('sidebar/changes-panel.js', ['ChangesPanel']);
  global.ChangesPanel = ChangesPanel;
  const { ProjectPanel, PANEL_ICONS } = loadScript('sidebar/project-panel.js', ['ProjectPanel', 'PANEL_ICONS']);
  global.PANEL_ICONS = PANEL_ICONS;

  Object.assign(ctx.state, {
    getTasksForProject: () => [],
    getSessionsForProject: () => [],
    getModulesForProject: () => [],
    isTaskRun: () => false,
  });
  for (const id of ['panelTitle', 'panelHeaderActions', 'panelTabs', 'panelContent', 'panelActions', 'panelHostBar']) {
    const el = document.createElement('div');
    el.id = id;
    document.body.appendChild(el);
  }
  const pp = new ProjectPanel(ctx.container, { refreshRoot: jest.fn(), promptNewFolderAtRoot: jest.fn() });
  pp.init();
  pp.projectId = 'p1';
  return { ...ctx, pp };
}

describe('ProjectPanel Changes tab', () => {
  it('renders a fifth "Changes" tab with the panel-tab-changes testid', () => {
    const { pp } = setupProjectPanel();
    pp._renderTabs();
    const tabs = document.getElementById('panelTabs').children;
    expect(tabs.map((t) => t.dataset.testid)).toEqual([
      'panel-tab-files', 'panel-tab-sessions', 'panel-tab-tasks', 'panel-tab-modules', 'panel-tab-changes',
    ]);
    expect(tabs[4].querySelector('.panel-tab__label').textContent).toBe('Changes');
  });

  it('badges the tab with the total changed-file count once data arrives', () => {
    const { pp, bus } = setupProjectPanel();
    pp.changesPanel.setProject('p1');
    pp._renderTabs();
    const tabEl = () => byTestId(document.getElementById('panelTabs'), 'panel-tab-changes');
    expect(tabEl().querySelector('.panel-tab__count')).toBeNull();

    reply(bus); // ChangesPanel.onUpdate -> ProjectPanel re-renders the tabs
    expect(tabEl().querySelector('.panel-tab__count').textContent).toBe('6');
  });

  it('hides the badge when every repo is clean', () => {
    const { pp, bus } = setupProjectPanel();
    pp.changesPanel.setProject('p1');
    reply(bus, [repoMeta({ path: '/main', name: 'main', branch: 'main' })]);
    expect(byTestId(document.getElementById('panelTabs'), 'panel-tab-changes').querySelector('.panel-tab__count')).toBeNull();
  });

  it('clicking the tab shows the Changes panel, a refresh action, and persists the tab', () => {
    const { pp, ws } = setupProjectPanel();
    pp._renderTabs();
    byTestId(document.getElementById('panelTabs'), 'panel-tab-changes').click();
    expect(localStorage.getItem('eve-active-tab')).toBe('changes');
    expect(byTestId(document.getElementById('panelContent'), 'changes-panel')).not.toBeNull();
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);

    ws.send.mockClear();
    byTestId(document.getElementById('panelHeaderActions'), 'changes-refresh').click();
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });

  it('restores "changes" as the active tab from storage', () => {
    const { pp } = setupProjectPanel({ storage: { 'eve-active-tab': 'changes' } });
    expect(pp.activeTab).toBe('changes');
  });

  it('re-renders the list on data only while the Changes tab is active', () => {
    const { pp, bus } = setupProjectPanel({ storage: { 'eve-active-tab': 'changes' } });
    pp.changesPanel.setProject('p1');
    pp._renderContent();
    reply(bus);
    expect(byTestId(document.getElementById('panelContent'), 'changes-repo-/feat-login')).not.toBeNull();
  });

  it('a bulk host refresh (hostId null) reaches the Changes panel for a host project', () => {
    const { pp, bus, ws, hosts } = setupProjectPanel({
      project: { id: 'p1', name: 'Remote', path: '/srv/p1', host: { id: 'h1', name: 'devbox' } },
    });
    hosts.status = 'unreachable';
    pp.changesPanel.setProject('p1');
    expect(ws.send).not.toHaveBeenCalled();
    hosts.status = 'connected';
    bus.emit(EVT.HOST_STATUS, { hostId: null });
    expect(sentFrames(ws)).toEqual([{ type: 'git_changes', projectId: 'p1', scope: 'uncommitted' }]);
  });
});

// Issue #15: the watcher guesses a repo from the first path segment only, so
// a root-level repo or deep worktrees produced "unknown" repos, each of which
// forced a full rediscovery on top of the one still streaming. The panel now
// resolves a guess against the known repos, and a watcher-driven full refresh
// waits for a running one to settle (one queued follow-up at most).
describe('ChangesPanel refresh storm (#15)', () => {
  const DEBOUNCE = () => ChangesPanel.REFRESH_DEBOUNCE_MS;
  let ChangesPanel;
  beforeEach(() => {
    jest.useFakeTimers();
    ({ ChangesPanel } = setup());
  });

  const full = (projectId = 'p1') => ({ type: 'git_changes', projectId, scope: 'uncommitted' });
  const single = (repo, projectId = 'p1') => ({ ...full(projectId), repo });
  const repoAt = (p, extra = {}) => repoMeta({ path: p, name: p === '/' ? 'p1' : p.split('/').pop(), branch: 'main', ...extra });

  describe('resolveRefresh (pure)', () => {
    const resolve = (paths, known) => {
      const out = ChangesPanel.resolveRefresh(paths, known);
      return { full: out.full, repos: [...out.repos].sort() };
    };

    it('an exact match refreshes that repo', () => {
      expect(resolve(['/a'], ['/', '/a'])).toEqual({ full: false, repos: ['/a'] });
    });

    it('a path inside a known repo resolves to the longest containing repo', () => {
      expect(resolve(['/src'], ['/'])).toEqual({ full: false, repos: ['/'] });
      expect(resolve(['/a/b/c'], ['/', '/a', '/a/b'])).toEqual({ full: false, repos: ['/a/b'] });
      expect(resolve(['/b'], ['/', '/a'])).toEqual({ full: false, repos: ['/'] });
    });

    it('does not treat a sibling with a shared prefix as an ancestor', () => {
      expect(resolve(['/ab'], ['/a'])).toEqual({ full: true, repos: [] });
    });

    it('with no containing repo, refreshes the known repos that sit under the path', () => {
      expect(resolve(['/group'], ['/group/w1', '/group/w2', '/other']))
        .toEqual({ full: false, repos: ['/group/w1', '/group/w2'] });
    });

    it('falls back to full discovery when nothing matches', () => {
      expect(resolve(['/docs-update'], ['/main', '/feat-login']).full).toBe(true);
      expect(resolve(['/x'], []).full).toBe(true);
    });

    it('"*" means full discovery', () => {
      expect(ChangesPanel.resolveRefresh(['*'], ['/', '/a']).full).toBe(true);
    });

    it('deduplicates repos', () => {
      expect(resolve(['/src', '/lib', '/'], ['/'])).toEqual({ full: false, repos: ['/'] });
      expect(resolve(['/group', '/group/w1'], ['/group/w1', '/group/w2']))
        .toEqual({ full: false, repos: ['/group/w1', '/group/w2'] });
    });

    it('a mix of resolvable paths and "*" is full', () => {
      expect(ChangesPanel.resolveRefresh(['/src', '*'], ['/']).full).toBe(true);
    });
  });

  describe('watcher-driven requests', () => {
    function loadedWith(paths, opts) {
      const ctx = setup(opts);
      ctx.panel.setProject('p1');
      reply(ctx.bus, paths.map((p) => repoAt(p)));
      ctx.ws.send.mockClear();
      return ctx;
    }

    it('project root is the repo: a change under /src refreshes "/" only, no full discovery', () => {
      const { bus, ws } = loadedWith(['/']);
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/src' });
      jest.advanceTimersByTime(DEBOUNCE());
      expect(sentFrames(ws)).toEqual([single('/')]);
    });

    it('a steady stream of edits under the root repo never asks for full discovery', () => {
      const { bus, ws } = loadedWith(['/']);
      for (let i = 0; i < 5; i++) {
        bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: i % 2 ? '/src' : '/lib' });
        jest.advanceTimersByTime(DEBOUNCE());
        reply(bus, [repoAt('/')], { repo: '/' });
      }
      const frames = sentFrames(ws);
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.every((f) => f.repo === '/')).toBe(true);
    });

    it('deep worktrees: a change reported as /group refreshes each worktree under it, no full', () => {
      const { bus, ws } = loadedWith(['/group/w1', '/group/w2']);
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/group' });
      jest.advanceTimersByTime(DEBOUNCE());
      const frames = sentFrames(ws);
      expect(frames.every((f) => f.repo !== undefined)).toBe(true);
      expect(frames.map((f) => f.repo).sort()).toEqual(['/group/w1', '/group/w2']);
    });
  });

  describe('full refresh does not interrupt a running one', () => {
    const pendingRepo = (p) => repoAt(p, { pending: true, files: [] });
    const arrive = (bus, p, projectId = 'p1') =>
      reply(bus, [repoAt(p, { pending: false })], { repo: p, projectId });

    // Full request answered by a full frame; /alpha and /beta still pending.
    function streaming(opts) {
      const ctx = setup(opts);
      ctx.panel.setProject('p1');
      reply(ctx.bus, ['/alpha', '/beta'].map(pendingRepo));
      ctx.ws.send.mockClear();
      return ctx;
    }

    it('"*" while streaming sends nothing, then exactly one full request once the stream settles', () => {
      const { bus, ws } = streaming();
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
      jest.advanceTimersByTime(DEBOUNCE());
      expect(ws.send).not.toHaveBeenCalled();

      arrive(bus, '/alpha');
      expect(ws.send).not.toHaveBeenCalled(); // /beta still pending

      arrive(bus, '/beta');
      expect(sentFrames(ws)).toEqual([full()]);
    });

    it('several "*" during one stream still yield a single follow-up', () => {
      const { bus, ws } = streaming();
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
      jest.advanceTimersByTime(DEBOUNCE());
      arrive(bus, '/alpha');
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
      jest.advanceTimersByTime(DEBOUNCE());
      expect(ws.send).not.toHaveBeenCalled();

      arrive(bus, '/beta');
      expect(sentFrames(ws)).toEqual([full()]);

      // The follow-up is not repeated by later frames.
      reply(bus, ['/alpha', '/beta'].map((p) => repoAt(p)));
      expect(sentFrames(ws)).toEqual([full()]);
    });

    it('"*" while a full request is in flight waits for its reply, then sends one full request', () => {
      const { panel, bus, ws } = setup();
      panel.setProject('p1'); // full request in flight, no reply yet
      ws.send.mockClear();
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
      jest.advanceTimersByTime(DEBOUNCE());
      expect(ws.send).not.toHaveBeenCalled();

      reply(bus, [repoAt('/alpha')]);
      expect(sentFrames(ws)).toEqual([full()]);
    });

    it('an unresolvable path while streaming is queued the same way', () => {
      const { bus, ws } = streaming();
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '/new-worktree' });
      jest.advanceTimersByTime(DEBOUNCE());
      expect(ws.send).not.toHaveBeenCalled();
      arrive(bus, '/alpha');
      arrive(bus, '/beta');
      expect(sentFrames(ws)).toEqual([full()]);
    });

    it('refresh() still sends a full request immediately while streaming', () => {
      const { panel, ws } = streaming();
      panel.refresh();
      expect(sentFrames(ws)).toEqual([full()]);
    });

    it('switching project drops the queued follow-up', () => {
      const { panel, bus, ws } = streaming({ projects: [{ id: 'p1' }, { id: 'p2' }] });
      bus.emit(EVT.GIT_CHANGED, { projectId: 'p1', repo: '*' });
      jest.advanceTimersByTime(DEBOUNCE());

      panel.setProject('p2');
      expect(sentFrames(ws)).toEqual([full('p2')]);

      // p1's stream settles in the background; p2's reply lands.
      arrive(bus, '/alpha');
      arrive(bus, '/beta');
      reply(bus, [repoAt('/main')], { projectId: 'p2' });
      jest.advanceTimersByTime(DEBOUNCE());

      expect(sentFrames(ws)).toEqual([full('p2')]);
    });
  });
});
