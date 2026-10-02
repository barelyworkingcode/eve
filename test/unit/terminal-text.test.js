// S5a-A3: the agent board's last line. docs/design-workbench.md
const TerminalText = require('../../public/core/terminal-text');

describe('TerminalText.lastLine', () => {
  it('returns the last non-empty line', () => {
    expect(TerminalText.lastLine('one\r\ntwo\r\n\r\n  \r\n')).toBe('two');
  });

  it('strips CSI sequences', () => {
    expect(TerminalText.lastLine('\x1b[1;32mbuild ok\x1b[0m\x1b[K')).toBe('build ok');
  });

  it('strips OSC sequences ended by BEL or ST', () => {
    expect(TerminalText.lastLine('\x1b]0;window title\x07done')).toBe('done');
    expect(TerminalText.lastLine('\x1b]8;;http://acme.test\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
  });

  it('applies a carriage-return overwrite', () => {
    expect(TerminalText.lastLine('10%\r50%\r100% done')).toBe('100% done');
    expect(TerminalText.lastLine('long line here\rshort')).toBe('shortline here');
    expect(TerminalText.lastLine('old text\r\x1b[2Knew')).toBe('new');
  });

  it('skips lines of only box-drawing characters', () => {
    expect(TerminalText.lastLine('thinking...\r\n╭──────╮\r\n│      │\r\n╰──────╯\r\n')).toBe('thinking...');
  });

  it('keeps a box line that has text', () => {
    expect(TerminalText.lastLine('│ > run the tests │')).toBe('│ > run the tests │');
  });

  it('reads a zsh prompt, ignoring the end-of-line mark it draws', () => {
    expect(TerminalText.lastLine('out\r\n\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m                \r \r\r\x1b[0m\x1b[27m\x1b[24m\x1b[Jtester@testbox proj % \x1b[K'))
      .toBe('tester@testbox proj %');
    expect(TerminalText.lastLine('out\r\n%\x1b[0m \r \r')).toBe('out');
  });

  it('clips to the maximum, default 120', () => {
    expect(TerminalText.lastLine('x'.repeat(300))).toHaveLength(120);
    expect(TerminalText.lastLine('abcdefghij', 4)).toBe('abcd');
  });

  it('returns an empty string for nothing usable', () => {
    expect(TerminalText.lastLine('')).toBe('');
    expect(TerminalText.lastLine(null)).toBe('');
    expect(TerminalText.lastLine('\r\n──────\r\n')).toBe('');
  });
});
