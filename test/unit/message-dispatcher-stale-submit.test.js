// A local Send is drawn optimistically, and the dispatcher skips the matching
// user_message echo. A Send that never echoes (refused while the session is
// busy, or lost on a closed socket) must not make the dispatcher swallow a
// later user_message that another viewer sent to the same session.
const MessageDispatcher = require('../../public/message-dispatcher');

function makeContainer() {
  const state = {
    sessions: new Map(),
    sessionHistories: new Map(),
    taskRunIds: new Set(),
    currentSessionId: null,
    addSession(session) { this.sessions.set(session.id, session); },
  };
  const renderer = {
    appendUserMessage: jest.fn(),
    appendSystemMessage: jest.fn(),
    showThinkingIndicator: jest.fn(),
    hideThinkingIndicator: jest.fn(),
    clearMessages: jest.fn(),
  };
  const app = {
    showStopButton: jest.fn(),
    hideStopButton: jest.fn(),
    clearSessionStarting: jest.fn(),
    renderMessages: jest.fn(),
    showChatScreen: jest.fn(),
    updateStats: jest.fn(),
    enableVoiceMode: jest.fn(),
  };
  const values = {
    logger: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    messageRenderer: renderer,
    modalManager: { hidePlanApproval: jest.fn() },
    tabManager: { getSessionMeta: () => null, openSession: jest.fn(), tabs: [] },
    sidebarRenderer: { renderProjectList: jest.fn() },
    terminalManager: {},
    fileBrowser: {},
    ttsManager: {},
    sttManager: {},
    voiceChatManager: { handleError: jest.fn() },
    taskManager: {},
    permissions: {},
    state,
    ws: { send: jest.fn() },
    bus: { emit: jest.fn(), on: jest.fn() },
    app,
  };
  return { container: { get: (name) => values[name] }, state, renderer };
}

describe('MessageDispatcher local submit that never echoes', () => {
  it.each([
    ['relay refuses the Send while the session is busy', (d) => {
      d.dispatch({ type: 'error', message: 'session: already processing a message' });
    }],
    ['the Send is lost on a closed socket and the browser rejoins', (d) => {
      d.dispatch({ type: 'session_joined', sessionId: 'S', directory: '/p1', history: [] });
    }],
    ['relay reports an error for the session', (d) => {
      d.dispatch({ type: 'error', sessionId: 'S', message: 'turn failed' });
    }],
  ])('draws another viewer\'s next message when %s', (_label, afterLostSend) => {
    const { container, state, renderer } = makeContainer();
    const dispatcher = new MessageDispatcher(container);
    state.currentSessionId = 'S';
    state.sessions.set('S', { id: 'S' });

    dispatcher.markLocalSubmit('S');
    afterLostSend(dispatcher);
    expect(state.currentSessionId).toBe('S');

    dispatcher.dispatch({ type: 'user_message', sessionId: 'S', text: 'And now?' });

    expect(renderer.appendUserMessage).toHaveBeenCalledWith('And now?');
  });

  it('still skips its own echo after an error for another session', () => {
    const { container, state, renderer } = makeContainer();
    const dispatcher = new MessageDispatcher(container);
    state.currentSessionId = 'S';
    state.sessions.set('S', { id: 'S' });

    dispatcher.markLocalSubmit('S');
    dispatcher.dispatch({ type: 'error', sessionId: 'T', message: 'turn failed' });
    dispatcher.dispatch({ type: 'user_message', sessionId: 'S', text: 'My question' });

    expect(renderer.appendUserMessage).not.toHaveBeenCalled();
  });
});
