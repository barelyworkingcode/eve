// #166 pasted-URL chips: the paste rule, the chip label, the server's URL
// boundary, and the sources block that carries URLs inside message text.
const SourceUrls = require('../../public/core/source-urls');
const AttachedFiles = require('../../public/core/attached-files');
const messages = require('../../ws/session-messages');

// The contract's W2 block, written out by hand.
const BLOCK_HEAD = '\n\nSources to read (fetch each one before you answer, and cite it with a markdown link to its URL):\n';
const atLen = (n) => { const head = 'https://acme.example/'; return head + 'a'.repeat(n - head.length); };

describe('SourceUrls.fromPaste', () => {
  it.each([
    ['https://acme.example/docs', 'https://acme.example/docs'],
    ['  https://acme.example/docs?q=1#top\n', 'https://acme.example/docs?q=1#top'],
    ['http://Acme.Example', 'http://acme.example/'],
    [atLen(2048), atLen(2048)],
  ])('%j -> %j', (text, href) => {
    expect(SourceUrls.fromPaste(text)).toBe(href);
  });

  it.each([
    ['text around the URL', 'see https://acme.example/x'],
    ['whitespace inside', 'https://acme.example/a b'],
    ['two URLs', 'https://acme.example/a https://acme.example/b'],
    ['two URLs on two lines', 'https://acme.example/a\nhttps://acme.example/b'],
    ['javascript:', 'javascript:alert(1)'],
    ['ftp:', 'ftp://files.example/a'],
    ['mailto:', 'mailto:a@acme.example'],
    ['no host', 'https://'],
    ['not a URL', 'acme.example/docs'],
    ['over 2,048 characters', atLen(2049)],
    ['empty', ''],
    ['whitespace only', '  \n '],
    ['not a string', null],
  ])('%s -> null', (_what, text) => {
    expect(SourceUrls.fromPaste(text)).toBeNull();
  });
});

describe('SourceUrls.label', () => {
  it.each([
    ['https://www.acme.example/docs/guide/?q=1#top', 'acme.example/docs/guide'],
    ['http://acme.example/', 'acme.example'],
    ['https://docs.example/release/2.0', 'docs.example/release/2.0'],
    [`https://acme.example/${'p'.repeat(47)}`, `acme.example/${'p'.repeat(47)}`], // exactly 60
    [`https://acme.example/${'p'.repeat(48)}`, `acme.example/${'p'.repeat(46)}…`], // 61 -> 59 + …
  ])('%s -> %s', (href, label) => {
    expect(SourceUrls.label(href)).toBe(label);
  });
});

describe('SourceUrls.accept', () => {
  it.each([[undefined], [null], ['https://acme.example/a'], [{ 0: 'https://acme.example/a' }]])(
    'a non-array (%j) -> []', (urls) => {
      expect(SourceUrls.accept(urls)).toEqual([]);
    });

  it('keeps valid URLs as hrefs in order and drops junk', () => {
    expect(SourceUrls.accept([
      7, null, 'javascript:alert(1)', 'ftp://files.example/a', 'https://acme.example/a b', atLen(2049),
      ' https://Acme.example/one ', 'http://widgets.example',
    ])).toEqual(['https://acme.example/one', 'http://widgets.example/']);
  });

  it('dedupes by href and keeps the first five; junk and duplicates do not count toward five', () => {
    const u = (i) => `https://acme.example/${i}`;
    expect(SourceUrls.accept(['junk', u(1), 'https://ACME.example/1', u(2), u(3), u(2), u(4), u(5), u(6), u(7)]))
      .toEqual([u(1), u(2), u(3), u(4), u(5)]);
  });
});

describe('SourceUrls.format and parse', () => {
  const U1 = 'https://docs.example/release/2.0';
  const U2 = 'https://acme.example/notes?id=4';

  it('format: [] -> "", else the W2 block with one "- url" line each, in order', () => {
    expect(SourceUrls.format([])).toBe('');
    expect(SourceUrls.format([U1, U2])).toBe(`${BLOCK_HEAD}- ${U1}\n- ${U2}`);
  });

  it('parse is the inverse of format', () => {
    expect(SourceUrls.parse(`What changed?${SourceUrls.format([U1, U2])}`)).toEqual({ text: 'What changed?', urls: [U1, U2] });
  });

  it.each([
    ['no block', 'just a question'],
    ['a block mid-text', `I typed${BLOCK_HEAD}- ${U1}\nand kept typing`],
  ])('%s is left alone', (_what, text) => {
    expect(SourceUrls.parse(text)).toEqual({ text, urls: [] });
  });

  it('reads back what the server wrote with a text file, after AttachedFiles.parse', () => {
    const relayClient = { sendMessage: jest.fn(), voiceMode: false, pendingUserMessage: null };
    messages.find((m) => m.type === 'user_input').handle({
      ws: { send: jest.fn() }, relayClient, log: null,
      message: { sessionId: 's1', text: 'What changed?', urls: [U1, U2], files: [{ name: 'notes.txt', type: 'text', content: 'AAA' }] },
    });
    const files = AttachedFiles.parse(relayClient.sendMessage.mock.calls[0][0]);
    expect(files.files).toEqual([{ name: 'notes.txt' }]);
    expect(SourceUrls.parse(files.text)).toEqual({ text: 'What changed?', urls: [U1, U2] });
  });
});
