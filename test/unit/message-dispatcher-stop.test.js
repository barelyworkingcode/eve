// Stop in a web chat: the real app handleStop, dispatcher and renderer run
// against a fake DOM, and assertions read the rendered thread.
const MessageDispatcher = require('../../public/message-dispatcher');
const { FakeElement, createDocument, fakeLocalStorage, loadScript, loadConstants } = require('./helpers/fake-dom');

const { EVT } = loadConstants();

const SESSION = 's1';

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
  Object.assign(app, {
    state: { currentSessionId: SESSION, sessionHistories: new Map(), sessions: new Map() },
    elements: { messages },
    wsClient: { send: jest.fn() },
    chatForm: { showStop: jest.fn(), hideStop: jest.fn() },
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
  };
  const container = { get: (name) => values[name] };
  app.messageRenderer = new MessageRenderer(container);
  values.messageRenderer = app.messageRenderer;
  app.messageDispatcher = new MessageDispatcher(container);

  const dispatch = (frame) => app.messageDispatcher.dispatch({ sessionId: SESSION, ...frame });
  return {
    streamText: (text) => dispatch({ type: 'llm_event', event: { v: 2, type: 'assistant', delta: { type: 'text_delta', text } } }),
    stop: () => app.handleStop(),
    complete: () => dispatch({ type: 'message_complete' }),
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
