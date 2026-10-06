// The "Sent by Chief of Staff" chip: real MessageRenderer in the repo's fake DOM.
const { FakeElement, createDocument, fakeLocalStorage, loadScript, loadConstants } = require('./helpers/fake-dom');

const { EVT } = loadConstants();

// The fake keeps innerHTML opaque; the renderer's markup is not under test here.
class HtmlElement extends FakeElement {
  get parentElement() { return this.parentNode; }
  get innerHTML() { return this._html || this._text; }
  set innerHTML(v) { this._detachAll(); this._text = String(v); this._html = ''; }
}

function makeRenderer() {
  const doc = createDocument();
  doc.createElement = (tag) => new HtmlElement(tag, doc);
  doc.createTextNode = (t) => { const el = new HtmlElement('#text', doc); el._text = String(t); return el; };
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
    SourceUrls: require('../../public/core/source-urls'),
  });
  const messages = doc.createElement('div');
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const values = {
    logger: { child: () => log },
    app: { elements: { messages }, state: { currentSessionId: 's1', sessionHistories: new Map() } },
    bus: { emit: jest.fn(), on: jest.fn() },
  };
  return { renderer: new MessageRenderer({ get: (n) => values[n] }), messages };
}

const chips = (root) => root.querySelectorAll('[data-testid]').filter((el) => el.dataset.testid === 'message-origin-chip');

describe('message origin chip', () => {
  it('shows on a live user message only for origin chief-of-staff', () => {
    const { renderer, messages } = makeRenderer();
    renderer.appendUserMessage('plain');
    renderer.appendUserMessage('also plain', [], [], {});
    renderer.appendUserMessage('spoofed', [], [], { origin: 'someone-else' });
    expect(chips(messages)).toHaveLength(0);

    renderer.appendUserMessage('merge after CI', [], [], { origin: 'chief-of-staff' });
    expect(chips(messages)).toHaveLength(1);
    expect(chips(messages)[0].textContent).toBe('Sent by Chief of Staff');
  });

  it('shows on the replayed history message that carries the origin, and no other', () => {
    const { renderer, messages } = makeRenderer();
    renderer.renderHistory([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'from the board', origin: 'chief-of-staff' },
      { role: 'user', content: 'last' },
    ]);
    expect(chips(messages)).toHaveLength(1);
    const users = messages.querySelectorAll('[data-testid]').filter((el) => el.dataset.testid === 'message-user');
    expect(users).toHaveLength(3);
    expect(chips(users[1])).toHaveLength(1);
  });
});
