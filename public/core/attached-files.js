// The one place that knows how a text attachment is inlined into message text:
//   "\n\nAttached file: <name>\n<fence>\n<content>\n<fence>"
// The server writes it (ws/session-messages.js, via require); the browser reads
// it back to show a chip instead of the file's text when a thread is replayed.
// The fence is a backtick run longer than any run inside the content, so a
// reader finds the closer by length, never by a fixed ```.
const AttachedFiles = {
  MARK: '\n\nAttached file: ',

  format(name, content) {
    const body = content || '';
    const longestRun = (body.match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 0);
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${AttachedFiles.MARK}${name}\n${fence}\n${body}\n${fence}`;
  },

  // One block starting at `at` (which is at a MARK). Returns { name, end } or null.
  _block(text, at) {
    const nameStart = at + AttachedFiles.MARK.length;
    const nameEnd = text.indexOf('\n', nameStart);
    if (nameEnd <= nameStart) return null;
    const m = /^(`{3,})\n/.exec(text.slice(nameEnd + 1, nameEnd + 1 + 4096 + 3));
    if (!m) return null;
    const fence = m[1];
    const contentStart = nameEnd + 1 + m[0].length;
    // Content holds no run as long as the fence, so the first "\n<fence>" closes it.
    const close = text.indexOf(`\n${fence}`, contentStart - 1);
    if (close < contentStart - 1) return null;
    const end = close + 1 + fence.length;
    if (end < text.length && text[end] === '`') return null;
    return { name: text.slice(nameStart, nameEnd), end };
  },

  // Only blocks that run to the end of the text count: a mention of
  // "Attached file:" in the user's own words is left alone.
  // Returns { text, files: [{ name }] }.
  parse(text) {
    const src = typeof text === 'string' ? text : '';
    let from = src.indexOf(AttachedFiles.MARK);
    while (from !== -1) {
      const files = [];
      let at = from;
      while (at < src.length && src.startsWith(AttachedFiles.MARK, at)) {
        const b = AttachedFiles._block(src, at);
        if (!b) break;
        files.push({ name: b.name });
        at = b.end;
      }
      if (files.length && at === src.length) return { text: src.slice(0, from), files };
      from = src.indexOf(AttachedFiles.MARK, from + 1);
    }
    return { text: src, files: [] };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = AttachedFiles;
