// host_status (../relay/docs/ssh-hosts.md) is eve's own file-agent
// connectivity for an SSH host; the dispatcher's only job is to hand the
// frame to StateStore — host-chip/Files-tab rendering is someone else's UI.
const MessageDispatcher = require('../../public/message-dispatcher');

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

describe('MessageDispatcher host_status', () => {
  it('forwards a host_status frame to StateStore.setHostStatus verbatim', () => {
    const { container, state } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    dispatcher.dispatch({ type: 'host_status', hostId: 'h1', name: 'devbox', status: 'connecting' });

    expect(state.setHostStatus).toHaveBeenCalledWith({
      type: 'host_status', hostId: 'h1', name: 'devbox', status: 'connecting',
    });
  });

  it('forwards an error field through when the host is unreachable', () => {
    const { container, state } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    dispatcher.dispatch({ type: 'host_status', hostId: 'h1', name: 'devbox', status: 'unreachable', error: 'timed out' });

    expect(state.setHostStatus).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'h1', status: 'unreachable', error: 'timed out' })
    );
  });
});
