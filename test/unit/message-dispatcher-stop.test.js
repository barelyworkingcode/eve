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
  const { MessageRenderer } = loadScript('message-renderer.js', ['MessageRenderer'], {
    document: doc,
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    cancelAnimationFrame: (h) => clearTimeout(h),
    sessionStorage: fakeLocalStorage(),
    UI_ICONS: { speaker: () => '' },
    EVT,
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
    submitLocally: () => app.messageDispatcher.markLocalSubmit(SESSION),
    userMessage: (text) => dispatch({ type: 'user_message', text }),
    join: (sessionId) => dispatch({ type: 'session_joined', sessionId, history: [] }),
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

    chat.streamText('Next turn reply');
    chat.complete();

    expect(chat.threadText()).toContain('Next turn reply');
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

  it('draws the next reply after an error ends the stopped turn', () => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');
    chat.stop();
    chat.error('Provider failed');

    newTurn(chat, 'Next turn reply');

    expect(chat.threadText()).toContain('Next turn reply');
    expect(chat.errors()).not.toContain('No response from model');
  });

  it('draws the next reply after the stopped turn completed while another session was open', () => {
    const chat = makeChat();
    chat.streamText('Counting: 1, 2, 3');
    chat.stop();

    chat.join(OTHER_SESSION);
    chat.complete(SESSION);
    chat.join(SESSION);
    newTurn(chat, 'Next turn reply');

    expect(chat.threadText()).toContain('Next turn reply');
  });
});
