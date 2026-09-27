const path = require('path');

const HOME = '/Users/someone';

describe('devboxverify/main.js', () => {
  const {
    scrub, formatLine, parseArgs, parseWorldSummary, tally,
    parseListenPids, parseCwd, parseLstart,
    eveProcessProblem, liveEveProblem, serviceRowProblem,
  } = require('../../devboxverify/main');

  describe('scrub and formatLine', () => {
    it('replaces home with ~, collapses whitespace and joins fields with tabs', () => {
      expect(formatLine(HOME, 'JOURNEY', 'x', 'FAIL', `read ${HOME}/a \n then\t\t${HOME}/b`))
        .toBe('JOURNEY\tx\tFAIL\tread ~/a then ~/b');
    });

    it('leaves text alone when home is empty', () => {
      expect(scrub(`${HOME}/a`, '')).toBe(`${HOME}/a`);
    });
  });

  describe('parseArgs', () => {
    const toolRoot = `${HOME}/src/eve`;

    it('applies the defaults', () => {
      const args = parseArgs([], { toolRoot });
      expect(args.checkout).toBe(toolRoot);
      expect(args.world).toBe(path.resolve(toolRoot, '..', 'devboxWorld'));
      expect(args.url).toBe('http://localhost:3100');
      expect(args.service).toBe('eve-verify');
      expect(args.post == null).toBe(true);
    });

    it('accepts a loopback url with a port and a positive --post', () => {
      const args = parseArgs(['--url', 'http://127.0.0.1:3200', '--post', '7'], { toolRoot });
      expect(args.url).toBe('http://127.0.0.1:3200');
      expect(Number(args.post)).toBe(7);
    });

    it.each([
      ['--post without a value', ['--post']],
      ['--post 0', ['--post', '0']],
      ['an https url', ['--url', 'https://localhost:3100']],
      ['a non-loopback host', ['--url', 'http://example.com:3100']],
      ['a url without an explicit port', ['--url', 'http://localhost']],
      ['a positional argument', ['extra']],
      ['an unknown flag', ['--only', 'chat-reply']],
    ])('throws a usage error for %s', (_label, argv) => {
      let err;
      try { parseArgs(argv, { toolRoot }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect(err.usage).toBe(true);
    });
  });

  describe('parseWorldSummary', () => {
    it('takes the last column-0 SUMMARY line', () => {
      const out = 'CHECK\ta\tOK\nSUMMARY\tpass=3\tfail=1\nmore\nSUMMARY\tpass=12\tfail=0\n';
      expect(parseWorldSummary(out)).toEqual({ pass: 12, fail: 0 });
    });

    it.each([
      ['there is no SUMMARY line', 'CHECK\ta\tOK\n'],
      ['the last SUMMARY line is malformed', 'SUMMARY\tpass=3\tfail=0\nSUMMARY\tpass=oops\n'],
      ['the only SUMMARY line is indented', '  SUMMARY\tpass=3\tfail=0\n'],
    ])('throws when %s', (_label, out) => {
      expect(() => parseWorldSummary(out)).toThrow();
    });
  });

  describe('tally', () => {
    const r = (state) => ({ id: state.toLowerCase(), state, detail: '' });

    it.each([
      ['PASS and NOTRUN', ['PASS', 'NOTRUN', 'PASS'], { PASS: 2, FAIL: 0, BLOCKED: 0, NOTRUN: 1 }, 0],
      ['a BLOCKED', ['PASS', 'BLOCKED'], { PASS: 1, FAIL: 0, BLOCKED: 1, NOTRUN: 0 }, 1],
      ['a FAIL', ['FAIL', 'NOTRUN'], { PASS: 0, FAIL: 1, BLOCKED: 0, NOTRUN: 1 }, 1],
    ])('counts %s', (_label, states, counts, exitCode) => {
      expect(tally(states.map(r))).toEqual({ counts, exitCode });
    });
  });

  describe('lsof and ps parsers', () => {
    it('returns unique ascending listen pids', () => {
      expect(parseListenPids('p812\nf23\np401\nf5\np812\nf24\n')).toEqual([401, 812]);
      expect(parseListenPids('')).toEqual([]);
    });

    it('returns the cwd path, spaces included, or null', () => {
      expect(parseCwd(`p812\nfcwd\nn${HOME}/src/Acme Corp\n`)).toBe(`${HOME}/src/Acme Corp`);
      expect(parseCwd('p812\nfcwd\n')).toBeNull();
    });

    it.each([
      ['a space-padded day', 'Sat Sep  5 03:30:01 2026\n', new Date(2026, 8, 5, 3, 30, 1).getTime()],
      ['a two-digit day', 'Fri Sep 25 14:02:09 2026\n', new Date(2026, 8, 25, 14, 2, 9).getTime()],
      ['garbage', 'ps: no such process\n', null],
    ])('parses lstart with %s', (_label, text, expected) => {
      expect(parseLstart(text)).toBe(expected);
    });
  });

  describe('eveProcessProblem', () => {
    const checkout = `${HOME}/src/eve`;
    const newestChangeMs = 1790000000500;
    const base = {
      pids: [812],
      cwd: checkout,
      command: `node --env-file=${checkout}/.env server.js --data ${HOME}/.local/state/eve-verify/data`,
      startedAtMs: 1790000000000,
      checkout,
      newestChangeMs,
    };

    it('accepts eve started in the same second as the newest change', () => {
      expect(eveProcessProblem(base)).toBeNull();
    });

    it.each([
      ['no listener', { pids: [] }],
      ['two listeners', { pids: [812, 813] }],
      ['an unknown cwd', { cwd: null }],
      ['another checkout', { cwd: `${HOME}/src/other` }],
      ['a non-node process', { command: 'python3 -m http.server 3100' }],
      ['node running another script', { command: 'node other.js' }],
      ['an unknown start time', { startedAtMs: null }],
      ['a start one second before the newest change', { startedAtMs: 1789999999000 }],
    ])('reports %s', (_label, override) => {
      expect(eveProcessProblem({ ...base, ...override })).not.toBeNull();
    });
  });

  describe('liveEveProblem', () => {
    const base = { port: 3100, pid: 812, cwd: `${HOME}/src/eve-verify`, livePids: [401], liveCwd: `${HOME}/src/eve` };

    it.each([
      ['a separate live eve', {}],
      ['no live eve running', { livePids: [], liveCwd: null }],
    ])('accepts %s', (_label, override) => {
      expect(liveEveProblem({ ...base, ...override })).toBeNull();
    });

    it.each([
      ['the live port', { port: 3000 }],
      ['the live pid', { livePids: [401, 812] }],
      ['the live checkout', { liveCwd: `${HOME}/src/eve-verify` }],
    ])('reports a target on %s', (_label, override) => {
      expect(liveEveProblem({ ...base, ...override })).not.toBeNull();
    });
  });

  describe('serviceRowProblem', () => {
    const header = 'ID          NAME        URL                     STATUS';
    const row = (id, url, status) => `${id.padEnd(12)}${'eve'.padEnd(12)}${url.padEnd(24)}${status}`;
    const list = (...rows) => [header, ...rows].join('\n') + '\n';
    const verifyUrl = 'http://localhost:3100';
    const liveRow = row('eve', 'http://localhost:3000', 'running');

    it('accepts a running row with the url', () => {
      expect(serviceRowProblem(list(liveRow, row('eve-verify', verifyUrl, 'running')), 'eve-verify', verifyUrl))
        .toBeNull();
    });

    it.each([
      ['failed', list(liveRow, row('eve-verify', verifyUrl, 'failed')), 'eve-verify'],
      ['restarting', list(liveRow, row('eve-verify', verifyUrl, 'restarting')), 'eve-verify'],
      ['-', list(liveRow, row('eve-verify', verifyUrl, '-')), 'eve-verify'],
      ['another url', list(liveRow, row('eve-verify', 'http://localhost:3200', 'running')), 'eve-verify'],
      ['a missing row', list(liveRow), 'eve-verify'],
      ['an eve-verify row asked for eve', list(row('eve-verify', verifyUrl, 'running')), 'eve'],
      ['an eve row asked for eve-verify', list(row('eve', verifyUrl, 'running')), 'eve-verify'],
    ])('reports %s', (_label, listOut, service) => {
      expect(serviceRowProblem(listOut, service, verifyUrl)).not.toBeNull();
    });
  });
});

describe('devboxverify/eve-api.js', () => {
  const { classify, added, onlyOutside } = require('../../devboxverify/eve-api');

  const acmePath = `${HOME}/devboxWorld/projects/Acme Corp`;
  const projects = [
    { key: 'acme', id: 'p1', name: 'Acme Corp', path: acmePath },
    { key: 'globex', id: 'p2', name: 'Globex', path: `${HOME}/devboxWorld/projects/Globex` },
  ];
  const flags = (items) => items.map(({ id, world }) => ({ id, world }));

  it('flags world items only', () => {
    const snap = classify({
      sessions: [{ id: 's1', projectId: 'p1', name: 'a' }, { id: 's2', projectId: 'p9', name: 'b' }],
      tasks: [{ id: 't1', name: 'a' }, { id: 't2', name: 'b' }],
      worldTaskIds: ['t1'],
      terminals: [
        { id: 'x1', directory: acmePath, name: 'a' },
        { id: 'x2', directory: `${acmePath}/sub`, name: 'b' },
        { id: 'x3', directory: `${acmePath}2`, name: 'c' },
        { id: 'x4', directory: `${HOME}/elsewhere`, name: 'd' },
      ],
    }, projects);

    expect(flags(snap.sessions)).toEqual([{ id: 's1', world: true }, { id: 's2', world: false }]);
    expect(flags(snap.tasks)).toEqual([{ id: 't1', world: true }, { id: 't2', world: false }]);
    expect(flags(snap.terminals)).toEqual([
      { id: 'x1', world: true }, { id: 'x2', world: true },
      { id: 'x3', world: false }, { id: 'x4', world: false },
    ]);
  });

  it('reports only new items, and onlyOutside keeps the non-world ones', () => {
    const item = (id, world) => ({ id, name: id, world });
    const before = { sessions: [item('s1', true)], tasks: [], terminals: [item('x1', false)] };
    const after = {
      sessions: [item('s1', true), item('s2', true)],
      tasks: [item('t9', false)],
      terminals: [item('x1', false)],
    };

    const diff = added(before, after);
    expect(flags(diff.sessions)).toEqual([{ id: 's2', world: true }]);
    expect(flags(diff.terminals)).toEqual([]);
    const outside = onlyOutside(diff);
    expect([...outside.sessions, ...outside.tasks, ...outside.terminals].map((i) => i.id)).toEqual(['t9']);
  });
});

describe('devboxverify/post.js', () => {
  const { statusState, renderComment, commentUrlFrom } = require('../../devboxverify/post');
  const r = (id, state, detail = '') => ({ id, state, detail });

  it.each([
    ['PASS and NOTRUN', ['PASS', 'NOTRUN'], 'success'],
    ['FAIL beside BLOCKED', ['BLOCKED', 'FAIL', 'PASS'], 'failure'],
    ['BLOCKED without FAIL', ['PASS', 'BLOCKED'], 'error'],
  ])('maps %s to its status', (_label, states, expected) => {
    expect(statusState(states.map((s, i) => r(`j${i}`, s)))).toBe(expected);
  });

  it('renders every journey, scrubbed and with | escaped', () => {
    const body = renderComment({
      pr: 7, commit: 'a'.repeat(40), toolCommit: 'b'.repeat(40),
      worldSummary: 'pass=1 fail=0', home: HOME,
      results: [
        r('landing-view', 'PASS'),
        r('chat-reply', 'FAIL', `read ${HOME}/x`),
        r('voice-deep-link', 'NOTRUN', 'a | b'),
      ],
    });

    expect(body).toContain('### devbox/verify: failure');
    expect(body).toContain('| Journey | Result | Detail |');
    for (const id of ['landing-view', 'chat-reply', 'voice-deep-link']) expect(body).toContain(`\`${id}\``);
    expect(body).not.toContain(HOME);
    expect(body).toContain('~/x');
    expect(body).toContain('a \\| b');
  });

  it('takes the comment URL from the last non-empty line', () => {
    expect(commentUrlFrom('posting\nhttps://github.com/acme/eve/pull/7#issuecomment-1\n\n'))
      .toBe('https://github.com/acme/eve/pull/7#issuecomment-1');
  });

  it.each([
    ['empty output', ''],
    ['a trailing warning', 'https://github.com/acme/eve/pull/7#issuecomment-1\nwarning: rate limited\n'],
  ])('throws on %s', (_label, out) => {
    expect(() => commentUrlFrom(out)).toThrow();
  });
});

describe('devboxverify/nightly.js', () => {
  const { classify, summaryOf, formatRecord, parseRecords, renderStatusPage } = require('../../devboxverify/nightly');
  const line = (s) => s.replace(/\n$/, '');
  const rec = (at, repo, result, summary) =>
    line(formatRecord({ at, repo, result, commit: '0123456789abcdef0123', behind: 0, summary }));

  it.each([
    [{ exitCode: 0 }, 'GREEN'],
    [{ exitCode: 1 }, 'RED'],
    [{ exitCode: 2 }, 'BLOCKED'],
    [{ exitCode: null }, 'BLOCKED'],
    [{ exitCode: 0, timedOut: true }, 'BLOCKED'],
    [{ exitCode: 0, blockedReason: 'fetch failed' }, 'BLOCKED'],
  ])('classifies %o as %s', (input, expected) => {
    expect(classify(input)).toBe(expected);
  });

  it.each([
    ['the SUMMARY line', 'PREFLIGHT\thead\tOK\tabc\nJOURNEY\tx\tPASS\t\nSUMMARY\tpass=7\tfail=0\tblocked=0\tnotrun=0\n',
      'SUMMARY pass=7 fail=0 blocked=0 notrun=0'],
    ['the first failed preflight', 'PREFLIGHT\thead\tOK\tabc\nPREFLIGHT\teve\tFAIL\tstale\nPREFLIGHT\tlive\tFAIL\tport\n',
      'PREFLIGHT eve FAIL stale'],
    ['no summary', 'PREFLIGHT\thead\tOK\tabc\n', 'no summary'],
  ])('summarises with %s', (_label, stdout, expected) => {
    expect(summaryOf(stdout)).toBe(expected);
  });

  it('formats a record with a 12-char commit', () => {
    expect(rec('2026-09-26T03:30:00Z', 'eve', 'GREEN', 'SUMMARY pass=7'))
      .toBe('NIGHT\t2026-09-26T03:30:00Z\teve\tGREEN\t0123456789ab\tbehind=0\tSUMMARY pass=7');
  });

  it('parses NIGHT lines back into the records they came from', () => {
    const lines = [rec('2026-09-25T03:30:00Z', 'relay', 'RED', 'SUMMARY fail=1'),
      rec('2026-09-25T03:31:00Z', 'eve', 'GREEN', 'SUMMARY pass=7')];
    const records = parseRecords(`${lines[0]}\nnightly started\n${lines[1]}\n`);
    expect(records).toHaveLength(2);
    expect(records.map((x) => line(formatRecord(x)))).toEqual(lines);
  });

  describe('renderStatusPage', () => {
    const now = new Date('2026-09-26T08:00:00Z');
    const page = (lines) => renderStatusPage(parseRecords(lines.join('\n') + '\n'), { now });

    it('puts the latest per repo on top, shows RED and escapes fields', () => {
      const html = page([
        rec('2026-09-20T03:31:00Z', 'eve', 'GREEN', 'eve-day20'),
        rec('2026-09-21T03:30:00Z', 'relay', 'GREEN', 'relay-day21'),
        rec('2026-09-22T03:30:00Z', 'relay', 'GREEN', 'relay-day22'),
        rec('2026-09-23T03:30:00Z', 'relay', 'RED', '<script>alert(1)</script>'),
      ]);
      expect(html.indexOf('eve-day20')).toBeLessThan(html.indexOf('relay-day22'));
      expect(html).toContain('RED');
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it('keeps only the last 60 records in the history', () => {
      const lines = Array.from({ length: 62 }, (_, i) =>
        rec(new Date(Date.UTC(2026, 6, 1 + i, 3, 30)).toISOString(), 'relay', 'GREEN', `night-${String(i).padStart(2, '0')}x`));
      const html = page(lines);
      expect(html).not.toContain('night-00x');
      expect(html).not.toContain('night-01x');
      expect(html).toContain('night-02x');
    });
  });
});
