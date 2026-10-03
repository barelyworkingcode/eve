const messages = require('../../ws/session-messages');

const userInput = messages.find((m) => m.type === 'user_input');

function run(message, relayOverrides = {}) {
  const relayClient = { sendMessage: jest.fn(), voiceMode: false, pendingUserMessage: null, ...relayOverrides };
  userInput.handle({ ws: { send: jest.fn() }, relayClient, message: { sessionId: 's1', ...message }, log: null });
  return relayClient;
}

describe('user_input attachments', () => {
  it('inlines a text file after the text and sends no file for it', () => {
    const rc = run({ text: 'what is this?', files: [{ name: 'notes.txt', type: 'text', mediaType: 'text/plain', content: 'first line\n' }] });
    const [text, files] = rc.sendMessage.mock.calls[0];
    expect(text).toBe('what is this?\n\nAttached file: notes.txt\n```\nfirst line\n\n```');
    expect(files).toEqual([]);
  });

  it('still passes an image through as { name, mimeType, data }', () => {
    const rc = run({ text: 'look', files: [{ name: 'p.png', type: 'image', mediaType: 'image/png', content: 'data:image/png;base64,QUJD' }] });
    const [text, files] = rc.sendMessage.mock.calls[0];
    expect(text).toBe('look');
    expect(files).toEqual([{ name: 'p.png', mimeType: 'image/png', data: 'QUJD' }]);
  });

  it('uses a fence longer than any backtick run in the content', () => {
    const content = 'a\n```js\nx\n```\nand ````four';
    const rc = run({ text: 'q', files: [{ name: 'r.md', type: 'text', content }] });
    const text = rc.sendMessage.mock.calls[0][0];
    expect(text).toContain(`Attached file: r.md\n\`\`\`\`\`\n${content}\n\`\`\`\`\``);
  });

  it('keeps several text files in order, images separate', () => {
    const rc = run({ text: 'q', files: [
      { name: 'one.txt', type: 'text', content: 'AAA' },
      { name: 'p.png', type: 'image', content: 'data:image/png;base64,QUJD' },
      { name: 'two.txt', type: 'text', content: 'BBB' },
    ] });
    const [text, files] = rc.sendMessage.mock.calls[0];
    expect(text.indexOf('Attached file: one.txt')).toBeGreaterThan(text.indexOf('q'));
    expect(text.indexOf('Attached file: two.txt')).toBeGreaterThan(text.indexOf('Attached file: one.txt'));
    expect(files.map((f) => f.name)).toEqual(['p.png']);
  });

  it('resume resend carries the same text and only the image files', () => {
    const rc = run({ text: 'q', files: [
      { name: 'one.txt', type: 'text', content: 'AAA' },
      { name: 'p.png', type: 'image', content: 'data:image/png;base64,QUJD' },
    ] });
    const [text, files] = rc.sendMessage.mock.calls[0];
    expect(rc.pendingUserMessage).toEqual({ sessionId: 's1', text, files });
    expect(files).toHaveLength(1);
  });

  it('dictation and voice prefixes wrap the text with the inlined file', () => {
    const rc = run({ text: 'q', dictated: true, files: [{ name: 'a.txt', type: 'text', content: 'AAA' }] }, { voiceMode: true });
    const text = rc.sendMessage.mock.calls[0][0];
    expect(text.startsWith('[VOICE MODE]')).toBe(true);
    expect(text.indexOf('[DICTATED]')).toBeGreaterThan(0);
    expect(text.endsWith('Attached file: a.txt\n```\nAAA\n```')).toBe(true);
  });
});

// #166 W2: pasted URLs reach relay as one sources block after the typed text.
describe('user_input urls', () => {
  const HEAD = '\n\nSources to read (fetch each one before you answer, and cite it with a markdown link to its URL):\n';
  const sent = (message) => run(message).sendMessage.mock.calls[0][0];

  it('text, then the sources block in chip order, then the text file', () => {
    expect(sent({
      text: 'What changed in this release?',
      urls: ['https://docs.example/release/2.0', 'https://acme.example/notes'],
      files: [{ name: 'notes.txt', type: 'text', mediaType: 'text/plain', content: 'first line\n' }],
    })).toBe('What changed in this release?' + HEAD
      + '- https://docs.example/release/2.0\n- https://acme.example/notes'
      + '\n\nAttached file: notes.txt\n```\nfirst line\n\n```');
  });

  it('drops invalid and duplicate urls and keeps the first five valid ones', () => {
    const u = (i) => `https://acme.example/${i}`;
    expect(sent({ text: 'q', urls: ['javascript:alert(1)', u(1), 'ftp://files.example/a', u(1), 7, u(2), 'a b', u(3), u(4), u(5), u(6)] }))
      .toBe(`q${HEAD}- ${u(1)}\n- ${u(2)}\n- ${u(3)}\n- ${u(4)}\n- ${u(5)}`);
  });

  it.each([
    ['absent', undefined],
    ['empty', []],
    ['not an array', 'https://acme.example/a'],
    ['all invalid', ['javascript:alert(1)', 'ftp://files.example/a']],
  ])('urls %s: the text reaches relay exactly as typed', (_what, urls) => {
    expect(sent({ text: 'What changed?', urls })).toBe('What changed?');
  });
});
