// The one place that knows how pasted URLs travel inside message text:
//   "\n\nSources to read (...):\n- <url>\n- <url>"
// The server writes it (ws/session-messages.js, via require); the browser reads
// it back to show a chip per URL when a thread is replayed. Parse only counts a
// block that runs to the end of the text, like AttachedFiles.
const SourceUrls = {
  MAX: 5,
  MAX_LEN: 2048,
  MARK: '\n\nSources to read (fetch each one before you answer, and cite it with a markdown link to its URL):\n',

  // href when trim(text) is exactly one http(s) URL with a host; otherwise null.
  fromPaste(text) {
    if (typeof text !== 'string') return null;
    const t = text.trim();
    if (!t || t.length > SourceUrls.MAX_LEN || /\s/.test(t)) return null;
    let u;
    try { u = new URL(t); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  },

  // "host/path": no scheme, no www., no query or fragment, no trailing "/".
  label(href) {
    let s = String(href);
    try {
      const u = new URL(href);
      s = u.host.replace(/^www\./i, '') + u.pathname.replace(/\/+$/, '');
    } catch (e) { /* show as given */ }
    return s.length > 60 ? s.slice(0, 59) + '…' : s;
  },

  accept(urls) {
    if (!Array.isArray(urls)) return [];
    const out = [];
    for (const raw of urls) {
      const href = SourceUrls.fromPaste(raw);
      if (!href || out.includes(href)) continue;
      out.push(href);
      if (out.length >= SourceUrls.MAX) break;
    }
    return out;
  },

  format(urls) {
    if (!Array.isArray(urls) || !urls.length) return '';
    return SourceUrls.MARK + urls.map(u => '- ' + u).join('\n');
  },

  parse(text) {
    const src = typeof text === 'string' ? text : '';
    let from = src.indexOf(SourceUrls.MARK);
    while (from !== -1) {
      const lines = src.slice(from + SourceUrls.MARK.length).split('\n');
      const urls = [];
      for (const line of lines) {
        const m = /^- (\S+)$/.exec(line);
        const href = m && SourceUrls.fromPaste(m[1]);
        if (!href) { urls.length = 0; break; }
        urls.push(href);
      }
      if (urls.length) return { text: src.slice(0, from), urls };
      from = src.indexOf(SourceUrls.MARK, from + 1);
    }
    return { text: src, urls: [] };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = SourceUrls;
