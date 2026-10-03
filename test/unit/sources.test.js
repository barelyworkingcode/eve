// S4-A1: what a source is. A search result's JSON objects become numbered,
// deduplicated sources whose excerpt is the text the model was given.
// docs/design-research.md
const Sources = require('../../public/core/sources');

const SEARCH = 'brave_web_search';
// Brave's MCP sends one compact JSON object per text block.
const brave = (o) => JSON.stringify(o);
const R1 = { url: 'https://acme.example/launch', title: 'Acme launch', description: 'Acme ships rockets.' };
const R2 = { url: 'http://widgets.example/w', title: 'Widgets', description: 'Widgets are small.' };
const urls = (list) => list.map((s) => s.url);

// relay (chat_base.go): toolResult[:8192] + "\n...(truncated)", a byte cut.
const MAX = 8192;
const relayCut = (text) => (Buffer.byteLength(text) > MAX
  ? Buffer.from(text).subarray(0, MAX).toString() + '\n...(truncated)'
  : text);

describe('Sources.isSearchTool', () => {
  it.each([
    [SEARCH, true],
    ['worldsearch__brave_web_search', true],
    ['brave_llm_context', false],
    ['web_fetch', false],
    ['my_brave_web_search', false],
    ['brave_web_search_v2', false],
    ['', false],
    [undefined, false],
  ])('%s -> %s', (name, want) => {
    expect(Sources.isSearchTool(name)).toBe(want);
  });

  it('a result from any other tool yields no sources, whatever its shape', () => {
    expect(Sources.fromResult('mail_get_emails', brave(R1))).toEqual([]);
  });
});

describe('Sources.fromResult content shapes', () => {
  it.each([
    ['relay\'s join: compact objects with no separator', brave(R1) + brave(R2)],
    ['a text-block array (Claude shape)', [{ type: 'text', text: brave(R1) }, { type: 'text', text: brave(R2) }]],
  ])('%s: one source per object, in result order', (_what, content) => {
    expect(Sources.fromResult('srv__brave_web_search', content)).toEqual([
      { n: 1, url: R1.url, key: R1.url, host: 'acme.example', title: R1.title, excerpt: R1.description },
      { n: 2, url: R2.url, key: R2.url, host: 'widgets.example', title: R2.title, excerpt: R2.description },
    ]);
  });

  it.each([
    ['a single object (history parses one result)', R1],
    ['a plain string holding one object', brave(R1)],
  ])('%s', (_what, content) => {
    expect(urls(Sources.fromResult(SEARCH, content))).toEqual([R1.url]);
  });

  it('a result cut at 8,192 bytes keeps every complete object and drops the incomplete last one', () => {
    const results = Array.from({ length: 30 }, (_, i) => ({
      url: `https://r${i}.example/page`, title: `Result ${i}`, description: 'x'.repeat(300),
    }));
    const full = results.map(brave).join('');
    const cut = relayCut(full);
    // Objects that end inside the first 8,192 bytes survive the cut.
    let end = 0;
    const whole = results.filter((r) => (end += Buffer.byteLength(brave(r))) <= MAX);
    expect(whole.length).toBeGreaterThan(0);
    expect(whole.length).toBeLessThan(results.length);
    expect(urls(Sources.fromResult(SEARCH, cut))).toEqual(whole.map((r) => r.url));
  });

  it.each([
    ['no results text', 'No web results found'],
    ['an MCP error', 'Error: mcp: call "brave_web_search": rate limited'],
    ['an empty string', ''],
    ['an empty block array', []],
  ])('%s yields no sources', (_what, content) => {
    expect(Sources.fromResult(SEARCH, content)).toEqual([]);
  });

  it.each([
    ['a javascript: url', { url: 'javascript:alert(1)', title: 'Bad' }],
    ['an ftp url', { url: 'ftp://files.example/a', title: 'Files' }],
    ['a relative url', { url: '/local/page', title: 'Local' }],
    ['no url', { title: 'No url' }],
    ['no title', { url: 'https://acme.example/x' }],
    ['a title that is not a string', { url: 'https://acme.example/x', title: 7 }],
  ])('an object with %s is not a source', (_what, obj) => {
    expect(urls(Sources.fromResult(SEARCH, brave(obj) + brave(R2)))).toEqual([R2.url]);
  });
});

describe('Sources excerpt', () => {
  const excerptOf = (fields) => Sources.fromResult(SEARCH, brave({ url: 'https://acme.example/a', title: 'T', ...fields }))[0].excerpt;

  it('is description then extra_snippets, joined by a blank line', () => {
    expect(excerptOf({ description: 'Lead.', extra_snippets: ['One.', 'Two.'] })).toBe('Lead.\n\nOne.\n\nTwo.');
  });

  it('uses answer when there is no description', () => {
    expect(excerptOf({ answer: 'The answer.', extra_snippets: ['More.'] })).toBe('The answer.\n\nMore.');
  });

  it('strips HTML tags', () => {
    expect(excerptOf({ description: 'Acme <strong>ships</strong> <em>rockets</em>.' })).toBe('Acme ships rockets.');
  });

  it.each([
    ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"], ['&#x27;', "'"], ['&#X27;', "'"],
    ['&amp;lt;', '&lt;'],
  ])('decodes %s once', (entity, text) => {
    expect(excerptOf({ description: `a ${entity} b` })).toBe(`a ${text} b`);
  });

  it('is capped at 600 characters', () => {
    const long = 'abcdefghij'.repeat(100);
    expect(excerptOf({ description: long })).toBe(long.slice(0, 600));
  });
});

describe('Sources.fromResult url', () => {
  it('stores the parsed href of the trimmed url', () => {
    const [s] = Sources.fromResult(SEARCH, brave({ url: '  HTTPS://Acme.Example:443/a b  ', title: 'T' }));
    expect(s.url).toBe('https://acme.example/a%20b');
  });
});

describe('Sources.normalizeUrl', () => {
  it.each([
    ['https://ACME.Example/a', 'https://acme.example/a'],
    ['https://acme.example/a#section', 'https://acme.example/a'],
    ['https://acme.example/a/', 'https://acme.example/a'],
    ['https://acme.example/', 'https://acme.example'],
    ['http://acme.example/a', 'http://acme.example/a'],
  ])('%s -> %s', (href, want) => {
    expect(Sources.normalizeUrl(href)).toBe(want);
  });

  it.each([['javascript:alert(1)'], ['mailto:a@acme.example'], ['/relative'], ['not a url'], [''], [null], [undefined]])(
    '%s is not http(s) -> null', (href) => {
      expect(Sources.normalizeUrl(href)).toBeNull();
    });
});

describe('Sources.turn', () => {
  it('dedupes by normalized URL and numbers 1..N in first-seen order across results', () => {
    const turn = Sources.turn();
    turn.add(SEARCH, brave(R1) + brave({ ...R1, url: 'https://ACME.example/launch/#top', title: 'Dup' }));
    turn.add('srv__brave_web_search', brave(R2) + brave({ ...R1, title: 'Dup again' }));
    turn.add('web_fetch', brave({ url: 'https://other.example/x', title: 'Fetched' }));
    expect(turn.list().map((s) => [s.n, s.url, s.title])).toEqual([[1, R1.url, R1.title], [2, R2.url, R2.title]]);
  });

  it('keeps the URL as the tool returned it (host lower-cased by the URL parser) and dedupes on the normalized key', () => {
    const turn = Sources.turn();
    turn.add(SEARCH, brave({ url: 'https://Acme.example/launch/#top', title: 'A' }) + brave({ url: 'https://acme.example/launch', title: 'Dup' }));
    expect(turn.list().map((s) => [s.url, s.key])).toEqual([['https://acme.example/launch/#top', 'https://acme.example/launch']]);
  });

  it('match returns a source\'s number for any spelling of its URL, else null', () => {
    const turn = Sources.turn();
    turn.add(SEARCH, brave(R1) + brave(R2));
    expect(turn.match('https://Acme.Example/launch/#intro')).toBe(1);
    expect(turn.match('http://widgets.example/w')).toBe(2);
    expect(turn.match('https://other.example/page')).toBeNull();
    expect(turn.match('javascript:alert(1)')).toBeNull();
  });

  it('two turns number independently', () => {
    const first = Sources.turn();
    first.add(SEARCH, brave(R1) + brave(R2));
    const second = Sources.turn();
    second.add(SEARCH, brave(R2));
    expect(first.list().map((s) => [s.n, s.url])).toEqual([[1, R1.url], [2, R2.url]]);
    expect(second.list().map((s) => [s.n, s.url])).toEqual([[1, R2.url]]);
    expect(second.match(R1.url)).toBeNull();
  });
});

// #166 A6/A7: a page read with web_fetch is a source when its status is 2xx.
// macMCP's result: "HTTP <status> — <type> — <n> bytes", a blank line, the body.
const FETCH = 'macmcp__web_fetch';
const PAGE_URL = 'https://acme.example/docs/guide';
const fetched = (body, status = 200) => `HTTP ${status} — text/html; charset=utf-8 — ${body.length} bytes\n\n${body}`;
const fetchOne = (body, opts = {}) => Sources.fromResult(FETCH, fetched(body, opts.status), { url: opts.url || PAGE_URL });

describe('Sources.isFetchTool', () => {
  it.each([
    ['web_fetch', true], [FETCH, true], ['web_fetch_v2', false], ['my_web_fetch', false],
    [SEARCH, false], ['', false], [undefined, false],
  ])('%s -> %s', (name, want) => {
    expect(Sources.isFetchTool(name)).toBe(want);
  });
});

describe('Sources from a web_fetch result', () => {
  const HTML = '<html><head><title>Acme guide</title><meta name="x"></head><body><p>Read <b>this</b> page.</p></body></html>';

  it.each([
    ['a string', fetched(HTML)],
    ['a text-block array (Claude shape)', [{ type: 'text', text: fetched(HTML) }]],
  ])('a 200 page in %s is one source; url is the trimmed href of input.url', (_what, content) => {
    expect(Sources.fromResult('web_fetch', content, { url: '  HTTPS://Acme.Example/docs/  ' })).toEqual([
      { n: 1, url: 'https://acme.example/docs/', key: 'https://acme.example/docs', host: 'acme.example', title: 'Acme guide', excerpt: 'Read this page.' },
    ]);
  });

  it.each([[200], [204], [299]])('status %i counts', (status) => {
    expect(fetchOne('<p>ok</p>', { status })).toHaveLength(1);
  });

  it.each([
    ['status 199', fetched('<p>x</p>', 199)],
    ['status 301', fetched('<p>x</p>', 301)],
    ['status 404', fetched('<p>Not found</p>', 404)],
    ['status 500', fetched('<p>x</p>', 500)],
    ['a refusal', 'Error: access denied: outbound access is not allowed for this project'],
    ['a fetch error', 'Error: mcp: call "web_fetch": dial tcp: connection refused'],
    ['an empty result', ''],
  ])('%s gives no source', (_what, content) => {
    expect(Sources.fromResult(FETCH, content, { url: PAGE_URL })).toEqual([]);
  });

  it.each([
    ['no input', undefined], ['no url', {}], ['a javascript: url', { url: 'javascript:alert(1)' }],
    ['an ftp url', { url: 'ftp://files.example/a' }], ['not a url', { url: 'acme guide' }],
  ])('%s gives no source', (_what, input) => {
    expect(Sources.fromResult(FETCH, fetched(HTML), input)).toEqual([]);
  });

  it('with no <title>, the title is host and path', () => {
    expect(fetchOne('<p>Body</p>', { url: 'https://acme.example/docs/guide' })[0].title).toBe('acme.example/docs/guide');
  });

  it('the excerpt drops comments, head, script and style, strips tags and collapses whitespace', () => {
    const body = '<!doctype html><html><head><title>T</title><style>.a{}</style></head>\n<body><!-- note -->'
      + '<h1>Big\n\n  news</h1><script>var s = "<p>no</p>";</script><style>p { color: red }</style>\t<p>More   text</p></body></html>';
    expect(fetchOne(body)[0].excerpt).toBe('Big news More text');
  });

  it.each([
    ['<script>', '<p>Kept</p><script>var x = "<p>hidden</p>";'],
    ['<style>', '<p>Kept</p><style>p { content: "hidden" }'],
    ['<head>', '<p>Kept</p><head><meta name="hidden" content="hidden">hidden'],
    ['comment', '<p>Kept</p><!-- hidden <p>hidden</p>'],
  ])('an unclosed %s at relay\'s 8 KB cut runs to the end', (_what, body) => {
    expect(fetchOne(`${body}\n...(truncated)`)[0].excerpt).toBe('Kept');
  });

  it.each([
    ['relay', '\n...(truncated)'],
    ['macMCP', '\n\n…[truncated to 1048576 bytes]'],
  ])('%s\'s truncation tail is not part of the excerpt', (_who, tail) => {
    expect(fetchOne(`<p>Visible text</p>${tail}`)[0].excerpt).toBe('Visible text');
  });

  it('decodes the five basic entities once', () => {
    expect(fetchOne('<p>&amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; &amp;lt;</p>')[0].excerpt).toBe('& <b> "q" \'s\' &lt;');
  });

  it('decodes &apos; in the title and the excerpt', () => {
    const s = fetchOne('<head><title>It&apos;s</title></head><p>It&apos;s</p>')[0];
    expect([s.title, s.excerpt]).toEqual(["It's", "It's"]);
  });

  it('caps the excerpt at 600 characters', () => {
    const long = 'abcdefghij'.repeat(100);
    expect(fetchOne(`<p>${long}</p>`)[0].excerpt).toBe(long.slice(0, 600));
  });
});

describe('Sources.turn with search and fetch', () => {
  const page = (title) => fetched(`<title>${title}</title><p>${title} body</p>`);

  it('numbers in first-seen order and dedupes a fetched page against search results by normalized URL', () => {
    const turn = Sources.turn();
    turn.add(FETCH, page('Guide'), { url: PAGE_URL });
    turn.add(SEARCH, brave(R1) + brave({ url: 'https://ACME.example/docs/guide/#top', title: 'Dup' }) + brave(R2));
    turn.add('web_fetch', page('Launch again'), { url: 'https://acme.example/launch#x' });
    expect(turn.list().map((s) => [s.n, s.url, s.title])).toEqual([
      [1, PAGE_URL, 'Guide'], [2, R1.url, R1.title], [3, R2.url, R2.title],
    ]);
    expect(turn.match('https://acme.example/docs/guide/')).toBe(1);
  });

  it('a 404 fetch in a turn adds nothing', () => {
    const turn = Sources.turn();
    turn.add(SEARCH, brave(R1));
    turn.add(FETCH, fetched('<p>gone</p>', 404), { url: PAGE_URL });
    expect(turn.list().map((s) => s.url)).toEqual([R1.url]);
  });
});
