// S5a-A4 "Ask about this": the 256 KB limit and one item at a time.
// core/constants.js and today/ask-about.js are plain <script> globals, so both
// run in one vm context the way index.html loads them. docs/design-workbench.md
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const context = vm.createContext({ console, TextEncoder, window: {}, navigator: { userAgent: '' } });
  for (const file of ['core/constants.js', 'today/ask-about.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../public', file), 'utf8'), context);
  }
  const AskAbout = vm.runInContext('AskAbout', context);
  const state = {};
  const values = { state, tabManager: { showToday() {} }, bus: { emit() {} } };
  return { AskAbout, state, container: { get: (name) => values[name] } };
}

const LIMIT = 256 * 1024;
const item = (content, name = 'a.txt') => ({ kind: 'file', name, label: name, content });

describe('AskAbout.start', () => {
  it.each([
    ['exactly 256 KB', true, 'x'.repeat(LIMIT)],
    ['one byte over', false, 'x'.repeat(LIMIT + 1)],
    ['under 256 KB in characters but over it in UTF-8 bytes', false, 'é'.repeat(LIMIT / 2 + 1)],
  ])('%s: attached %s', (_label, attached, content) => {
    const { AskAbout, state, container } = load();
    AskAbout.start(container, { projectId: 'p1', attachment: item(content) });
    expect(state.askAbout.projectId).toBe('p1');
    expect(state.askAbout.attachment ? state.askAbout.attachment.content.length : 0).toBe(attached ? content.length : 0);
  });

  it('a second item replaces the first', () => {
    const { AskAbout, state, container } = load();
    AskAbout.start(container, { projectId: 'p1', attachment: item('one', 'first.txt') });
    AskAbout.start(container, { projectId: 'p2', attachment: item('two', 'second.txt') });
    expect(state.askAbout).toMatchObject({ projectId: 'p2', attachment: { name: 'second.txt', content: 'two' } });
  });
});
