// public/remote-sessions.js is a classic-script global with a CommonJS export
// shim. The repo has no jsdom, so a minimal fake element tree stands in for
// the handful of DOM calls the section makes.
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.title = '';
    this.hidden = false;
    this._text = '';
    this._listeners = {};
    this.classList = { add: (c) => { this.className += ` ${c}`; } };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  set innerHTML(v) { this.children = []; this._text = ''; this._html = v; }
  get innerHTML() { return this._html || ''; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  click() { for (const fn of this._listeners.click || []) fn(); }
  get isConnected() { return true; }
  findAll(pred, out = []) {
    for (const c of this.children) { if (pred(c)) out.push(c); c.findAll(pred, out); }
    return out;
  }
  byClass(cls) { return this.findAll((e) => e.className.split(/\s+/).includes(cls)); }
}

global.document = { createElement: (tag) => new FakeElement(tag) };
global.EVT = { HOST_STATUS: 'host:status', TERMINAL_TEMPLATES_LOADED: 'terminal:templatesLoaded' };
const RemoteSessionsSection = require('../../public/remote-sessions');

const flush = () => new Promise((r) => setImmediate(r));

function httpError(status, body) {
  const err = new Error(body?.error || `HTTP ${status}`);
  err.status = status;
  err.body = body;
  return err;
}

function build({ list = [], getError = null } = {}) {
  const api = {
    getPersistentSessions: getError ? jest.fn().mockRejectedValue(getError) : jest.fn().mockResolvedValue(list),
    deletePersistentSession: jest.fn().mockResolvedValue({}),
  };
  const modalManager = { showConfirmModal: jest.fn() };
  const onReattach = jest.fn();
  const section = new RemoteSessionsSection({
    api,
    bus: { on: () => () => {} },
    state: {
      getProject: () => ({ id: 'p1', host: { id: 'h1', name: 'devbox' } }),
      hostStatus: () => 'connected',
      terminalTemplates: [{ id: 'shell', name: 'Shell' }],
    },
    modalManager,
    projectId: 'p1',
    onReattach,
  });
  return { section, api, modalManager, onReattach };
}

const SESSIONS = [
  { name: 'eve-p1-shell-1', template_id: 'shell', n: 1, attached: 0 },
  { name: 'eve-p1-shell-2', template_id: 'shell', n: 2, attached: 1 },
];

function rows(section) { return section.el.byClass('remote-sessions__row'); }
function button(row, label) { return row.findAll((e) => e.tagName === 'BUTTON' && e.textContent === label)[0]; }

describe('RemoteSessionsSection', () => {
  let confirmSpy;
  beforeEach(() => {
    confirmSpy = jest.fn(() => true);
    global.window = { confirm: confirmSpy };
  });
  afterEach(() => { delete global.window; });

  it('renders one row per session with template name, #n and an attached badge only when attached', async () => {
    const { section, api } = build({ list: SESSIONS });
    await section.refresh();
    expect(api.getPersistentSessions).toHaveBeenCalledWith('p1');
    const [first, second] = rows(section);
    expect(rows(section)).toHaveLength(2);
    expect(first.dataset.testid).toBe('remote-session-eve-p1-shell-1');
    expect(first.byClass('shell-launcher__resume-name')[0].textContent).toBe('Shell #1');
    expect(second.byClass('shell-launcher__resume-name')[0].textContent).toBe('Shell #2');
    expect(first.byClass('shell-launcher__resume-badge')).toHaveLength(0);
    expect(second.byClass('shell-launcher__resume-badge')[0].textContent).toBe('attached');
  });

  it('Reattach hands the session (template_id + name) to the caller for a persistSession create', async () => {
    const { section, onReattach } = build({ list: SESSIONS });
    await section.refresh();
    button(rows(section)[1], 'Reattach').click();
    expect(onReattach).toHaveBeenCalledWith(SESSIONS[1]);
  });

  it('Kill asks through the in-app confirm modal, never window.confirm, and only deletes on confirm', async () => {
    const { section, api, modalManager } = build({ list: SESSIONS });
    await section.refresh();
    button(rows(section)[0], 'Kill').click();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(modalManager.showConfirmModal).toHaveBeenCalledTimes(1);
    expect(modalManager.showConfirmModal.mock.calls[0][0]).toContain('Shell #1');
    expect(api.deletePersistentSession).not.toHaveBeenCalled();

    await modalManager.showConfirmModal.mock.calls[0][1]();
    await flush();
    expect(api.deletePersistentSession).toHaveBeenCalledWith('p1', 'eve-p1-shell-1');
    expect(api.getPersistentSessions).toHaveBeenCalledTimes(2); // re-listed after the kill
  });

  it('hides the whole section on 404 (not a host project)', async () => {
    const { section } = build({ getError: httpError(404, { error: 'not found' }) });
    await section.refresh();
    expect(section.el.hidden).toBe(true);
  });

  it("shows relay's 409 message inline, with a default when relay sends none", async () => {
    const withDetail = build({ getError: httpError(409, { error: 'tmux not installed on devbox' }) });
    await withDetail.section.refresh();
    expect(withDetail.section.el.hidden).toBe(false);
    expect(withDetail.section.el.byClass('remote-sessions__message')[0].textContent).toBe('tmux not installed on devbox');

    const bare = build({ getError: httpError(409, {}) });
    await bare.section.refresh();
    expect(bare.section.el.byClass('remote-sessions__message')[0].textContent).toBe('tmux is not available on this host.');
  });

  it('shows an unreachable message on 502 and an empty-state message for []', async () => {
    const down = build({ getError: httpError(502, { error: 'ssh: connect timed out' }) });
    await down.section.refresh();
    expect(down.section.el.byClass('remote-sessions__message')[0].textContent)
      .toBe("Couldn't reach the host: ssh: connect timed out");

    const empty = build({ list: [] });
    await empty.section.refresh();
    expect(rows(empty.section)).toHaveLength(0);
    expect(empty.section.el.byClass('remote-sessions__message')[0].textContent).toBe('No remote sessions.');
  });
});

// The New Terminal picker's onReattach calls createTerminal(template_id, dir,
// projectId, name); the WS frame must carry persistSession for the server to
// forward as persist_session (persistent-sessions-proxy.test.js).
describe('TerminalManager.createTerminal persistSession', () => {
  const TerminalManager = require('../../public/terminal-manager');
  const send = jest.fn();
  const self = { app: { wsClient: { send } } };
  beforeEach(() => send.mockClear());

  it('adds persistSession to the terminal_create frame when reattaching', () => {
    TerminalManager.prototype.createTerminal.call(self, 'shell', '/w', 'p1', 'eve-p1-shell-2');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'terminal_create', templateId: 'shell', projectId: 'p1', persistSession: 'eve-p1-shell-2',
    }));
  });

  it('leaves persistSession off a fresh create', () => {
    TerminalManager.prototype.createTerminal.call(self, 'shell', '/w', 'p1');
    expect(send.mock.calls[0][0]).not.toHaveProperty('persistSession');
  });
});
