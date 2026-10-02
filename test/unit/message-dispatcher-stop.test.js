// Stop in a web chat: the real app handleStop, dispatcher and renderer run
// against a fake DOM, and assertions read the rendered thread.
const MessageDispatcher = require('../../public/message-dispatcher');
const { FakeElement, createDocument, fakeLocalStorage, loadScript, loadConstants } = require('./helpers/fake-dom');

const { EVT } = loadConstants();

const SESSION = 's1';
const OTHER_SESSION = 's2';

// fake-dom keeps innerHTML as an opaque string. The renderer builds each
// message as `<div class="message-content">…</div>` and reads that child
// back, and escapes text via textContent-in/innerHTML-out.
class HtmlElement extends FakeElement {
  get parentElement() { return this.parentNode; }
  get innerHTML() { return this._html || this._text; }
  set innerHTML(v) {
    this._detachAll();
    this._text = '';
    const m = /^<div class="([^"]+)">([\s\S]*)<\/div>$/.exec(String(v));
    if (!m) { this._html = String(v); return; }
    this._html = '';
    const child = this.appendChild(new HtmlElement('div', this.ownerDocument));
    child.className = m[1];
    child.innerHTML = m[2];
  }
}

function makeChat() {
  const doc = createDocument();
  doc.createElement = (tag) => new HtmlElement(tag, doc);
  // A text node is an element that only carries text.
  doc.createTextNode = (text) => { const n = new HtmlElement('#text', doc); n.textContent = text; return n; };
  const Sources = require('../../public/core/sources');
  const { Citations } = loadScript('citations.js', ['Citations'], { document: doc, window: {}, Sources });
  const { MessageRenderer } = loadScript('message-renderer.js', ['MessageRenderer'], {
    document: doc,
    Citations,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (h) => clearTimeout(h),
    sessionStorage: fakeLocalStorage(),
    UI_ICONS: { speaker: () => '' },
    EVT,
    AttachedFiles: require('../../public/core/attached-files'),
  });
  const { EveWorkspaceClient } = loadScript('app.js', ['EveWorkspaceClient'], { window: {}, document: doc });

  const messages = doc.createElement('div');
  const app = Object.create(EveWorkspaceClient.prototype);
  const sessions = new Map([SESSION, OTHER_SESSION].map((id) => [id, { id }]));
  Object.assign(app, {
    state: { currentSessionId: SESSION, sessionHistories: new Map(), sessions },
    elements: {
      messages,
      userInput: doc.createElement('textarea'),
      welcomeScreen: doc.createElement('div'),
      chatScreen: doc.createElement('div'),
    },
    wsClient: { send: jest.fn() },
    chatForm: { showStop: jest.fn(), hideStop: jest.fn(), setSubmitEnabled: jest.fn() },
  });
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const values = {
    logger: { child: () => log },
    app,
    bus: { emit: jest.fn(), on: jest.fn() },
    state: app.state,
    ws: app.wsClient,
    voiceChatManager: null,
    ttsManager: null,
    tabManager: { getSessionMeta: () => null, openSession: jest.fn() },
    sidebarRenderer: { renderProjectList: jest.fn() },
    modalManager: { hidePlanApproval: jest.fn() },
  };
  const container = { get: (name) => values[name] };
  app.messageRenderer = new MessageRenderer(container);
  values.messageRenderer = app.messageRenderer;
  app.messageDispatcher = new MessageDispatcher(container);

  const dispatch = (frame) => app.messageDispatcher.dispatch({ sessionId: SESSION, ...frame });
  return {
    streamText: (text) => dispatch({ type: 'llm_event', event: { v: 2, type: 'assistant', delta: { type: 'text_delta', text } } }),
    stop: () => app.handleStop(),
    complete: (sessionId = SESSION) => dispatch({ type: 'message_complete', sessionId }),
    error: (message) => dispatch({ type: 'error', message }),
    connectionError: (message) => dispatch({ type: 'error', sessionId: undefined, message }),
    submitLocally: () => app.messageDispatcher.markLocalSubmit(SESSION),
    userMessage: (text) => dispatch({ type: 'user_message', text }),
    join: (sessionId) => dispatch({ type: 'session_joined', sessionId, history: [] }),
    history: (sessionId) => JSON.stringify(app.state.sessionHistories.get(sessionId) || []),
    threadText: () => messages.querySelectorAll('.message-content').map((el) => el.innerHTML).join('\n'),
    errors: () => messages.querySelectorAll('.error').map((el) => el.querySelector('.message-content').innerHTML),
  };
}

describe('MessageDispatcher: a turn the user stopped', () => {
  it('keeps the streamed reply and adds no "No response from model" error', () => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');

    chat.stop();
    chat.complete();

    expect(chat.threadText()).toContain('Counting: 1, 2, 3');
    expect(chat.errors()).toEqual([]);
  });

  it('adds no "No response from model" error when Stop came before any text', () => {
    const chat = makeChat();

    chat.stop();
    chat.complete();

    expect(chat.errors()).toEqual([]);
  });

  it('draws the next turn once the stopped turn has completed', () => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');
    chat.stop();
    chat.complete();

    chat.submitLocally();
    chat.userMessage('And now?');
    chat.streamText('Next turn reply');
    chat.complete();

    expect(chat.threadText()).toContain('Next turn reply');
  });

  it('keeps the stop when its own user_message echo arrives after Stop, then draws the next turn', () => {
    const chat = makeChat();
    chat.submitLocally();
    chat.stop();
    chat.userMessage('Count to 100');
    chat.complete();

    expect(chat.errors()).toEqual([]);

    chat.submitLocally();
    chat.userMessage('And now?');
    chat.streamText('Next turn reply');
    chat.complete();

    expect(chat.threadText()).toContain('Next turn reply');
    expect(chat.errors()).toEqual([]);
  });

  it('does not draw text chunks that arrive after Stop', () => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');

    chat.stop();
    chat.streamText(', 4, 5, LATE');
    chat.complete();

    expect(chat.threadText()).not.toContain('LATE');
    expect(chat.threadText()).toContain('Counting: 1, 2, 3');
    expect(chat.errors()).toEqual([]);
  });

  it('draws no text and adds no error for chunks and a second complete after the synthetic complete', () => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');
    chat.stop();
    chat.complete();

    chat.streamText(', 4, 5, LATE');
    chat.complete();

    expect(chat.threadText()).not.toContain('LATE');
    expect(chat.threadText()).toContain('Counting: 1, 2, 3');
    expect(chat.errors()).toEqual([]);
  });
});

describe('MessageDispatcher: a stopped turn while its session is in the background', () => {
  it("keeps late text out of the session's history when the turn's own echo arrives after Stop", () => {
    const chat = makeChat();
    chat.submitLocally();
    chat.streamText('Counting: 1, 2, 3');
    chat.stop();
    chat.join(OTHER_SESSION);

    chat.userMessage('Count to 100');
    chat.streamText(', 4, 5, LATE');
    chat.complete(SESSION);

    expect(chat.history(SESSION)).not.toContain('LATE');
  });

  it("records another viewer's next turn in the session's history", () => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');
    chat.stop();
    chat.join(OTHER_SESSION);

    chat.userMessage('And now?');
    chat.streamText('Next turn reply');
    chat.complete(SESSION);

    expect(chat.history(SESSION)).toContain('Next turn reply');
  });
});

describe('MessageDispatcher: a turn with no content and no Stop', () => {
  it('reports "No response from model"', () => {
    const chat = makeChat();

    chat.complete();

    expect(chat.errors()).toEqual(['No response from model']);
  });
});

describe('MessageDispatcher: the turn after a Stop that relay never completes', () => {
  function newTurn(chat, text) {
    chat.userMessage('And now?');
    chat.streamText(text);
    chat.complete();
  }

  it.each([
    ['sent from another viewer', () => {}],
    ['sent from this browser', (chat) => chat.submitLocally()],
  ])('draws the next reply when its user_message was %s', (_label, beforeUserMessage) => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');
    chat.stop();

    beforeUserMessage(chat);
    newTurn(chat, 'Next turn reply');

    expect(chat.threadText()).toContain('Next turn reply');
  });
});

describe("MessageDispatcher: another viewer's turn after a Stop whose own Send never echoed", () => {
  it.each([
    ['relay refused the Send', (chat) => { chat.connectionError('Session is busy'); chat.complete(); }],
    ['the socket closed and the browser rejoined', (chat) => chat.join(SESSION)],
  ])('draws the reply when %s', (_label, afterStop) => {
    const chat = makeChat();
    chat.userMessage('Count to 100');
    chat.streamText('Counting: 1, 2, 3');
    chat.submitLocally();
    chat.stop();
    afterStop(chat);

    chat.userMessage('And now?');
    chat.streamText('Next turn reply');
    chat.complete();

    expect(chat.threadText()).toContain('Next turn reply');
  });
});
