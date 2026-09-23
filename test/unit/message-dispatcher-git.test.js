// The four inbound git_* frames (docs/design-git-changes.md, "Client bus
// events") are re-emitted verbatim on the EventBus under pinned names; the
// Changes panel and diff pane only ever listen on the bus.
const { loadConstants } = require('./helpers/fake-dom');
const MessageDispatcher = require('../../public/message-dispatcher');

const { EVT } = loadConstants();

function makeDispatcher() {
  global.EVT = EVT;
  const bus = { emit: jest.fn(), on: jest.fn() };
  const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
  const values = {
    logger,
    messageRenderer: {},
    modalManager: {},
    tabManager: {},
    sidebarRenderer: {},
    terminalManager: {},
    fileBrowser: {},
    ttsManager: {},
    sttManager: {},
    voiceChatManager: {},
    taskManager: {},
    permissions: {},
    state: {},
    ws: { send: jest.fn() },
    bus,
    app: {},
  };
  return { dispatcher: new MessageDispatcher({ get: (name) => values[name] }), bus };
}

describe('EVT git names', () => {
  it('pins the bus event names from the design contract', () => {
    expect(EVT.GIT_CHANGES).toBe('git:changes');
    expect(EVT.GIT_FILE_VERSIONS).toBe('git:file-versions');
    expect(EVT.GIT_ERROR).toBe('git:error');
    expect(EVT.GIT_CHANGED).toBe('git:changed');
    expect(EVT.GIT_OPEN_DIFF).toBe('git:open-diff');
  });
});

describe('MessageDispatcher git_* frames', () => {
  const cases = [
    ['git_changes', 'git:changes', {
      type: 'git_changes', projectId: 'p1', scope: 'uncommitted',
      repos: [{ path: '/main', name: 'main', branch: 'main', files: [] }],
    }],
    ['git_file_versions', 'git:file-versions', {
      type: 'git_file_versions', projectId: 'p1', repo: '/feat-login', path: 'routes/auth.js', scope: 'uncommitted',
      original: 'a', modified: 'b', binary: false, tooLarge: false, originalSize: 1, modifiedSize: 1,
    }],
    ['git_error', 'git:error', {
      type: 'git_error', projectId: 'p1', repo: '/feat-login', code: 'NOT_A_REPO', error: 'Not a git repository',
    }],
    ['git_changed', 'git:changed', { type: 'git_changed', projectId: 'p1', repo: '/fix-timeouts' }],
  ];

  it.each(cases)('%s is re-emitted on %s with the frame as payload', (_type, event, frame) => {
    const { dispatcher, bus } = makeDispatcher();
    dispatcher.dispatch(frame);
    expect(bus.emit).toHaveBeenCalledTimes(1);
    expect(bus.emit).toHaveBeenCalledWith(event, frame);
  });
});
