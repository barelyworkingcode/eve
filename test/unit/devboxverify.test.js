const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = '/Users/someone';

describe('devboxverify/main.js', () => {
  const {
    scrub, formatLine, parseArgs, parseWorldSummary, tally,
    parseListenPids, parseCwd, parseLstart,
    eveProcessProblem, liveEveProblem, serviceRowProblem, audioProblem,
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

    it('leaves screen off by default and takes --screen without consuming the next flag', () => {
      expect(parseArgs([], { toolRoot }).screen).toBe(false);
      const args = parseArgs(['--screen', '--post', '7'], { toolRoot });
      expect(args.screen).toBe(true);
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
      ['--screen with a value', ['--screen=1']],
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

  describe('audioProblem', () => {
    const fakeBrowser = (evaluate) => ({
      newPage: jest.fn(async () => ({ evaluate: jest.fn(evaluate), close: jest.fn(async () => {}) })),
      close: jest.fn(async () => {}),
    });

    it.each([
      ['a hanging AudioContext as wedged', () => new Promise(() => {}),
        'new AudioContext() did not return within 0.05s; the host audio stack is wedged (restart coreaudiod)'],
      ['the first line of a thrown error', async () => { throw new Error('boom\nmore'); },
        'new AudioContext() failed: boom'],
      ['nothing for a running AudioContext', async () => 'running', null],
    ])('reports %s and leaves the browser open', async (_label, evaluate, expected) => {
      const browser = fakeBrowser(evaluate);
      expect(await audioProblem(browser, { timeoutMs: 50 })).toBe(expected);
      expect(browser.newPage).toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
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
    [{ exitCode: 1, stdout: 'JOURNEY\tx\tFAIL\td\nSUMMARY\tpass=0\tfail=1\tblocked=0\tnotrun=0\n' }, 'RED'],
    [{ exitCode: 1, stdout: 'PREFLIGHT\tbuild\tFAIL\tbuilt from an older commit\n' }, 'BLOCKED'],
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

function removeScratch(dir) {
  if (dir && dir.startsWith(os.tmpdir()) && dir.length > os.tmpdir().length + 1) fs.rmSync(dir, { recursive: true, force: true });
}

// Area name -> its `journeys:` value ('all', a list, or undefined) from the
// fenced YAML Areas block. Only the `journeys:` field is read.
function areaJourneys(markdown) {
  const block = /```yaml\n([\s\S]*?)```/.exec(markdown)[1];
  const areas = {};
  let area = null;
  let value = null;
  for (const line of block.split('\n')) {
    if (value !== null) value += ` ${line.trim()}`;
    else {
      const key = /^ {2}([\w-]+):\s*$/.exec(line);
      if (key) { area = key[1]; areas[area] = undefined; continue; }
      const field = /^ {4}journeys:\s*(.*)$/.exec(line);
      if (!field) continue;
      value = field[1].trim();
    }
    if (value === 'all' || value.endsWith(']')) {
      areas[area] = value === 'all' ? 'all' : value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
      value = null;
    }
  }
  return areas;
}

describe('devboxverify journey table', () => {
  const { journeys } = require('../../devboxverify/journeys');
  const areas = areaJourneys(fs.readFileSync(path.join(__dirname, '..', '..', 'devboxverify', 'FEATURES.md'), 'utf8'));
  const contractIds = [
    'landing-view', 'world-projects-listed', 'chat-reply', 'open-existing-thread', 'terminal-on-request',
    'task-created-listed', 'voice-deep-link', 'changes-diff', 'file-edit-save', 'passkey-first-enrol',
    'passkey-sign-in', 'agent-sign-in-refused', 'agent-enrol-refused', 'add-browser-in-window',
  ];

  it('holds exactly the contract journeys, each id once', () => {
    const ids = journeys.map(j => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...contractIds].sort());
  });

  it.each(journeys.map(j => [j.id, j]))('%s has a timeout, known areas, and screen true or absent', (_id, j) => {
    expect(j.timeoutMs).toBeGreaterThan(0);
    expect(j.areas.length).toBeGreaterThan(0);
    for (const a of j.areas) expect(Object.keys(areas)).toContain(a);
    expect(!('screen' in j) || j.screen === true).toBe(true);
  });

  it('agrees with every Areas journeys list in both directions', () => {
    const listed = Object.entries(areas).filter(([, declared]) => declared !== 'all');
    expect(listed.length).toBeGreaterThan(0);
    for (const [area, declared] of listed) {
      const tagged = journeys.filter(j => j.areas.includes(area)).map(j => j.id).sort();
      expect({ area, journeys: declared && [...declared].sort() }).toEqual({ area, journeys: tagged });
    }
  });

  it('marks only add-browser-in-window as screen and only the two passkey journeys as fixtures', () => {
    expect(journeys.filter(j => j.screen).map(j => j.id)).toEqual(['add-browser-in-window']);
    expect(journeys.filter(j => j.fixture).map(j => j.id).sort()).toEqual(['passkey-first-enrol', 'passkey-sign-in']);
  });

  it('runs in the contract order: fixtures, agent-enrol-refused, 1-9, agent-sign-in-refused, add-browser-in-window', () => {
    const { orderJourneys } = require('../../devboxverify/main');
    expect(orderJourneys(journeys, { screen: true }).run.map(j => j.id)).toEqual([
      'passkey-first-enrol', 'passkey-sign-in', 'agent-enrol-refused',
      'landing-view', 'world-projects-listed', 'chat-reply', 'open-existing-thread', 'terminal-on-request',
      'task-created-listed', 'voice-deep-link', 'changes-diff', 'file-edit-save',
      'agent-sign-in-refused', 'add-browser-in-window',
    ]);
  });
});

describe('devboxverify/main.js run plan and owner reset', () => {
  const {
    JOURNEY_BUDGET_MS, orderJourneys, journeyTimeout, pinnedDataDir, liveDataDir, authStatusProblem, ownerResetPaths,
    relayAuditRows, serviceLogReader,
  } = require('../../devboxverify/main');
  const ids = list => list.map(j => j.id);
  const mixed = [{ id: 's', screen: true }, { id: 'a' }, { id: 'f1', fixture: true }, { id: 'b' }, { id: 'f2', fixture: true }];

  it('runs fixtures first and screen journeys last with --screen', () => {
    const { run, skipped } = orderJourneys(mixed, { screen: true });
    expect(ids(run)).toEqual(['f1', 'f2', 'a', 'b', 's']);
    expect(skipped).toEqual([]);
  });

  it('skips screen journeys without --screen', () => {
    const { run, skipped } = orderJourneys(mixed, { screen: false });
    expect(ids(run)).toEqual(['f1', 'f2', 'a', 'b']);
    expect(ids(skipped)).toEqual(['s']);
  });

  it('pins the contract constant JOURNEY_BUDGET_MS at 480 s', () => {
    expect(JOURNEY_BUDGET_MS).toBe(480000);
  });

  it.each([
    ['the journey timeout while the budget lasts', 0, 30000],
    ['what is left of the budget', 470000, 10000],
    ['exactly 1000 ms left', 479000, 1000],
    ['null under 1000 ms left', 479001, null],
    ['null once the budget is overspent', 500000, null],
  ])('journeyTimeout gives %s', (_label, spentMs, expected) => {
    expect(journeyTimeout(30000, spentMs, 480000)).toBe(expected);
  });

  describe('pinnedDataDir', () => {
    const dataDir = `${HOME}/.local/state/eve-verify/data`;
    const header = 'ID          NAME        COMMAND                    URL                    AUTOSTART  CAPABILITIES  STATE';
    const row = (id, args) => `${id}  eve verify  node server.js ${args}  http://localhost:3100  yes  frontend  running`;

    it('reads the --data dir from the eve-verify row', () => {
      const list = [header, row('eve', '--data /srv/live/data'), row('eve-verify', `--data ${dataDir}`)].join('\n');
      expect(pinnedDataDir(list)).toBe(dataDir);
    });

    it.each([
      ['a row without --data', row('eve-verify', '')],
      ['--data only on the eve row', row('eve', `--data ${dataDir}`)],
    ])('is null for %s', (_label, line) => {
      expect(pinnedDataDir(`${header}\n${line}\n`)).toBeNull();
    });
  });

  describe('liveDataDir', () => {
    const header = 'ID          NAME        COMMAND                    URL                    AUTOSTART  CAPABILITIES  STATE';
    const row = args => `eve  eve  node server.js ${args}  http://localhost:3000  yes  frontend  running`;

    it.each([
      ['an absolute --data on the eve row', row('--data /srv/live/data'), null, '/srv/live/data'],
      ['a relative --data against the live cwd', row('--data state'), '/srv/acme/eve', '/srv/acme/eve/state'],
      ['<cwd>/data without --data', row(''), '/srv/acme/eve', '/srv/acme/eve/data'],
      ['<cwd>/data without an eve row', '', '/srv/acme/eve', '/srv/acme/eve/data'],
      ['null with neither', row(''), null, null],
    ])('gives %s', (_label, line, cwd, expected) => {
      expect(liveDataDir(`${header}\n${line}\n`, cwd)).toBe(expected);
    });
  });

  it.each([
    [{ enrolled: false }],
    [{ enrolled: true, authenticated: false }],
    [{ enrolled: true, authenticated: true, trusted: false }],
  ])('authStatusProblem passes an untrusted status %o', (status) => {
    expect(authStatusProblem(status)).toBeNull();
  });

  it('authStatusProblem reports a trusted loopback', () => {
    expect(authStatusProblem({ enrolled: true, authenticated: true, trusted: true }))
      .toContain('EVE_DISABLE_SUBNET_BYPASS=1');
  });

  describe('ownerResetPaths', () => {
    const dir = '/srv/acme/eve-verify/data';

    it('names exactly auth.json and sessions.json in the pinned dir', () => {
      expect(ownerResetPaths(dir, { liveDataDir: '/srv/acme/eve/data' }).sort())
        .toEqual([`${dir}/auth.json`, `${dir}/sessions.json`]);
    });

    it.each([
      ['no pinned dir', null, {}],
      ['a relative dir', 'data', {}],
      ['a dir that climbs out', '/srv/acme/x/../data', {}],
      ['the live eve data dir', '/srv/acme/data', { liveDataDir: '/srv/acme/eve/../data' }],
    ])('refuses %s', (_label, d, opts) => {
      expect(() => ownerResetPaths(d, opts)).toThrow();
    });
  });

  it('relayAuditRows keeps rows on the path since the mark and skips the rest', () => {
    const want = '/eve/enrolment/consume';
    const ev = (ts, p) => JSON.stringify({
      ts, event: 'control_decision', actor: { cred_id: 'launch:service:eve-verify' }, method: 'POST', path: p, outcome: 'ok',
    });
    const jsonl = [ev('2026-09-27T03:29:59Z', want), 'not json', ev('2026-09-27T03:30:05Z', '/eve/other'),
      ev('2026-09-27T03:30:10Z', want), ''].join('\n');
    const rows = relayAuditRows(jsonl, { path: want, sinceMs: Date.parse('2026-09-27T03:30:00Z') });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ credId: 'launch:service:eve-verify', method: 'POST', path: want, outcome: 'ok' });
  });

  it('serviceLogReader returns what follows the mark, and a shrunk file from 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-log-'));
    try {
      const file = path.join(dir, 'eve-verify.log');
      fs.writeFileSync(file, 'before the mark\n');
      const log = serviceLogReader(file);
      const mark = await log.mark();
      fs.appendFileSync(file, 'Login finish failed\n');
      expect(await log.since(mark)).toBe('Login finish failed\n');
      fs.writeFileSync(file, 'rotated\n');
      expect(await log.since(mark)).toBe('rotated\n');
    } finally {
      removeScratch(dir);
    }
  });
});

describe('devboxverify/journey-kit.js parseAgentAttempt', () => {
  const { parseAgentAttempt } = require('../../devboxverify/journey-kit');
  const echo = `$ a=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/sessions); printf '%s_%s signin %s\\n' EVE NEG "$a"`;

  it('takes the last line for the gate, past an echoed command', () => {
    expect(parseAgentAttempt(`EVE_NEG signin 200 200\n${echo}\nEVE_NEG signin 401 400\n${echo}\n`, 'signin').codes)
      .toEqual([401, 400]);
  });

  it('keeps the body after the codes and reads 000 as 0', () => {
    const got = parseAgentAttempt('EVE_NEG enrol 403 {"error":"Enrollment is not open"}\n', 'enrol');
    expect(got.codes).toEqual([403]);
    expect(got.rest).toContain('Enrollment is not open');
    expect(parseAgentAttempt('EVE_NEG signin 000 000\n', 'signin').codes).toEqual([0, 0]);
  });

  it.each([
    ['only the echoed command', echo],
    ['another gate', 'EVE_NEG enrol 403 x\n'],
    ['no output', ''],
  ])('returns null for %s', (_label, text) => {
    expect(parseAgentAttempt(text, 'signin')).toBeNull();
  });
});

describe('devboxverify/screen.js', () => {
  const { createScreen, presenceOutcome, dialogDetail, shellQuote } = require('../../devboxverify/screen');

  it.each([[0, 'answered'], [1, 'no-prompt'], [3, 'refused'], [2, 'error'], [5, 'error'], [null, 'error']])(
    'maps helper exit %p to %s', (code, state) => {
      expect(presenceOutcome(code)).toBe(state);
    });

  it('dialogDetail reads the DIALOG line only', () => {
    const detail = dialogDetail('noise\nDIALOG\tanswered\trelay presence\n');
    expect(detail).toContain('answered');
    expect(detail).toContain('relay presence');
    expect(detail).not.toContain('noise');
    expect(dialogDetail('noise\n')).toBe('');
  });

  it('shellQuote gives words sh reads back unchanged', () => {
    const argv = ['/opt/relay bin/relay', 'eve', "it's", '$HOME', '`id`', '', 'a;b'];
    const out = execFileSync('sh', ['-c', `printf '%s\\n' ${shellQuote(argv)}`], { encoding: 'utf8' });
    expect(out).toBe(argv.map(a => `${a}\n`).join(''));
  });

  describe('answerPresence', () => {
    let dir;
    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-helper-')); });
    afterEach(() => removeScratch(dir));
    const answer = helperBin => createScreen({ helperBin }).answerPresence({ expect: 'relay.presence', timeoutMs: 5000 });
    const fakeHelper = (body) => {
      const bin = path.join(dir, 'devboxpresence');
      fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return bin;
    };

    it('is never ready and reports no-helper when the helper is missing', async () => {
      const { ready, result } = answer(path.join(dir, 'missing'));
      expect(await ready).toBe(false);
      expect((await result).state).toBe('no-helper');
    });

    it.each([
      ['a helper that says ready and answers', "echo 'devboxpresence: ready' >&2\nprintf 'DIALOG\\tanswered\\tx\\n'\nexit 0", true, 'answered'],
      ['a helper that exits 1 without saying ready', 'exit 1', false, 'no-prompt'],
    ])('with %s', async (_label, body, isReady, state) => {
      const { ready, result } = answer(fakeHelper(body));
      expect(await ready).toBe(isReady);
      expect((await result).state).toBe(state);
    });
  });
});

describe('devboxverify/nightly.js run order', () => {
  const { NIGHTS, relayVerifyArgs } = require('../../devboxverify/nightly');

  it('pins the contract night order: relay api, then eve, then relay screen', () => {
    expect(NIGHTS.map(n => (n.repo === 'relay' ? `relay:${n.phase}` : n.repo))).toEqual(['relay:api', 'eve', 'relay:screen']);
  });

  it.each(['api', 'screen'])('hands relay its %s phase', (phase) => {
    const args = relayVerifyArgs('/srv/relay', phase);
    expect(args[args.indexOf('--phase') + 1]).toBe(phase);
  });
});
