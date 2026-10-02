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
