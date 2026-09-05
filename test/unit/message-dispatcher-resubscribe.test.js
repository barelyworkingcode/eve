// Regression coverage for the relay-reconnect tab-yank bug: resubscribeAfterReconnect
// (public/app.js) re-joins every open session tab after an upstream relay reconnect,
// and the user never dropped their own browser socket — they may be looking at (and
// typing into) a session other than whichever one's join reply lands first/last.
// handleSessionJoined must not switch the active tab or clear/re-render a background
// pane for one of these resubscribe joins; only a repaint-in-place of the tab already
// on screen is allowed, and only a genuine (non-resubscribe) join may steal focus.
const MessageDispatcher = require('../../public/message-dispatcher');

function makeContainer() {
  const state = {
    sessions: new Map(),
    sessionHistories: new Map(),
    taskRunIds: new Set(),
    currentSessionId: null,
    addSession(session) { this.sessions.set(session.id, session); },
  };
  const tabManager = {
    getSessionMeta: () => null,
    openSession: jest.fn(),
    tabs: [],
  };
  const renderer = {
    clearMessages: jest.fn(),
    appendSystemMessage: jest.fn(),
  };
  const app = {
    renderMessages: jest.fn(),
    showChatScreen: jest.fn(),
    updateStats: jest.fn(),
    enableVoiceMode: jest.fn(),
  };
  const sidebar = { renderProjectList: jest.fn() };
  const modalManager = { hidePlanApproval: jest.fn(), showPermissionModal: jest.fn(), hideSessionModal: jest.fn() };
  const bus = { emit: jest.fn(), on: jest.fn() };
  const logger = { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) };

  const values = {
    logger,
    messageRenderer: renderer,
    modalManager,
    tabManager,
    sidebarRenderer: sidebar,
    terminalManager: {},
    fileBrowser: {},
    ttsManager: {},
    sttManager: {},
    voiceChatManager: {},
    taskManager: {},
    permissions: {},
    state,
    ws: { send: jest.fn() },
    bus,
    app,
  };

  return {
    container: { get: (name) => values[name] },
    state,
    tabManager,
    renderer,
    app,
    sidebar,
    modalManager,
  };
}

describe('MessageDispatcher resubscribe joins (upstream relay reconnect must not yank the active tab)', () => {
  it('leaves the active session untouched when a background tab gets a resubscribe join', () => {
    const { container, state, tabManager, renderer, app } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    state.currentSessionId = 'B';
    state.sessions.set('A', { id: 'A' });
    state.sessions.set('B', { id: 'B' });

    dispatcher.markResubscribeJoin('A');
    dispatcher.handleSessionJoined({ sessionId: 'A', directory: '/a', history: [{ role: 'user', content: 'hi' }] });

    expect(state.currentSessionId).toBe('B');
    expect(tabManager.openSession).not.toHaveBeenCalled();
    expect(renderer.clearMessages).not.toHaveBeenCalled();
    expect(app.showChatScreen).not.toHaveBeenCalled();
    expect(app.renderMessages).not.toHaveBeenCalled();
    // The reply still has to update state so the pane is correct whenever the
    // user does switch to it.
    expect(state.sessionHistories.get('A')).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('repaints the active tab in place (no tab switch) when its own resubscribe join lands', () => {
    const { container, state, tabManager, renderer, app } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    state.currentSessionId = 'B';
    state.sessions.set('B', { id: 'B' });

    dispatcher.markResubscribeJoin('B');
    dispatcher.handleSessionJoined({ sessionId: 'B', directory: '/b', history: [] });

    expect(state.currentSessionId).toBe('B');
    expect(tabManager.openSession).not.toHaveBeenCalled();
    expect(renderer.clearMessages).not.toHaveBeenCalled();
    expect(app.renderMessages).toHaveBeenCalledTimes(1);
  });

  it('a genuine (non-resubscribe) join still switches the active tab as before', () => {
    const { container, state, tabManager, renderer, app } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    state.currentSessionId = 'B';
    state.sessions.set('A', { id: 'A' });

    dispatcher.handleSessionJoined({ sessionId: 'A', directory: '/a', history: [] });

    expect(state.currentSessionId).toBe('A');
    expect(tabManager.openSession).toHaveBeenCalledWith('A');
    expect(renderer.clearMessages).toHaveBeenCalledTimes(1);
    expect(app.renderMessages).toHaveBeenCalledTimes(1);
  });

  it('clearResubscribeJoin lets a later genuine join of the same id behave normally', () => {
    const { container, state, tabManager } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    state.currentSessionId = 'B';
    state.sessions.set('A', { id: 'A' });

    dispatcher.markResubscribeJoin('A');
    dispatcher.clearResubscribeJoin('A');
    dispatcher.handleSessionJoined({ sessionId: 'A', directory: '/a', history: [] });

    expect(state.currentSessionId).toBe('A');
    expect(tabManager.openSession).toHaveBeenCalledWith('A');
  });

  it('treats a resubscribe mark older than the TTL as stale, so a late reply cannot swallow a genuine join', () => {
    jest.useFakeTimers();
    const { container, state, tabManager } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    state.currentSessionId = 'B';
    state.sessions.set('A', { id: 'A' });

    dispatcher.markResubscribeJoin('A');
    jest.advanceTimersByTime(20000);
    dispatcher.handleSessionJoined({ sessionId: 'A', directory: '/a', history: [] });

    expect(state.currentSessionId).toBe('A');
    expect(tabManager.openSession).toHaveBeenCalledWith('A');
  });

  it('consumes the mark exactly once, so a second reply for the same id is never mistaken for a resubscribe', () => {
    const { container, state, tabManager } = makeContainer();
    const dispatcher = new MessageDispatcher(container);

    state.currentSessionId = 'B';
    state.sessions.set('A', { id: 'A' });

    dispatcher.markResubscribeJoin('A');
    dispatcher.handleSessionJoined({ sessionId: 'A', directory: '/a', history: [] }); // consumed as resubscribe
    dispatcher.handleSessionJoined({ sessionId: 'A', directory: '/a', history: [] }); // now a genuine join

    expect(state.currentSessionId).toBe('A');
    expect(tabManager.openSession).toHaveBeenCalledWith('A');
  });
});
