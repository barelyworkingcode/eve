const AttachedFiles = require('../../public/core/attached-files');
const messages = require('../../ws/session-messages');

const userInput = messages.find((m) => m.type === 'user_input');
// What the server really sends to relay for one text attachment.
function serverText(text, files) {
  const relayClient = { sendMessage: jest.fn(), voiceMode: false, pendingUserMessage: null };
  userInput.handle({ ws: { send: jest.fn() }, relayClient, message: { sessionId: 's1', text, files }, log: null });
  return relayClient.sendMessage.mock.calls[0][0];
}

const fmt = (name, content) => AttachedFiles.format(name, content);

describe('AttachedFiles.parse', () => {
  test('one file: strips the block, keeps the name', () => {
    const r = AttachedFiles.parse(`what is this?${fmt('notes.txt', 'first line\n')}`);
    expect(r).toEqual({ text: 'what is this?', files: [{ name: 'notes.txt' }] });
  });

  test('two files, in order', () => {
    const r = AttachedFiles.parse(`q${fmt('a.txt', 'AAA')}${fmt('b.txt', 'BBB')}`);
    expect(r).toEqual({ text: 'q', files: [{ name: 'a.txt' }, { name: 'b.txt' }] });
  });

  test('content with a ``` run is fenced longer and still parsed', () => {
    const content = 'before\n```js\ncode\n```\nafter';
    const r = AttachedFiles.parse(`q${fmt('r.md', content)}${fmt('z.txt', 'z')}`);
    expect(r).toEqual({ text: 'q', files: [{ name: 'r.md' }, { name: 'z.txt' }] });
  });

  test('empty content', () => {
    expect(AttachedFiles.parse(`q${fmt('e.txt', '')}`)).toEqual({ text: 'q', files: [{ name: 'e.txt' }] });
  });

  test('a mention of "Attached file:" mid-text is not eaten', () => {
    const text = 'I wrote \n\nAttached file: x\n```\nnot a real block\n```\nand then kept typing';
    expect(AttachedFiles.parse(text)).toEqual({ text, files: [] });
    const plain = 'see Attached file: foo above';
    expect(AttachedFiles.parse(plain)).toEqual({ text: plain, files: [] });
  });

  test('an unclosed or malformed trailing block is left alone', () => {
    const text = 'q\n\nAttached file: a.txt\n```\nnever closed';
    expect(AttachedFiles.parse(text)).toEqual({ text, files: [] });
  });

  test('text with no attachments is returned as is', () => {
    expect(AttachedFiles.parse('hello')).toEqual({ text: 'hello', files: [] });
    expect(AttachedFiles.parse(undefined)).toEqual({ text: '', files: [] });
  });
});

describe('the server formatter and the parser agree', () => {
  test.each([
    ['plain', 'one\ntwo\n'],
    ['triple fence inside', 'a\n```\nb\n```\n'],
    ['long run inside', 'x ````` y\n'],
    ['empty', ''],
  ])('%s', (_label, content) => {
    const sent = serverText('ask', [{ name: 'f.txt', type: 'text', content }]);
    expect(AttachedFiles.parse(sent)).toEqual({ text: 'ask', files: [{ name: 'f.txt' }] });
  });
});

test('two server-sent files round-trip', () => {
  const sent = serverText('ask', [
    { name: 'a.md', type: 'text', content: '```\nx\n```' },
    { name: 'b.txt', type: 'text', content: 'y' },
  ]);
  expect(AttachedFiles.parse(sent)).toEqual({ text: 'ask', files: [{ name: 'a.md' }, { name: 'b.txt' }] });
});
