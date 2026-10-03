// Output schema v1 for a custom Today card (eve#117 contract): what a script
// writes, how it is normalised and capped, and why it is refused.
const CustomOutput = require('../../public/today/custom-output');

const parse = (obj) => CustomOutput.parse(typeof obj === 'string' ? obj : JSON.stringify(obj));
const ok = (obj) => {
  const r = parse(obj);
  expect(r.ok).toBe(true);
  return r.data;
};

describe('CustomOutput.isPartTask', () => {
  it.each([
    [{ sessionType: 'pty', outputFile: 'today.json' }, true],
    [{ sessionType: 'pty', outputFile: '' }, false],
    [{ sessionType: 'pty' }, false],
    [{ sessionType: 'pty', outputFile: 7 }, false],
    [{ sessionType: 'headless', outputFile: 'today.json' }, false],
    [{ outputFile: 'today.json' }, false],
  ])('%j is %s', (task, expected) => {
    expect(CustomOutput.isPartTask(task)).toBe(expected);
  });
});

describe('CustomOutput.safeUrl', () => {
  it.each(['https://acme.test/inbox?id=1', 'http://acme.test/'])('keeps %s', (url) => {
    expect(CustomOutput.safeUrl(url)).toBe(url);
  });
  it.each([
    'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,<b>x</b>',
    '/relative/path', 'acme.test/inbox', 'mailto:p1@acme.test', '', null, 42,
  ])('drops %j', (url) => {
    expect(CustomOutput.safeUrl(url)).toBeNull();
  });
});

describe('CustomOutput.parse failures', () => {
  it.each([
    ['', 'empty'],
    ['  \n ', 'empty'],
    ['{"renderer":', 'bad-json'],
    ['not json', 'bad-json'],
    ['[]', 'bad-json'],
    ['null', 'bad-json'],
    ['"list"', 'bad-json'],
    [{ renderer: 'markdown', items: [] }, 'unknown-renderer'],
    [{ items: [{ title: 'x' }] }, 'unknown-renderer'],
    [{ renderer: 'list' }, 'bad-shape'],
    [{ renderer: 'list', items: { title: 'x' } }, 'bad-shape'],
    [{ renderer: 'table', columns: [], rows: [] }, 'bad-shape'],
    [{ renderer: 'table', rows: [['a']] }, 'bad-shape'],
    [{ renderer: 'metrics', metrics: 'x' }, 'bad-shape'],
  ])('%j is %s', (text, reason) => {
    expect(parse(text)).toEqual({ ok: false, reason });
  });

  it('ignores unknown keys', () => {
    const r = parse({ renderer: 'list', items: [{ title: 'a', extra: 1 }], version: 9 });
    expect(r).toMatchObject({ ok: true, renderer: 'list' });
  });
});

describe('list', () => {
  it('keeps title, detail and a safe url; drops an item with no title; an unsafe url leaves the item as text', () => {
    const { items } = ok({
      renderer: 'list',
      items: [
        { title: 'Reply to Acme', detail: 'today', url: 'https://acme.test/m/1' },
        { detail: 'no title' },
        'just a string',
        { title: '<b>Bold</b> <img src=x onerror=alert(1)>', url: 'javascript:alert(1)' },
        { title: 'Relative', url: '/inbox' },
      ],
    });
    expect(items.map((i) => i.title)).toEqual(['Reply to Acme', '<b>Bold</b> <img src=x onerror=alert(1)>', 'Relative']);
    expect(items[0]).toMatchObject({ detail: 'today', url: 'https://acme.test/m/1' });
    expect(items[1].url).toBeNull();
    expect(items[2].url).toBeNull();
  });

  it('holds at most 50 items', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `t${i}` }));
    const { items } = ok({ renderer: 'list', items: many });
    expect(items.map((i) => i.title)).toEqual(many.slice(0, 50).map((i) => i.title));
  });
});

describe('table', () => {
  it('stringifies cells, null as empty, and pads or cuts each row to the columns', () => {
    const data = ok({ renderer: 'table', columns: ['Name', 'Count', 'Open'], rows: [['a', 3, true], ['b', null], ['c', 1, false, 'extra']] });
    expect(data.columns).toEqual(['Name', 'Count', 'Open']);
    expect(data.rows).toEqual([['a', '3', 'true'], ['b', '', ''], ['c', '1', 'false']]);
  });

  it('holds at most 8 columns and 50 rows', () => {
    const columns = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 60 }, (_, i) => [String(i)]);
    const data = ok({ renderer: 'table', columns, rows });
    expect(data.columns).toEqual(columns.slice(0, 8));
    expect(data.rows).toHaveLength(50);
    expect(data.rows.every((r) => r.length === 8)).toBe(true);
  });
});

describe('metrics', () => {
  it('keeps label, value and detail, and drops a metric with no label', () => {
    const data = ok({ renderer: 'metrics', metrics: [{ label: 'Unread', value: '7', detail: 'INBOX' }, { value: 3 }, { label: 'Due', value: 0 }] });
    expect(data.metrics.map((m) => m.label)).toEqual(['Unread', 'Due']);
    expect(data.metrics[0]).toMatchObject({ label: 'Unread', value: '7', detail: 'INBOX' });
    expect(String(data.metrics[1].value)).toBe('0');
  });

  it('holds at most 12', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ label: `m${i}`, value: i }));
    expect(ok({ renderer: 'metrics', metrics: many }).metrics.map((m) => m.label)).toEqual(many.slice(0, 12).map((m) => m.label));
  });
});

// Each cap: a string at the cap is kept whole; one past it is shortened to at
// most the cap and ends with "…".
describe('caps', () => {
  const pick = {
    title: (s) => ok({ renderer: 'list', items: [{ title: s }] }).items[0].title,
    detail: (s) => ok({ renderer: 'list', items: [{ title: 't', detail: s }] }).items[0].detail,
    label: (s) => ok({ renderer: 'metrics', metrics: [{ label: s, value: 1 }] }).metrics[0].label,
    value: (s) => ok({ renderer: 'metrics', metrics: [{ label: 'l', value: s }] }).metrics[0].value,
    cell: (s) => ok({ renderer: 'table', columns: ['c'], rows: [[s]] }).rows[0][0],
  };
  it.each([['title', 120], ['detail', 200], ['label', 60], ['value', 40], ['cell', 80]])('%s at %i', (field, cap) => {
    expect(pick[field]('a'.repeat(cap))).toBe('a'.repeat(cap));
    const long = pick[field]('a'.repeat(cap + 50));
    expect(long.length).toBeLessThanOrEqual(cap);
    expect(long.endsWith('…')).toBe(true);
    expect(long.startsWith('a'.repeat(cap - 2))).toBe(true);
  });

  // A url past 2048 is dropped (a cut link would be broken); the item stays.
  it('url at 2048', () => {
    const at = (n) => `https://acme.test/${'a'.repeat(n - 'https://acme.test/'.length)}`;
    const item = (url) => ok({ renderer: 'list', items: [{ title: 't', url }] }).items[0];
    expect(item(at(2048)).url).toBe(at(2048));
    const long = item(at(2100));
    expect(long.title).toBe('t');
    expect(long.url).toBeNull();
  });
});
