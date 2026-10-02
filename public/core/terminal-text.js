// Pure: the last meaningful line of raw PTY text, for the agent board
// (docs/design-workbench.md, S5a-A3). No DOM, no globals.
const TerminalText = {
  // OSC (to BEL or ST), CSI, charset selects, then any other two-byte escape.
  _ESC: /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\x1b[@-Z\\-_]/g,
  // Erase-in-line is kept as a marker: a redrawn line ("\r\x1b[2K...") must not keep its old tail.
  _ERASE: /\x1b\[[012]?K/g,
  _BOX_ONLY: /^[\s─-▟]*$/,

  // The last line that is not empty and not only box-drawing, escapes removed,
  // carriage-return overwrites applied, at most `max` characters.
  lastLine(raw, max = 120) {
    if (!raw) return '';
    const text = String(raw).replace(this._ERASE, '\u0001').replace(this._ESC, '').replace(/\r\n/g, '\n');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = this._settle(lines[i]).trim();
      if (!line || this._BOX_ONLY.test(line)) continue;
      return this._clip(line, max);
    }
    return '';
  },

  // Each \r returns to column 0 and later text overwrites what is under it.
  _settle(line) {
    let cur = '';
    for (const seg of line.split('\r')) {
      const k = seg.indexOf('\u0001');
      if (k < 0) {
        cur = seg + cur.slice(seg.length);
      } else {
        const head = seg.slice(0, k);
        cur = head + cur.slice(head.length);
        cur = cur.slice(0, head.length) + seg.slice(k + 1).replace(/\u0001/g, '');
      }
    }
    return cur.replace(/\t/g, ' ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  },

  _clip(line, max) {
    if (line.length <= max) return line;
    let out = line.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    return out;
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = TerminalText;
