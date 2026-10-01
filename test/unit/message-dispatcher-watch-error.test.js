// watch_error: the server's file watcher could not start or died; the client
// must say so, since the tree and open files silently stop updating.
const { loadConstants } = require('./helpers/fake-dom');
const MessageDispatcher = require('../../public/message-dispatcher');

const { EVT } = loadConstants();

function makeContainer() {
  const state = { setHostStatus: jest.fn() };
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
    state,
    ws: { send: jest.fn() },
    bus: { emit: jest.fn(), on: jest.fn() },
    app: {},
  };
  return { container: { get: (name) => values[name] }, state };
}

describe('MessageDispatcher watch_error', () => {
  it('raises a warning toast naming the reason, keyed per project', () => {
    global.EVT = EVT;
    const { container } = makeContainer();
    const bus = container.get('bus');
    const dispatcher = new MessageDispatcher(container);

    dispatcher.dispatch({ type: 'watch_error', projectId: 'p1', reason: 'ENOSPC' });

    expect(bus.emit).toHaveBeenCalledWith(EVT.TOAST_SHOW, expect.objectContaining({
      id: 'watch-error-p1',
      type: 'warning',
      message: expect.stringContaining('ENOSPC'),
    }));
  });
});
