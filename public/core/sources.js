/**
 * Sources: what a research answer read. A source is one JSON object
 * ({url, title, description...}) in a `brave_web_search` tool result of the
 * same turn. Relay joins an MCP's text blocks with no separator and cuts the
 * result at 8,192 bytes, so the parser reads concatenated objects and drops an
 * incomplete last one. Pure, so unit tests and journeys can require it.
 */
const Sources = {
  EXCERPT_MAX: 600,

  isSearchTool(name) {
    return typeof name === 'string' &&
      (name === 'brave_web_search' || name.endsWith('__brave_web_search'));
  },

  isFetchTool(name) {
    return typeof name === 'string' && (name === 'web_fetch' || name.endsWith('__web_fetch'));
  },

  // null unless http(s). Host lowercased, fragment and trailing "/" dropped.
  normalizeUrl(href) {
    if (typeof href !== 'string') return null;
    let u;
    try { u = new URL(href.trim()); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href.replace(/\/+$/, '');
  },

  // content: string | object | text-block[] (history and Claude shapes).
  _text(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return null;
    const blocks = content.filter(b => b && b.type === 'text' && typeof b.text === 'string');
    return blocks.length ? blocks.map(b => b.text).join('') : null;
  },

  // Every complete top-level {...} in text, parsed; an unterminated tail is dropped.
  _objects(text) {
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"' && depth > 0) {
        inStr = true;
      } else if (c === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (c === '}' && depth > 0) {
        depth--;
        if (depth === 0) {
          try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (e) { /* skip */ }
        }
      }
    }
    return out;
  },

  _clean(s) {
    return String(s)
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&#x27;/gi, "'").replace(/&amp;/g, '&')
      .trim();
  },

  _excerpt(o) {
    const parts = [];
    const lead = typeof o.description === 'string' ? o.description : o.answer;
    if (typeof lead === 'string') parts.push(lead);
    if (Array.isArray(o.extra_snippets)) {
      for (const s of o.extra_snippets) if (typeof s === 'string') parts.push(s);
    }
    return parts.map(Sources._clean).filter(Boolean).join('\n\n').slice(0, Sources.EXCERPT_MAX);
  },

  // Candidate objects: the parsed values themselves, and any nested in arrays or objects.
  _collect(v, out) {
    if (Array.isArray(v)) { v.forEach(x => Sources._collect(x, out)); return; }
    if (!v || typeof v !== 'object') return;
    out.push(v);
    for (const k of Object.keys(v)) {
      if (v[k] && typeof v[k] === 'object') Sources._collect(v[k], out);
    }
  },

  // A page the model read: only an HTTP 2xx result counts. macMCP's web_fetch
  // returns "HTTP <status> — <type> — <n> bytes", a blank line, then the raw
  // body; relay may cut it, so an unclosed head, script, style or comment
  // runs to the end.
  fromFetch(input, content) {
    const key = Sources.normalizeUrl(input && input.url);
    if (!key) return [];
    const text = Sources._text(content);
    const m = text && /^HTTP (\d{3}) /.exec(text);
    if (!m || m[1] < '200' || m[1] > '299') return [];
    const gap = text.indexOf('\n\n');
    let body = gap === -1 ? '' : text.slice(gap + 2);
    body = body.replace(/\n\.\.\.\(truncated\)$/, '').replace(/\n\n…\[truncated to \d+ bytes\]$/, '');
    const url = new URL(input.url.trim()).href;
    const u = new URL(key);
    const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&(?:#0?39|apos);/g, "'").replace(/&amp;/g, '&');
    const tm = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(body);
    const title = tm ? decode(tm[1].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : '';
    const visible = body
      .replace(/<!--[\s\S]*?(-->|$)/g, ' ')
      .replace(/<head\b[\s\S]*?(<\/head\s*>|$)/gi, ' ')
      .replace(/<script\b[\s\S]*?(<\/script\s*>|$)/gi, ' ')
      .replace(/<style\b[\s\S]*?(<\/style\s*>|$)/gi, ' ')
      .replace(/<[^>]*>/g, ' ');
    const excerpt = decode(visible).replace(/\s+/g, ' ').trim().slice(0, Sources.EXCERPT_MAX);
    const fallback = u.host.replace(/^www\./i, '') + u.pathname.replace(/\/+$/, '');
    return [{ n: 1, url, key, host: u.hostname, title: title || fallback, excerpt }];
  },

  // Unnumbered sources in result order (n is set by turn()). Source:
  // {n, url, key, host, title, excerpt}. url is as the tool returned it (what
  // Open source links to); key is normalizeUrl(url), for matching and dedupe.
  fromResult(name, content, input) {
    if (Sources.isFetchTool(name)) return Sources.fromFetch(input, content);
    if (!Sources.isSearchTool(name)) return [];
    let candidates = [];
    const text = Sources._text(content);
    if (text !== null) Sources._objects(text).forEach(o => Sources._collect(o, candidates));
    else Sources._collect(content, candidates);
    const found = [];
    for (const o of candidates) {
      if (typeof o.title !== 'string') continue;
      const key = Sources.normalizeUrl(o.url);
      if (!key) continue;
      found.push({ url: new URL(o.url.trim()).href, key, host: new URL(key).hostname, title: o.title, excerpt: Sources._excerpt(o) });
    }
    return found.map((s, i) => Object.assign({ n: i + 1 }, s));
  },

  // One user message to the next: sources numbered 1..N, first-seen, deduped.
  turn() {
    const list = [];
    const byKey = new Map();
    return {
      add(name, content, input) {
        for (const s of Sources.fromResult(name, content, input)) {
          if (byKey.has(s.key)) continue;
          const src = { n: list.length + 1, url: s.url, key: s.key, host: s.host, title: s.title, excerpt: s.excerpt };
          byKey.set(s.key, src);
          list.push(src);
        }
      },
      list() { return list.slice(); },
      match(href) {
        const u = Sources.normalizeUrl(href);
        return u && byKey.has(u) ? byKey.get(u).n : null;
      },
    };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = Sources;
