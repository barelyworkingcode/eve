// A live tool step: the input streams in after the step is drawn, and the
// step's expandable detail must show it, as it does after a rejoin. Real
// MessageRenderer in the repo's fake DOM (no jsdom); the fake keeps innerHTML
// opaque, so a tiny parser here turns the renderer's markup into elements.
const { FakeElement, createDocument, fakeLocalStorage, loadScript, loadConstants } = require('./helpers/fake-dom');

const { EVT } = loadConstants();

class HtmlElement extends FakeElement {
  get parentElement() { return this.parentNode; }
  get innerHTML() { return this._html || this._text; }
  set innerHTML(v) {
    this._detachAll();
    this._text = '';
    this._html = '';
    const stack = [this];
    for (const tok of String(v).match(/<\/?[a-z][^>]*>|[^<]+/gi) || []) {
      const top = stack[stack.length - 1];
      if (tok.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (tok.startsWith('<')) {
        const m = /^<([a-z0-9]+)([^>]*)>$/i.exec(tok);
        const el = top.appendChild(new HtmlElement(m[1], this.ownerDocument));
        const cls = /class="([^"]*)"/.exec(m[2]);
        if (cls) el.className = cls[1];
        stack.push(el);
      } else if (tok.trim()) {
        const t = top.appendChild(new HtmlElement('#text', this.ownerDocument));
        t._text = tok;
      }
    }
  }
}

function makeRenderer() {
  const doc = createDocument();
  doc.createElement = (tag) => new HtmlElement(tag, doc);
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
    app: { elements: { messages }, state: { currentSessionId: 's1' } },
    bus: { emit: jest.fn(), on: jest.fn() },
  };
  return { renderer: new MessageRenderer({ get: (n) => values[n] }), messages };
}

describe('MessageRenderer.updateToolInput on a live tool step', () => {
  it('shows the finished input in the step detail', () => {
    const { renderer, messages } = makeRenderer();
    renderer.appendToolUse('call_tool', {}, 'tu1');
    expect(messages.querySelector('.tool-detail').textContent).toBe('{}');

    renderer.updateToolInput({ name: 'tides_lookup', arguments: { port: 'x' } });

    const detail = messages.querySelector('.tool-detail').textContent;
    expect(detail).toContain('tides_lookup');
    expect(detail).toBe(JSON.stringify({ name: 'tides_lookup', arguments: { port: 'x' } }, null, 2));
  });
});
