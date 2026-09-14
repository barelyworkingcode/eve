// terminal_request (server-initiated, from slash-command-handler.js) must
// carry the project id through to TerminalManager.createTerminal — an empty
// projectId here is what silently launches rh with no RELAY_PROJECT_TOKEN.
const MessageDispatcher = require('../../public/message-dispatcher');

function makeContainer() {
  const terminalManager = { createTerminal: jest.fn() };
  const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };
  const values = {
    logger,
    messageRenderer: {},
    modalManager: {},
    tabManager: {},
    sidebarRenderer: {},
    terminalManager,
    fileBrowser: {},
    ttsManager: {},
    sttManager: {},
    voiceChatManager: {},
    taskManager: {},
    permissions: {},
    state: {},
    ws: { send: jest.fn() },
    bus: { emit: jest.fn(), on: jest.fn() },
    app: {},
  };
  return { container: { get: (name) => values[name] }, terminalManager };
}

describe('MessageDispatcher terminal_request', () => {
  it('forwards the projectId carried on the frame to createTerminal', () => {
    const { container, terminalManager } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    dispatcher.dispatch({ type: 'terminal_request', command: 'rh', directory: '/work/proj', projectId: 'proj-1' });

    expect(terminalManager.createTerminal).toHaveBeenCalledWith('rh', '/work/proj', 'proj-1');
  });

  it('falls back to an empty projectId when the frame carries none', () => {
    const { container, terminalManager } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    dispatcher.dispatch({ type: 'terminal_request', command: 'shell', directory: '/work/proj' });

    expect(terminalManager.createTerminal).toHaveBeenCalledWith('shell', '/work/proj', '');
  });
});
