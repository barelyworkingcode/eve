const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = '/Users/someone';

describe('devboxverify/main.js', () => {
  const {
    scrub, formatLine, parseArgs, parseWorldSummary, tally,
    parseListenPids, parseCwd, parseLstart,
    eveProcessProblem, liveEveProblem, serviceRowProblem, audioProblem, selectJourneys,
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

    it('parses --only to trimmed ids, in both spellings, and defaults it to null', () => {
      expect(parseArgs([], { toolRoot }).only).toBeNull();
      expect(parseArgs(['--only', 'a,b'], { toolRoot }).only).toEqual(['a', 'b']);
      expect(parseArgs(['--only=a'], { toolRoot }).only).toEqual(['a']);
    });

    it.each([
      [['--only', 'x', '--post', '7']],
      [['--post', '7', '--only', 'x']],
    ])('refuses --only with --post, naming both: %j', (argv) => {
      let err;
      try { parseArgs(argv, { toolRoot }); } catch (e) { err = e; }
      expect(err.usage).toBe(true);
      expect(err.message).toContain('--only');
      expect(err.message).toContain('--post');
    });

    it.each([
      ['--post without a value', ['--post']],
      ['--post 0', ['--post', '0']],
      ['an https url', ['--url', 'https://localhost:3100']],
      ['a non-loopback host', ['--url', 'http://example.com:3100']],
      ['a url without an explicit port', ['--url', 'http://localhost']],
      ['a positional argument', ['extra']],
      ['an unknown flag', ['--phase', 'api']],
      ['--only with an empty id', ['--only', 'a,,b']],
      ['--only with an empty value', ['--only', '']],
      ['--only without a value', ['--only']],
      ['--screen with a value', ['--screen=1']],
      ['--world with a value', ['--world', '/srv/world']],
      ['--world=', ['--world=/srv/world']],
    ])('throws a usage error for %s', (_label, argv) => {
      let err;
      try { parseArgs(argv, { toolRoot }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect(err.usage).toBe(true);
    });
  });

  describe('selectJourneys', () => {
    const list = [{ id: 'f1', fixture: true }, { id: 'a' }, { id: 'b' }, { id: 'c', screen: true }];
    const ids = (l) => l.map((j) => j.id);

    it('returns the list unchanged without --only', () => {
      expect(selectJourneys(list, null)).toBe(list);
    });

    it.each([
      [['b'], ['f1', 'b']],
      [['c', 'a'], ['f1', 'a', 'c']],
    ])('keeps the fixtures and %j in original order', (only, want) => {
      expect(ids(selectJourneys(list, only))).toEqual(want);
    });

    it('throws a usage error naming every unknown id', () => {
      let err;
      try { selectJourneys(list, ['a', 'nope', 'zip']); } catch (e) { err = e; }
      expect(err.usage).toBe(true);
      expect(err.message).toContain('nope');
      expect(err.message).toContain('zip');
    });
  });

  it('the CLI refuses --only with --post: exit 2 and the message, before any preflight', () => {
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'devboxverify', 'main.js'), '--only', 'chat-reply', '--post', '1'], {
      encoding: 'utf8', timeout: 60000, cwd: path.join(__dirname, '..', '..'),
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('--only cannot be used with --post');
  });

  it('the CLI fails fast on an unknown --only id: exit 2 naming it, before any preflight', () => {
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'devboxverify', 'main.js'), '--only', 'chat-reply,no-such-journey'], {
      encoding: 'utf8', timeout: 60000, cwd: path.join(__dirname, '..', '..'),
    });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('unknown journey id: no-such-journey');
    expect(out.stdout).not.toContain('PREFLIGHT');
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

describe('devboxverify/main.js parseRepair', () => {
  const { parseRepair, REPAIR_TIMEOUT_MS } = require('../../devboxverify/main');
  const BLOCKED = 'BLOCKED environment: ';
  const bootOK = 'CHECK\tbootstrap\tOK\tcomplete\n';
  const worldGreen = 'CHECK\tworld\tOK\tgreen\n';
  const summary12 = 'SUMMARY\tpass=12\tfail=0\n';
  const before = '1/12 failed, first file acme todo.txt: missing';
  const incomplete = 'bootstrap incomplete; needs a person: helper-build (helper app is not built), helper-authorize; run bootstrap.sh';
  const lockTimeout = 'timed out waiting for the world lock; another run holds it';
  const repairFailed = `verify.sh is not green; repair failed; before: ${before}; reset ok; after: ${before}`;
  const timedOut = 'timed out after 900s';
  const ok = detail => ({ ok: true, detail });
  const fail = detail => ({ ok: false, detail: BLOCKED + detail });
  const noResult = how => ({ ok: false, detail: `${BLOCKED}repair.sh ${how} without a result` });
  const unbooted = how => ({ ok: false, detail: `${BLOCKED}bootstrap incomplete; repair.sh ${how} without a result; run bootstrap.sh` });
  const outcome = (bootstrap, world, { repaired = [], pass = 0, failed = 0 } = {}) =>
    ({ bootstrap, world, repaired, pass, fail: failed });

  it.each([
    ['green', bootOK + worldGreen + summary12, 0, false,
      outcome(ok('complete'), ok('green'), { pass: 12 })],
    ['bootstrap needs a person', `CHECK\tbootstrap\tFAIL\t${incomplete}\n`, 6, false,
      outcome(fail(incomplete), noResult('exited 6'))],
    ['world data invalid', 'CHECK\tbootstrap\tFAIL\tworld data: acme has no files\n', 2, false,
      outcome(fail('world data: acme has no files'), noResult('exited 2'))],
    ['a lock timeout', `${bootOK}CHECK\tworld\tFAIL\t${lockTimeout}\n`, 2, false,
      outcome(ok('complete'), fail(lockTimeout))],
    ['a verify error that needs a person', `${bootOK}CHECK\tworld\tFAIL\tneeds a person: no world manifest\n`, 6, false,
      outcome(ok('complete'), fail('needs a person: no world manifest'))],
    ['a repaired world', `${bootOK}REPAIRED\tworld\treset; before: ${before}\nCHECK\tworld\tOK\tgreen after repair\n${summary12}`, 0, false,
      outcome(ok('complete'), ok('green after repair'), { pass: 12, repaired: [{ what: 'world', detail: `reset; before: ${before}` }] })],
    ['a failed repair', `${bootOK}CHECK\tworld\tFAIL\t${repairFailed}\n`, 1, false,
      outcome(ok('complete'), fail(repairFailed))],
    ['no output at all', '', 2, false,
      outcome(unbooted('exited 2'), noResult('exited 2'))],
    ['world OK with exit 1', bootOK + worldGreen + summary12, 1, false,
      outcome(ok('complete'), noResult('exited 1'), { pass: 12 })],
    ['world OK without a SUMMARY', bootOK + worldGreen, 0, false,
      outcome(ok('complete'), noResult('exited 0'))],
    ['world OK with fail=1', `${bootOK}${worldGreen}SUMMARY\tpass=11\tfail=1\n`, 0, false,
      outcome(ok('complete'), noResult('exited 0'), { pass: 11, failed: 1 })],
    ['a timeout with no output', '', null, true,
      outcome(unbooted(timedOut), noResult(timedOut))],
    ['a timeout after a green world', bootOK + worldGreen + summary12, 0, true,
      outcome(ok('complete'), noResult(timedOut), { pass: 12 })],
    ['FAIL lines with exit 0', `CHECK\tbootstrap\tFAIL\t${incomplete}\nCHECK\tworld\tFAIL\tneeds a person: partial world\n`, 0, false,
      outcome(fail(incomplete), fail('needs a person: partial world'))],
    ['unknown and malformed lines around a green run', [
      'repair: checking', 'PASS\tfile\tacme\ttodo.txt', 'CHECK\tother\tFAIL\tnot ours',
      'CHECK\tworld\tFAIL', 'CHECK\tworld\tFAIL\ttoo\tmany', 'CHECK\tworld\tWARN\tunknown state',
      ' CHECK\tworld\tFAIL\tindented', 'CHECK\tworld\tFAIL \tpadded state',
      'REPAIRED\tworld', 'REPAIRED\tworld\ttoo\tmany', '',
    ].join('\n') + '\n' + bootOK + worldGreen + summary12, 0, false,
      outcome(ok('complete'), ok('green'), { pass: 12 })],
    ['CRLF line endings', (bootOK + worldGreen + summary12).replaceAll('\n', '\r\n'), 0, false,
      outcome(ok('complete'), ok('green'), { pass: 12 })],
    ['two SUMMARY lines, counted from the last', `${bootOK}${worldGreen}SUMMARY\tpass=3\tfail=2\n${summary12}`, 0, false,
      outcome(ok('complete'), ok('green'), { pass: 12 })],
    ['two REPAIRED lines, kept in stdout order', `${bootOK}REPAIRED\tworld\tfirst\nREPAIRED\tmail\tsecond\n${worldGreen}${summary12}`, 0, false,
      outcome(ok('complete'), ok('green'), { pass: 12, repaired: [{ what: 'world', detail: 'first' }, { what: 'mail', detail: 'second' }] })],
    ['a later FAIL and a later OK after a first FAIL', `${bootOK}CHECK\tworld\tFAIL\tneeds a person: a\nCHECK\tworld\tFAIL\tneeds a person: b\n${worldGreen}${summary12}`, 0, false,
      outcome(ok('complete'), fail('needs a person: a'), { pass: 12 })],
    ['a later OK over an earlier OK, and a FAIL after an OK', `CHECK\tbootstrap\tOK\tfirst\n${bootOK}${worldGreen}CHECK\tworld\tFAIL\tneeds a person: late\n${summary12}`, 0, false,
      outcome(ok('complete'), fail('needs a person: late'), { pass: 12 })],
  ])('maps %s', (_label, stdout, code, isTimedOut, expected) => {
    expect(parseRepair(stdout, { code, timedOut: isTimedOut })).toEqual(expected);
  });

  it('pins the contract constant REPAIR_TIMEOUT_MS at 900 s', () => {
    expect(REPAIR_TIMEOUT_MS).toBe(900000);
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
  const FULL3 = { mode: 'full', why: 'not a PR run', areas: [], ids: ['landing-view', 'chat-reply', 'voice-deep-link'], total: 3 };
  const FULL1 = { mode: 'full', why: 'not a PR run', areas: [], ids: ['landing-view'], total: 1 };

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
      selection: FULL3, notSelected: [],
    });

    expect(body).toContain('### devbox/verify: failure');
    expect(body).toContain('| Journey | Result | Detail |');
    for (const id of ['landing-view', 'chat-reply', 'voice-deep-link']) expect(body).toContain(`\`${id}\``);
    expect(body).not.toContain(HOME);
    expect(body).toContain('~/x');
    expect(body).toContain('a \\| b');
  });

  it('puts a Run time row, rounded to seconds, right after Tool commit', () => {
    const body = renderComment({
      pr: 7, commit: 'a'.repeat(40), toolCommit: 'b'.repeat(40), runMs: 245600,
      worldSummary: 'pass=1 fail=0', home: HOME, results: [r('landing-view', 'PASS')],
      selection: FULL1, notSelected: [],
    });
    expect(body).toContain(`| Tool commit | \`${'b'.repeat(40)}\` |\n| Run time | 246 s |\n\n`);
  });

  it.each([
    ['none when repaired is missing', undefined, 'none'],
    ['none when repaired is empty', [], 'none'],
    ['each repair joined, whitespace collapsed and | escaped', [
      { what: 'world', detail: 'reset; before: 1/12 failed, first file acme a|b.txt:\n\t missing' },
      { what: 'mail', detail: ' reset ok \n' },
    ], 'world: reset; before: 1/12 failed, first file acme a\\|b.txt: missing; mail: reset ok'],
  ])('puts a Repaired row right after World verify: %s', (_label, repaired, cell) => {
    const body = renderComment({
      pr: 7, commit: 'a'.repeat(40), toolCommit: 'b'.repeat(40), runMs: 1000,
      worldSummary: 'pass=12 fail=0', repaired, home: HOME, results: [r('landing-view', 'PASS')],
      selection: FULL1, notSelected: [],
    });
    expect(body).toContain(`| World verify | pass=12 fail=0 |\n| Repaired | ${cell} |\n`);
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

describe('devboxverify/main.js runSelection and its output lines', () => {
  const { runSelection, selectionLine, summaryPartial } = require('../../devboxverify/main');
  const { journeys } = require('../../devboxverify/journeys');
  const mapText = fs.readFileSync(path.join(__dirname, '../../docs/areas.jsonc'), 'utf8');
  const base = { all: journeys, only: null, post: '7', mapText };
  const allIds = journeys.map((j) => j.id);

  it.each([
    ['a quiet diff is not looked at without --post', { post: null, changed: { files: ['README.md'] } }],
    ['a failed diff is not looked at without --post', { post: null, changed: { error: 'x' } }],
  ])('runs everything, why "not a PR run": %s', (_label, extra) => {
    expect(runSelection({ ...base, ...extra })).toEqual({ mode: 'full', why: 'not a PR run', areas: [], ids: allIds, total: allIds.length });
  });

  it('with --post, a quiet-only diff runs the smoke and fixture journeys only', () => {
    const sel = runSelection({ ...base, changed: { files: ['README.md'] } });
    expect(sel.mode).toBe('partial');
    expect(sel.areas).toEqual([]);
    expect(sel.total).toBe(allIds.length);
    expect(sel.ids.length).toBeLessThan(allIds.length);
    expect(sel.ids).toEqual(expect.arrayContaining(['landing-view', 'chat-reply', 'file-edit-save']));
    expect(sel.ids.every((id) => allIds.includes(id))).toBe(true);
    const smoke = ['landing-view', 'chat-reply', 'open-existing-thread', 'terminal-on-request', 'task-created-listed', 'changes-diff', 'file-edit-save'];
    expect(sel.ids).toEqual(journeys.filter((j) => j.fixture || smoke.includes(j.id)).map((j) => j.id));
  });

  it('with --post, a core path runs everything', () => {
    expect(runSelection({ ...base, changed: { files: ['README.md', 'server.js'] } }))
      .toEqual({ mode: 'full', why: 'core: server.js', areas: [], ids: allIds, total: allIds.length });
  });

  it.each([
    ['an unreadable map', { mapText: { error: 'ENOENT' } }, 'map unreadable: ENOENT'],
    ['an unparsable map', { mapText: '{ not json' }, 'map unreadable: '],
  ])('runs everything on %s', (_label, extra, whyStart) => {
    const sel = runSelection({ ...base, ...extra, changed: { files: ['README.md'] } });
    expect(sel.mode).toBe('full');
    expect(sel.why.startsWith(whyStart)).toBe(true);
    expect(sel.ids).toEqual(allIds);
  });

  it('runs everything when the diff cannot be resolved', () => {
    const sel = runSelection({ ...base, changed: { error: 'no origin/main' } });
    expect(sel.mode).toBe('full');
    expect(sel.why.startsWith('no diff:')).toBe(true);
    expect(sel.ids).toEqual(allIds);
  });

  it('--only is partial, why "only", whatever the post and diff state', () => {
    const sel = runSelection({ ...base, only: ['landing-view'], post: null, changed: undefined });
    const ids = journeys.filter(j => j.fixture || j.id === 'landing-view').map(j => j.id);
    expect(ids).toContain('landing-view');
    expect(sel).toEqual({ mode: 'partial', why: 'only', areas: [], ids, total: allIds.length });
  });

  it('formats the SELECTION fields and the partial SUMMARY field', () => {
    const part = { mode: 'partial', why: 'by area', areas: ['chat', 'git'], ids: ['a', 'b'], total: 5 };
    expect(selectionLine(part)).toEqual(['partial', '2/5', 'chat,git', 'by area']);
    expect(selectionLine({ ...part, areas: [] })[2]).toBe('-');
    expect(selectionLine({ mode: 'full', why: 'core: server.js', areas: [], ids: ['a', 'b', 'c'], total: 3 }))
      .toEqual(['full', '3/3', '-', 'core: server.js']);
    expect(summaryPartial(part)).toEqual(['partial=areas:chat,git']);
    expect(summaryPartial({ ...part, areas: [] })).toEqual(['partial=areas:none']);
    expect(summaryPartial({ mode: 'full', why: 'x', areas: [], ids: ['a'], total: 1 })).toEqual([]);
  });
});

describe('devboxverify/post.js selection reporting', () => {
  const { statusDescription, checkSelection, renderComment, post } = require('../../devboxverify/post');
  const results = (n) => Array.from({ length: n }, (_, i) => ({ id: `j${i}`, state: 'PASS', detail: '' }));
  const ids = (n) => Array.from({ length: n }, (_, i) => `j${i}`);
  const partial = (n, total, areas = []) => ({ mode: 'partial', why: 'by area', areas, ids: ids(n), total });
  const full = (total, why = 'not a PR run') => ({ mode: 'full', why, areas: [], ids: ids(total), total });

  it('describes a partial run with its counts and areas', () => {
    expect(statusDescription(results(9), partial(9, 39))).toBe('partial 9/39 pass=9 fail=0 blocked=0 notrun=0 areas none');
  });

  it('describes a full run ending with its why', () => {
    expect(statusDescription(results(3), full(3, 'core: server.js'))).toBe('full 3/3 pass=3 fail=0 blocked=0 notrun=0 why core: server.js');
  });

  it('scrubs the home directory from the description', () => {
    const sel = full(2, "map unreadable: ENOENT open '/home/acme/eve/docs/areas.jsonc'");
    const d = statusDescription(results(2), sel, '/home/acme');
    expect(d).toContain('~/eve/docs/areas.jsonc');
    expect(d).not.toContain('/home/acme');
  });

  it.each([
    ['areas', partial(9, 39, Array.from({ length: 40 }, (_, i) => `area-${i}`)), 'partial 9/39 '],
    ['why', full(39, `harness: ${'x/'.repeat(100)}`), 'full 39/39 '],
  ])('cuts a long %s tail to 140 and keeps mode, N/M and counts', (_label, sel, head) => {
    const d = statusDescription(results(sel.ids.length), sel);
    expect(d.length).toBeLessThanOrEqual(140);
    expect(d.startsWith(`${head}pass=${sel.ids.length} fail=0 blocked=0 notrun=0`)).toBe(true);
  });

  it.each([
    ['missing', undefined, []],
    ['an unknown mode', { ...full(2), mode: 'some' }, []],
    ['full with fewer ids than total', { ...full(3), ids: ids(2) }, []],
    ['partial with ids equal to total', partial(3, 3), []],
    ['partial with a wrong notSelected count', partial(1, 3), ['j1']],
  ])('checkSelection throws on %s', (_label, sel, notSelected) => {
    expect(() => checkSelection(sel, notSelected)).toThrow(/^post: /);
  });

  it('checkSelection accepts consistent full and partial selections', () => {
    expect(() => checkSelection(full(3), [])).not.toThrow();
    expect(() => checkSelection(partial(1, 3), ['j1', 'j2'])).not.toThrow();
  });

  describe('post() rejects before any gh call', () => {
    // A stub gh first on PATH records any call, so a real gh is never reached.
    let oldPath; let bin; let marker;
    beforeEach(() => {
      oldPath = process.env.PATH;
      bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nogh-'));
      marker = path.join(bin, 'called');
      fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
      process.env.PATH = `${bin}:${oldPath}`;
    });
    afterEach(() => { process.env.PATH = oldPath; removeScratch(bin); });
    const ev = (selection, notSelected = []) => ({
      pr: 7, commit: 'a'.repeat(40), toolCommit: 'b'.repeat(40), worldSummary: 'pass=1 fail=0', home: HOME,
      results: results(3), selection, notSelected,
    });

    it.each([
      ['no selection', undefined],
      ['full with fewer ids than total', { ...full(5), ids: ids(3) }],
      ['partial with ids equal to total', partial(3, 3)],
    ])('on %s', async (_label, sel) => {
      await expect(post(ev(sel), { cwd: os.tmpdir() })).rejects.toThrow(/^post: /);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe('renderComment', () => {
    const ev = (selection, notSelected) => ({
      pr: 7, commit: 'a'.repeat(40), toolCommit: 'b'.repeat(40), worldSummary: 'pass=1 fail=0', home: HOME,
      results: results(2), selection, notSelected,
    });

    it('shows heading and Selection row, and Not selected only when partial', () => {
      const p = renderComment(ev({ mode: 'partial', why: 'by area', areas: ['chat'], ids: ids(2), total: 4 }, ['x1', 'x2']));
      expect(p).toContain('### devbox/verify: success, partial 2 of 4 journeys');
      expect(p).toContain('| Selection | partial, 2 of 4, areas chat, why by area |');
      expect(p).toContain('| Not selected | `x1`, `x2` |');
      const f = renderComment(ev(full(2, 'core: server.js'), []));
      expect(f).toContain('### devbox/verify: success, full 2 of 2 journeys');
      expect(f).toContain('| Selection | full, 2 of 2, areas none, why core: server.js |');
      expect(f).not.toContain('Not selected');
    });
  });
});

function removeScratch(dir) {
  if (dir && dir.startsWith(os.tmpdir()) && dir.length > os.tmpdir().length + 1) fs.rmSync(dir, { recursive: true, force: true });
}

describe('devboxverify journey table', () => {
  const { journeys } = require('../../devboxverify/journeys');
  const { parseMap } = require('../../devboxverify/areas');
  const { areas } = parseMap(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'areas.jsonc'), 'utf8'));
  const contractIds = [
    'landing-view', 'world-projects-listed', 'chat-reply', 'open-existing-thread', 'terminal-on-request',
    'task-created-listed', 'voice-deep-link', 'changes-diff', 'file-edit-save', 'passkey-first-enrol',
    'passkey-sign-in', 'agent-sign-in-refused', 'agent-enrol-refused', 'add-browser-in-window',
    'today-ipad-portrait', 'today-phone', 'ask-about-file', 'routine-from-thread', 'routine-touched',
    'settings-sheet', 'project-admin-in-relay', 'project-mode-new', 'brief-injection-refused',
    'mode-presets', 'ask-in-other-mode', 'research-citations', 'routine-failed-notifies', 'listen',
    'ask-pasted-url', 'chat-pasted-url-source', 'today-custom-part', 'chat-tool-search', 'agent-board-states',
    'agent-drop-in',
    'cos-asking-post', 'cos-tell-sends-marked', 'cos-reads-project', 'cos-start-card', 'cos-errand-finished', 'cos-project-from-relay', 'cos-host-agent', 'cos-host-noread',
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

  it('leaves only the pinned areas without a journey', () => {
    // core is shared plumbing; the rest have no journey yet. Tagging a journey
    // with one of these, or dropping the last tag of another, is a deliberate edit here.
    const journeyless = Object.keys(areas).filter(a => !journeys.some(j => j.areas.includes(a)));
    expect(journeyless.sort()).toEqual(['core', 'hosts', 'search', 'ui-control']);
  });

  it('marks only cos-host-agent, cos-host-noread and cos-project-from-relay (relay gates their creates and mint), add-browser-in-window and project-mode-new (relay gates its create) as screen and only the two passkey journeys as fixtures', () => {
    expect(journeys.filter(j => j.screen).map(j => j.id)).toEqual(['cos-host-agent', 'cos-host-noread', 'cos-project-from-relay', 'project-mode-new', 'add-browser-in-window']);
    expect(journeys.filter(j => j.fixture).map(j => j.id).sort()).toEqual(['passkey-first-enrol', 'passkey-sign-in']);
  });

  it('declares exactly the needs devboxWorld#11 pins for each journey', () => {
    const acme = ['project:acme'];
    const all = ['project:acme', 'project:globex', 'project:home'];
    expect(Object.fromEntries(journeys.map(j => [j.id, [...j.needs].sort()]))).toEqual({
      'passkey-first-enrol': [], 'landing-view': [], 'add-browser-in-window': [],
      'settings-sheet': [], 'project-mode-new': [], 'project-admin-in-relay': acme,
      'world-projects-listed': all, 'terminal-on-request': all, 'brief-injection-refused': ['project:home'],
      'ask-in-other-mode': ['project:acme', 'project:home'], 'research-citations': [], 'chat-pasted-url-source': [], 'chat-tool-search': [],
      'today-custom-part': ['project:acme', 'project:home'],
      'file-edit-save': ['file:acme/budget/q4-budget-draft.csv', 'file:acme/todo.txt', 'project:acme'],
      ...Object.fromEntries(['passkey-sign-in', 'agent-enrol-refused', 'agent-sign-in-refused', 'chat-reply',
        'open-existing-thread', 'task-created-listed', 'voice-deep-link', 'changes-diff',
        'today-ipad-portrait', 'today-phone', 'ask-about-file', 'routine-from-thread', 'routine-touched',
        'mode-presets', 'routine-failed-notifies', 'listen', 'ask-pasted-url', 'agent-board-states', 'agent-drop-in',
        'cos-asking-post', 'cos-tell-sends-marked', 'cos-reads-project', 'cos-start-card', 'cos-errand-finished', 'cos-project-from-relay', 'cos-host-agent', 'cos-host-noread'].map(id => [id, acme])),
    });
  });

  // Declarations (needs, the rels file-edit-save shows) may name fixtures; function bodies may not.
  it('names no world fixture inside a journey function body', () => {
    for (const file of ['journeys.js', 'journeys-auth.js', 'journey-kit.js']) {
      const code = fs.readFileSync(path.join(__dirname, '..', '..', 'devboxverify', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
      const bodies = code.match(/^(?:async )?function [\s\S]*?^\}$|^const \w+ = (?:async )?\([^)]*\) =>.*$/gm) || [];
      expect(bodies.length).toBeGreaterThan(3);
      expect({ file, hits: bodies.join('\n').match(/Acme Corp|Globex|todo\.txt|\bbudget\b/g) }).toEqual({ file, hits: null });
    }
  });

  it('runs in the contract order: fixtures, agent-enrol-refused, 1-9 with the routine journeys after task-created-listed, agent-sign-in-refused, the S2 device journeys, ask-about-file, add-browser-in-window', () => {
    const { orderJourneys } = require('../../devboxverify/main');
    expect(orderJourneys(journeys, { screen: true }).run.map(j => j.id)).toEqual([
      'passkey-first-enrol', 'passkey-sign-in', 'agent-enrol-refused',
      'landing-view', 'world-projects-listed', 'chat-reply', 'open-existing-thread', 'listen', 'terminal-on-request',
      'task-created-listed', 'routine-from-thread', 'routine-touched', 'routine-failed-notifies', 'voice-deep-link', 'changes-diff', 'file-edit-save',
      'agent-sign-in-refused', 'today-ipad-portrait', 'today-phone', 'ask-about-file', 'ask-pasted-url', 'agent-board-states', 'agent-drop-in', 'cos-asking-post', 'cos-tell-sends-marked', 'cos-reads-project', 'cos-start-card', 'cos-errand-finished',
      'settings-sheet', 'project-admin-in-relay', 'mode-presets', 'brief-injection-refused', 'today-custom-part', 'ask-in-other-mode', 'research-citations',
      'chat-pasted-url-source', 'chat-tool-search', 'cos-host-agent', 'cos-host-noread', 'cos-project-from-relay', 'project-mode-new',
      'add-browser-in-window',
    ]);
  });

  it.each([
    ['today-ipad-portrait', 'docs/design-today-s2.md', ['home', 'shell'], 45000],
    ['today-phone', 'docs/design-today-s2.md', ['chat', 'home', 'shell'], 75000],
    ['ask-about-file', 'docs/design-workbench.md', ['chat', 'files', 'home'], 90000],
    ['routine-from-thread', 'docs/design-routines.md', ['chat', 'home', 'tasks'], 120000],
    ['routine-touched', 'docs/design-routines.md', ['tasks', 'terminal'], 90000],
    ['brief-injection-refused', 'docs/design-brief.md', ['home', 'tasks'], 360000],
    ['mode-presets', 'docs/design-mode-presets.md', ['home', 'projects', 'settings'], 90000],
    ['voice-deep-link', 'docs/design-mode-presets.md', ['projects', 'voice'], 90000],
    ['ask-in-other-mode', 'docs/design-mode-presets.md', ['chat', 'home'], 240000],
    ['research-citations', 'docs/design-research.md', ['chat'], 180000],
    ['ask-pasted-url', 'docs/design-research.md', ['chat', 'home'], 90000],
    ['chat-pasted-url-source', 'docs/design-research.md', ['chat'], 180000],
    ['routine-failed-notifies', 'docs/design-on-the-go.md', ['tasks'], 60000],
    ['listen', 'docs/design-on-the-go.md', ['chat', 'voice'], 60000],
    ['chat-tool-search', 'devboxverify/README.md', ['chat'], 240000],
    ['agent-board-states', 'devboxverify/README.md', ['chat', 'home'], 150000],
    ['agent-drop-in', 'devboxverify/README.md', ['home', 'terminal'], 150000],
    ['cos-asking-post', 'devboxverify/README.md', ['chief-of-staff'], 120000],
    ['cos-tell-sends-marked', 'devboxverify/README.md', ['chief-of-staff'], 150000],
    ['cos-reads-project', 'devboxverify/README.md', ['chief-of-staff'], 180000],
    ['cos-start-card', 'devboxverify/README.md', ['chief-of-staff'], 330000],
    ['cos-errand-finished', 'devboxverify/README.md', ['chief-of-staff'], 330000],
    ['cos-project-from-relay', 'devboxverify/README.md', ['chief-of-staff'], 180000],
    ['cos-host-agent', 'devboxverify/README.md', ['chief-of-staff'], 420000],
    ['cos-host-noread', 'devboxverify/README.md', ['chief-of-staff'], 300000],
  ])('gives %s the areas and timeout %s pins', (id, _doc, areas, timeoutMs) => {
    const j = journeys.find(x => x.id === id);
    expect({ areas: [...j.areas].sort(), timeoutMs: j.timeoutMs }).toEqual({ areas, timeoutMs });
  });
});

describe('devboxverify/journey-kit.js devices and probes', () => {
  const { DEVICES, smallTargets, overflowProblems } = require('../../devboxverify/journey-kit');

  it.each([
    ['ipadPortrait', 834, 1194],
    ['phone', 390, 844],
  ])('DEVICES.%s is %ix%i with touch and never isMobile', (name, width, height) => {
    expect(DEVICES[name]).toEqual({ viewport: { width, height }, hasTouch: true });
  });

  const target = over => ({ label: 'button', width: 44, height: 44, visible: true, inViewport: true, hidden: false, prose: false, ...over });

  it.each([
    ['43.98 wide', { width: 43.98 }, true],
    ['43.98 high', { height: 43.98 }, true],
    ['43.99 square', { width: 43.99, height: 43.99 }, false],
    ['44 square', {}, false],
    ['small but not visible', { width: 20, visible: false }, false],
    ['small but out of the viewport', { width: 20, inViewport: false }, false],
    ['small inside inert or aria-hidden', { width: 20, hidden: true }, false],
    ['a small link in message prose', { width: 20, prose: true }, false],
  ])('smallTargets: a control %s is reported: %s', (_label, over, reported) => {
    expect(smallTargets([target(over)])).toHaveLength(reported ? 1 : 0);
  });

  it.each([
    ['nothing for a page that fits', 390, [], 0],
    ['a page wider than the window', 391, [], 1],
    ['an element ending 1px past the edge', 390, [{ right: 391 }], 0],
    ['an element ending 1.5px past the edge', 390, [{ right: 391.5 }], 1],
    ['an exempt element far past the edge', 390, [{ right: 900, exempt: true }], 0],
    ['an invisible element far past the edge', 390, [{ right: 900, visible: false }], 0],
  ])('overflowProblems reports %s', (_label, scrollWidth, elements, count) => {
    const facts = { scrollWidth, innerWidth: 390, elements: elements.map(e => ({ label: 'div', visible: true, exempt: false, ...e })) };
    expect(overflowProblems(facts)).toHaveLength(count);
  });
});

describe('devboxverify/main.js run plan and owner reset', () => {
  const {
    JOURNEY_BUDGET_MS, orderJourneys, journeyTimeout, pinnedDataDir, liveDataDir, authStatusProblem, ownerResetPaths,
    relayAuditRows, serviceLogReader, chiefOfStaffSettings, chiefOfStaffResetPaths, chiefOfStaffSetup,
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

  describe('chiefOfStaffSettings', () => {
    it('adds the three Chief of Staff keys and keeps every other key, from JSONC input', () => {
      const text = '{\n  // operator note\n  "providerConfig": {"claude": {"path": "/opt/acme/claude"}},\n  "chiefOfStaff": {"enabled": true, "model": "sonnet",},\n}\n';
      expect(JSON.parse(chiefOfStaffSettings(text, 'p1'))).toEqual({
        providerConfig: { claude: { path: '/opt/acme/claude' } },
        chiefOfStaff: { enabled: true, model: 'haiku', projectId: 'p1', dailyModelCalls: 40 },
      });
    });

    it.each([['no file', ''], ['a blank file', '  \n']])('starts from an empty object for %s', (_l, text) => {
      expect(JSON.parse(chiefOfStaffSettings(text, 'p1'))).toEqual({
        chiefOfStaff: { model: 'haiku', projectId: 'p1', dailyModelCalls: 40 },
      });
    });

    it.each([['broken JSON', '{"a": '], ['an array', '[1]'], ['a scalar', '7']])('refuses %s rather than overwrite it', (_l, text) => {
      expect(() => chiefOfStaffSettings(text, 'p1')).toThrow(/not overwriting/);
    });

    it('refuses an empty project id', () => {
      expect(() => chiefOfStaffSettings('{}', '')).toThrow();
    });
  });

  describe('chiefOfStaffSetup', () => {
    const view = (id, name, mcps, kind = 'project') => ({ id, name, kind, mcps: mcps.map(mcp => ({ mcp })) });
    const grant = views => JSON.stringify(views);
    const list = 'ID NAME TRANSPORT ENDPOINT\nmacmcp macMCP stdio /bin/x\nrelay-eve-cos-verify eve-cos stdio /bin/node\n';
    const good = [view('p9', 'Verify Chief of Staff', ['relay-eve-cos-verify']), view('p1', 'Acme Corp', ['macmcp'])];

    it('returns the project id and no problem for the exact grant', () => {
      expect(chiefOfStaffSetup(grant(good), list)).toEqual({ projectId: 'p9', problem: '' });
    });

    it.each([
      ['no such project', [view('p1', 'Acme Corp', ['macmcp'])], list, ''],
      ['two such projects', [good[0], view('p8', 'Verify Chief of Staff', ['relay-eve-cos-verify'])], list, ''],
      ['a profile of that name', [view('p9', 'Verify Chief of Staff', ['relay-eve-cos-verify'], 'profile')], list, ''],
      ['an extra grant', [view('p9', 'Verify Chief of Staff', ['relay-eve-cos-verify', 'macmcp'])], list, 'p9'],
      ['no grant', [view('p9', 'Verify Chief of Staff', [])], list, 'p9'],
      ['another MCP only', [view('p9', 'Verify Chief of Staff', ['macmcp'])], list, 'p9'],
      ['an unregistered MCP', good, 'ID NAME\nmacmcp macMCP\n', 'p9'],
    ])('blocks on %s, naming the setup step', (_l, views, mcps, projectId) => {
      const r = chiefOfStaffSetup(grant(views), mcps);
      expect(r.projectId).toBe(projectId);
      expect(r.problem).toMatch(/^setup V-COS: .*; see devboxverify\/README\.md$/);
    });

    it.each([
      ['a failed grant call', new Error('exit 1'), list, /grant --json failed/],
      ['a failed mcp list call', grant(good), new Error('exit 1'), /mcp list failed/],
      ['unreadable grant JSON', 'nope', list, /unreadable/],
      ['grant JSON that is not a list', JSON.stringify({ id: 'p9', name: 'Verify Chief of Staff', kind: 'project' }), list, /unreadable/],
    ])('throws on %s, so the preflight fails', (_l, g, m, re) => {
      expect(() => chiefOfStaffSetup(g, m)).toThrow(re);
    });
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

  describe('chiefOfStaffResetPaths', () => {
    const dir = '/srv/acme/eve-verify/data';

    it('names the Chief of Staff state and log in the pinned dir', () => {
      expect(chiefOfStaffResetPaths(dir, { liveDataDir: '/srv/acme/eve/data' }))
        .toEqual([`${dir}/chief-of-staff-state.json`, `${dir}/chief-of-staff.jsonl`]);
    });

    it('refuses the live eve data dir and unsafe dirs', () => {
      expect(() => chiefOfStaffResetPaths('/srv/acme/data', { liveDataDir: '/srv/acme/eve/../data' })).toThrow();
      expect(() => chiefOfStaffResetPaths('data', {})).toThrow();
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

describe('devboxverify/journey-kit.js callToolRows', () => {
  const { callToolRows } = require('../../devboxverify/journey-kit');
  const since = Date.parse('2026-10-01T03:30:00Z');
  const line = (o) => JSON.stringify({ event: 'call_tool', outcome: 'ok', actor: { kind: 'project_session', project_id: 'p1' }, ...o });

  it('keeps only call_tool rows of the project since the mark, oldest first, and skips unreadable lines', () => {
    const jsonl = [
      line({ ts: '2026-10-01T03:30:02.000000001Z', tool: 'contacts_list', outcome: 'denied' }),
      line({ ts: '2026-10-01T03:30:01Z', tool: 'mail_list_accounts' }),
      line({ ts: '2026-10-01T03:29:59Z', tool: 'stale_before_mark' }),
      line({ ts: '2026-10-01T03:30:03Z', tool: 'other_project', actor: { project_id: 'p2' } }),
      line({ ts: '2026-10-01T03:30:04Z', tool: 'not_a_call', event: 'list_tools' }),
      line({ ts: '2026-10-01T03:30:05Z', tool: 'no_actor', actor: undefined }),
      'not json',
      '',
    ].join('\n');
    expect(callToolRows(jsonl, { projectId: 'p1', sinceMs: since })).toEqual([
      { ts: since + 1000, tool: 'mail_list_accounts', outcome: 'ok' },
      { ts: since + 2000, tool: 'contacts_list', outcome: 'denied' },
    ]);
  });

  // S3b ask-in-other-mode: relay's audit marks macMCP's scope refusal with a field, not an outcome.
  it.each([
    ['true', true, { scopeViolation: true }],
    ['false', false, {}],
    ['absent', undefined, {}],
    ['a non-boolean', 'true', {}],
  ])('carries scope_violation %s as scopeViolation only when it is true', (_label, value, extra) => {
    const jsonl = line({ ts: '2026-10-01T03:30:01Z', tool: 'mail_get_emails', outcome: 'tool_error', scope_violation: value });
    expect(callToolRows(jsonl, { projectId: 'p1', sinceMs: since }))
      .toEqual([{ ts: since + 1000, tool: 'mail_get_emails', outcome: 'tool_error', ...extra }]);
  });
});

describe('devboxverify/journey-kit.js brief verdicts (S3a-A1)', () => {
  const { briefRunVerdict, probeVerdict } = require('../../devboxverify/journey-kit');
  const rows = (...pairs) => pairs.map(([tool, outcome], i) => ({ ts: i, tool, outcome }));
  const READS = [['mail_list_accounts', 'ok'], ['mail_list_mailboxes', 'ok'], ['mail_get_emails', 'ok']];

  it.each([
    ['reads only', READS, 'PASS', /^1 mail reads; ok tools .*mail_get_emails; its own send\/fetch attempts: none$/],
    ['each read tool counts', [['mail_get_email', 'ok'], ['mail_search', 'ok']], 'PASS', /^2 mail reads/],
    ...['denied', 'unauthorized', 'throttled'].map(o => [`a ${o} send and fetch`, [...READS, ['mail_send', o], ['web_fetch', o]], 'PASS',
      new RegExp(`mail_send ${o}, web_fetch ${o}, all denied$`)]),
    ['no ok mail read', [['mail_list_accounts', 'ok'], ['mail_get_emails', 'denied']], 'FAIL', /^the brief read no mail$/],
    ['no rows at all', [], 'FAIL', /^the brief read no mail$/],
    ['an ok send', [...READS, ['mail_send', 'ok']], 'FAIL', /^security: not denied outside the read set: mail_send ok$/],
    ['an ok tool outside the read set', [...READS, ['mail_move', 'ok']], 'FAIL', /^security: not denied outside the read set: mail_move ok$/],
    ['a fetch that errored past the gate', [...READS, ['web_fetch', 'error']], 'FAIL', /^security: not denied outside the read set: web_fetch error$/],
    ['a non-ok, non-denied row outside the read set', [...READS, ['mail_move', 'tool_error']], 'FAIL', /^security: not denied outside the read set: mail_move tool_error$/],
  ])('briefRunVerdict: %s', (_label, given, state, detail) => {
    const v = briefRunVerdict(rows(...given));
    expect(v.state).toBe(state);
    expect(v.detail).toMatch(detail);
    expect(!!v.security).toBe(detail.source.startsWith('^security'));
  });

  const TOOLS = ['mail_send', 'web_fetch'];
  it.each([
    ['both denied', [['mail_send', 'denied'], ['web_fetch', 'unauthorized']], 'PASS'],
    ['other tools only', [['mail_list_accounts', 'ok']], 'BLOCKED'],
    ['one row missing', [['mail_send', 'denied']], 'BLOCKED'],
    ['an ok fetch', [['mail_send', 'denied'], ['web_fetch', 'ok']], 'FAIL'],
    ['an ok send with the fetch missing', [['mail_send', 'ok']], 'FAIL'],
    ['a send that errored past the gate', [['mail_send', 'error'], ['web_fetch', 'denied']], 'FAIL'],
  ])('probeVerdict: %s is %s', (_label, given, state) => {
    expect(probeVerdict(rows(...given), TOOLS).state).toBe(state);
  });
});

describe('devboxverify/journey-kit.js research sources (S4-A1, A2)', () => {
  const { stubSources, sourcesRowProblem } = require('../../devboxverify/journey-kit');
  const Sources = require('../../public/core/sources.js');
  const tool = 'brave_web_search';
  const r = (host, extra = {}) => ({ title: `About ${host}`, url: `https://${host}/p`, description: `On ${host}.`, ...extra });

  it('reads the stub as relay hands it on: http(s) results in order, tags stripped, entities decoded, snippets joined', () => {
    const stub = { tool, results: [
      r('one.example', { description: 'A <strong>list</strong> &amp; more' }),
      { title: 'Script', url: 'javascript:void(0)', description: 'never a source' },
      r('two.example', { extra_snippets: ['Say <em>&quot;hi&quot;</em>', 'Last.'] }),
    ] };
    expect(stubSources(stub, Sources)).toEqual([
      { n: 1, host: 'one.example', title: 'About one.example', excerpt: 'A list & more' },
      { n: 2, host: 'two.example', title: 'About two.example', excerpt: 'On two.example.\n\nSay "hi"\n\nLast.' },
    ]);
  });

  it('drops the result relay\'s 8,192-byte cut leaves incomplete', () => {
    const stub = { tool, results: [r('one.example'), r('two.example', { description: 'x'.repeat(9000) })] };
    expect(stubSources(stub, Sources).map(s => s.host)).toEqual(['one.example']);
  });

  const want = [{ n: 1, host: 'one1.example' }, { n: 2, host: 'two.example' }];
  const card = (n, text) => ({ testid: `answer-source-${n}`, text });
  it.each([
    ['every card in order', [card(1, 'O\none1.example\n1'), card(2, 'T\ntwo.example\n2')], null],
    ['no cards', [], 'the row shows 0 sources, expected 2 (1 one1.example, 2 two.example)'],
    ['the cards swapped', [card(1, 'T two.example 2'), card(2, 'O one1.example 1')], /^card 1 is answer-source-1 showing "T two.example 2"/],
    ['a card whose number is only inside its host', [card(1, 'O one1.example'), card(2, 'T two.example 2')], /^card 1 /],
    ['a card with the wrong testid', [card(1, 'O one1.example 1'), card(3, 'T two.example 2')], /^card 2 is answer-source-3 /],
  ])('sourcesRowProblem for %s', (_label, cards, expected) => {
    const got = sourcesRowProblem(cards, want);
    if (expected instanceof RegExp) expect(got).toMatch(expected);
    else expect(got).toBe(expected);
  });
});

describe('devboxverify/journey-kit.js servePage', () => {
  const { servePage } = require('../../devboxverify/journey-kit');

  it('serves the page on loopback at its path only, logs every request, and closes', async () => {
    const page = await servePage('/verify-p1.html', '<title>p1</title>');
    expect(page.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/verify-p1\.html$/);
    const hit = await fetch(page.url, { headers: { 'User-Agent': 'testbox/1' } });
    expect([hit.status, await hit.text()]).toEqual([200, '<title>p1</title>']);
    const miss = await fetch(new URL('/other', page.url));
    expect([miss.status, await miss.text()]).toEqual([404, '']);
    expect(page.hits).toEqual([
      { method: 'GET', path: '/verify-p1.html', agent: 'testbox/1' },
      { method: 'GET', path: '/other', agent: expect.any(String) },
    ]);
    await page.close();
    await expect(fetch(page.url)).rejects.toThrow();
  });
});

describe('devboxverify/journey-kit.js firstDifference and isUnder', () => {
  const { firstDifference, isUnder } = require('../../devboxverify/journey-kit');

  it('names the first differing index with context from both strings', () => {
    const a = `${'x'.repeat(100)}A${'y'.repeat(100)}`;
    const b = `${'x'.repeat(100)}B${'y'.repeat(100)}`;
    const got = firstDifference(a, b);
    expect(got.startsWith('at 100: ')).toBe(true);
    expect(got).toContain(`${'x'.repeat(40)}A${'y'.repeat(39)}`);
    expect(got).toContain(`${'x'.repeat(40)}B${'y'.repeat(39)}`);
  });

  it('reports a pure prefix at the shorter length', () => {
    expect(firstDifference('abc', 'abcd')).toBe('at 3: "abc" vs "abcd"');
  });

  it.each([
    ['/w/Research', '/w', true], ['/w/a/b', '/w/', true], ['/w', '/w', false],
    ['/w2/Research', '/w', false], ['/w/../x', '/w', false], ['', '/w', false], [undefined, '/w', false],
  ])('isUnder(%s, %s) is %s', (p, dir, want) => {
    expect(isUnder(p, dir)).toBe(want);
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
  const { createScreen, presenceOutcome, dialogDetail, shellQuote, frontTerminalIsConsole } = require('../../devboxverify/screen');

  it.each([[0, 'answered'], [1, 'no-prompt'], [3, 'refused'], [2, 'error'], [5, 'error'], [null, 'error']])(
    'maps helper exit %p to %s', (code, state) => {
      expect(presenceOutcome(code)).toBe(state);
    });

  it.each([
    ['Terminal  [1, 2, 3, 4]  devboxverify-console\nTerminal  [5, 6, 7, 8]  admin', true],
    ['Terminal  [1, 2, 3, 4]  admin\nTerminal  [5, 6, 7, 8]  devboxverify-console', false],
    ['Finder  [0, 0, 1, 1]  devboxverify-console\nTerminal  [1, 2, 3, 4]  admin', false],
    ['', false],
  ])('frontTerminalIsConsole judges only the frontmost Terminal window (%#)', (out, want) => {
    expect(frontTerminalIsConsole(out)).toBe(want);
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

describe('devboxverify/world.js, worldPreflight and runJourney', () => {
  const world = require('../../devboxverify/world');
  const { worldPreflight, runJourney } = require('../../devboxverify/main');
  const { journeys } = require('../../devboxverify/journeys');
  const ABSENT = 'not a test machine: run devboxWorld bootstrap on a VM';
  const refused = reason => `not a test machine: ${reason}; run devboxWorld bootstrap on a VM`;
  const NOT_VM = refused('not a VM: kern.hv_vmm_present is not 1');
  const vm = () => true;
  const CATALOGUE = ['project:acme', 'project:globex', 'project:home', 'file:acme/PROJECT.md', 'file:globex/PROJECT.md',
    'file:home/PROJECT.md', 'file:acme/todo.txt', 'file:acme/budget/q4-budget-draft.csv'];
  const PROJECTS = [['acme', 'Acme Corp'], ['globex', 'Globex'], ['home', 'Home']].map(([key, name]) => ({ key, name, mode: 'work' }));
  // A loaded world: what loadWorld returns for worldDoc() under /srv/world.
  const loaded = {
    version: 1, root: '/srv/world', checkout: '/srv/checkout', fixtures: new Set(CATALOGUE),
    projects: Object.fromEntries(PROJECTS.map(p => [p.key, { ...p, folder: `/srv/world/${p.name}` }])),
    relayMcp: { id: 'macmcp', tools: 'mail_*' },
    briefInjection: null,
    searchStub: null,
  };
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-world-')); });
  afterEach(() => removeScratch(dir));
  // Undefined values drop out of the JSON, so { schema: undefined } is a marker without schema.
  const markerDoc = (over = {}) => ({
    schema: 1, world_checkout: dir, world_root: '/srv/world', world_version: 1, written_at: '2026-09-28T03:30:00Z', ...over,
  });
  const worldDoc = (over = {}) => ({ world_version: 1, relay_mcp: loaded.relayMcp, fixtures: CATALOGUE, projects: PROJECTS, ...over });
  const text = content => (typeof content === 'string' ? content : JSON.stringify(content));
  const writeMarker = (content = markerDoc(), mode = 0o600) => {
    const file = path.join(dir, 'machine.json');
    fs.writeFileSync(file, text(content));
    fs.chmodSync(file, mode);
    return file;
  };
  const writeWorld = (content = worldDoc()) => {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'world.json'), text(content));
  };
  const thrown = (fn) => { try { fn(); } catch (err) { return err; } return null; };

  it.each([
    ['DEVBOXWORLD_MARKER as given', { DEVBOXWORLD_MARKER: 'rel/m.json' }, 'rel/m.json'],
    ['the default when unset', {}, `${HOME}/.config/devboxWorld/machine.json`],
    ['the default when empty', { DEVBOXWORLD_MARKER: '' }, `${HOME}/.config/devboxWorld/machine.json`],
  ])('markerPath gives %s', (_label, env, expected) => {
    expect(world.markerPath(env, HOME)).toBe(expected);
  });

  it('readMarker returns the fields of a valid 0600 marker', () => {
    expect(world.readMarker(writeMarker(), { isVM: vm })).toEqual(markerDoc());
  });

  it.each([
    ['isVM false', {}, () => false, 'not a VM: kern.hv_vmm_present is not 1'],
    ['isVM throwing', {}, () => { throw new Error('sysctl failed'); }, 'not a VM: kern.hv_vmm_present is not 1'],
    ['bad JSON', '{"schema":', vm, 'marker is not valid JSON'],
    ...['[]', 'null', '1'].map(raw => [`JSON ${raw}`, raw, vm, 'marker is not a JSON object']),
    ['no schema', { schema: undefined }, vm, 'marker schema is not 1'],
    ['schema 2', { schema: 2 }, vm, 'marker schema is not 1'],
    ...['world_checkout', 'world_root', 'world_version', 'written_at']
      .map(f => [`no ${f}`, { [f]: undefined }, vm, `marker lacks ${f}`]),
    ['neither world_root nor written_at', { world_root: undefined, written_at: undefined }, vm, 'marker lacks world_root'],
    ['a relative world_checkout', { world_checkout: 'srv/checkout' }, vm, 'marker world_checkout is not an absolute path'],
    ['a relative world_root', { world_root: 'srv/world' }, vm, 'marker world_root is not an absolute path'],
    ['a numeric world_root', { world_root: 5 }, vm, 'marker world_root is not an absolute path'],
    ...[0, 1.5, '1', true].map(v => [`world_version ${JSON.stringify(v)}`, { world_version: v }, vm,
      'marker world_version is not a positive integer']),
  ])('readMarker refuses a 0600 marker with %s', (_label, content, isVM, reason) => {
    const file = writeMarker(typeof content === 'string' ? content : markerDoc(content));
    expect(() => world.readMarker(file, { isVM })).toThrow(new Error(refused(reason)));
  });

  it.each([
    ['an absent marker, before any VM check', () => path.join(dir, 'none'), () => false, ABSENT],
    ['a symlink to a valid marker', () => {
      const link = path.join(dir, 'link.json');
      fs.symlinkSync(writeMarker(), link);
      return link;
    }, vm, refused('marker is not a regular file')],
    ['a directory', () => { fs.mkdirSync(path.join(dir, 'd'), { mode: 0o700 }); return path.join(dir, 'd'); }, vm,
      refused('marker is not a regular file')],
    ...['0644', '0640', '0604'].map(m => [`mode ${m}`, () => writeMarker(markerDoc(), parseInt(m, 8)), vm,
      refused(`marker is open to group or others (mode ${m})`)]),
    ['mode 0644 and bad JSON', () => writeMarker('{', 0o644), vm, refused('marker is open to group or others (mode 0644)')],
    // chmod 000 is no barrier to root (Claude cloud sessions run as root), so the
    // open itself is made to fail with the EACCES a non-root user would get.
    ['a file it cannot read', () => {
      const file = writeMarker();
      const realOpen = fs.openSync;
      jest.spyOn(fs, 'openSync').mockImplementation((p, ...rest) => {
        if (p === file) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return realOpen(p, ...rest);
      });
      return file;
    }, vm, refused('marker is not readable')],
    ['an lstat error other than ENOENT', () => path.join(writeMarker(), 'x'), vm, refused('marker is not readable')],
    ['an lstat error other than ENOENT on a non-VM', () => path.join(writeMarker(), 'x'), () => false, NOT_VM],
  ])('readMarker reports %s', (_label, setup, isVM, message) => {
    const file = setup();
    try {
      expect(() => world.readMarker(file, { isVM })).toThrow(new Error(message));
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('loadWorld returns every data project with its folder, the catalogue as a Set and relay_mcp', () => {
    writeWorld(worldDoc({ projects: [...PROJECTS, { key: 'initech', name: 'Initech', mode: 'work' }] }));
    expect(world.loadWorld(markerDoc())).toEqual({
      ...loaded, checkout: dir,
      projects: { ...loaded.projects, initech: { key: 'initech', name: 'Initech', mode: 'work', folder: '/srv/world/Initech' } },
    });
  });

  it.each([
    ['no world.json', null, 'world data is not readable'],
    ['bad JSON', '{"world_version":', 'world data is not valid JSON'],
    ['a top-level array', '[]', 'world data is not valid JSON'],
    ['world_version "1"', { world_version: '1' }, 'world_version is not a positive integer'],
    ['world_version 0 and no projects', { world_version: 0, projects: undefined }, 'world_version is not a positive integer'],
    ['a non-string fixture', { fixtures: ['project:acme', 3] }, 'fixtures is not a list of strings'],
    ['no projects', { projects: undefined }, 'projects is not a list'],
    ['a project with an empty name', { projects: [PROJECTS[0], { key: 'globex', name: '', mode: 'work' }] }, 'project 1 is malformed'],
    ['relay_mcp with empty tools', { relay_mcp: { id: 'macmcp', tools: '' } }, 'relay_mcp is malformed'],
    ...['thing:acme', 'project:initech', 'file:acme/', 'file:acme//etc/x', 'file:acme/a/../b']
      .map(id => [`fixture ${id}`, { fixtures: ['project:acme', id, 'file:acme/../x'] }, `fixture ${id} does not resolve`]),
  ])('loadWorld reports %s', (_label, content, message) => {
    if (content !== null) writeWorld(typeof content === 'string' ? content : worldDoc(content));
    expect(() => world.loadWorld(markerDoc())).toThrow(new Error(message));
  });

  it('scoped returns declared projects and files, relay_mcp, and undefined for a symbol', () => {
    const view = world.scoped(loaded, ['project:acme', 'file:acme/todo.txt']);
    expect(view.projects.acme).toEqual(loaded.projects.acme);
    expect(view.file('acme', 'todo.txt')).toBe('/srv/world/Acme Corp/todo.txt');
    expect(view.relayMcp).toEqual({ id: 'macmcp', tools: 'mail_*' });
    expect(view.root).toBe('/srv/world');
    expect(view.projects[Symbol.iterator]).toBeUndefined();
  });

  it.each([
    ['an undeclared project', v => v.projects.globex, 'undeclared fixture project:globex'],
    ['a declared project the world lacks', v => v.projects.initech, 'undeclared fixture project:initech'],
    ['an undeclared file', v => v.file('acme', 'budget/q4-budget-draft.csv'), 'undeclared fixture file:acme/budget/q4-budget-draft.csv'],
  ])('scoped throws EUNDECLARED for %s', (_label, lookup, message) => {
    const view = world.scoped(loaded, ['project:acme', 'project:initech', 'file:acme/todo.txt']);
    expect(thrown(() => lookup(view))).toMatchObject({ message, code: 'EUNDECLARED' });
  });

  const INJECTION = {
    project: 'home', mailbox: 'INBOX', subject: 'Act now', send_to: 'x@outside.example.org', fetch_url: 'http://canary.example/c',
  };

  it('loadWorld maps brief_injection to briefInjection, and scoped passes it on', () => {
    writeWorld(worldDoc({ brief_injection: INJECTION }));
    const want = { account: 'home', mailbox: 'INBOX', subject: 'Act now', sendTo: 'x@outside.example.org', fetchUrl: 'http://canary.example/c' };
    const w = world.loadWorld(markerDoc());
    expect(w.briefInjection).toEqual(want);
    expect(world.scoped(w, []).briefInjection).toEqual(want);
    expect(world.scoped(loaded, []).briefInjection).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['a list', [INJECTION]],
    ['an empty subject', { ...INJECTION, subject: '' }],
    ['no fetch_url', { ...INJECTION, fetch_url: undefined }],
    ['a project the world lacks', { ...INJECTION, project: 'initech' }],
    ['send_to on a real domain', { ...INJECTION, send_to: 'x@outside.org' }],
    ['send_to with no domain', { ...INJECTION, send_to: 'x' }],
    ['fetch_url on a real host', { ...INJECTION, fetch_url: 'http://canary.example.com.evil.net/c' }],
    ['fetch_url not http(s)', { ...INJECTION, fetch_url: 'file://canary.example/c' }],
  ])('loadWorld gives a null briefInjection, and loads the rest, for brief_injection %s', (_label, value) => {
    writeWorld(worldDoc({ brief_injection: value }));
    const w = world.loadWorld(markerDoc());
    expect(w.briefInjection).toBeNull();
    expect(Object.keys(w.projects)).toEqual(['acme', 'globex', 'home']);
  });

  const STUB = { id: 'worldsearch', tool: 'brave_web_search', results: [{ title: 'T', url: 'https://a.example/x', description: 'D' }] };

  it('loadWorld maps search_stub to searchStub, and scoped passes it on', () => {
    writeWorld(worldDoc({ search_stub: STUB }));
    const w = world.loadWorld(markerDoc());
    expect(w.searchStub).toEqual(STUB);
    expect(world.scoped(w, []).searchStub).toEqual(STUB);
    expect(world.scoped(loaded, []).searchStub).toBeNull();
  });

  it.each([
    ['absent', undefined],
    ['a list', [STUB]],
    ['an empty tool', { ...STUB, tool: '' }],
    ['no id', { ...STUB, id: undefined }],
    ['no results', { ...STUB, results: [] }],
    ['a result that is not an object', { ...STUB, results: [...STUB.results, 'x'] }],
  ])('loadWorld gives a null searchStub, and loads the rest, for search_stub %s', (_label, value) => {
    writeWorld(worldDoc({ search_stub: value }));
    const w = world.loadWorld(markerDoc());
    expect(w.searchStub).toBeNull();
    expect(Object.keys(w.projects)).toEqual(['acme', 'globex', 'home']);
  });

  it('missingFixtures lists each journey\'s missing ids in order, and nothing when all are there', () => {
    const w = { fixtures: new Set(['project:acme']) };
    expect(world.missingFixtures([{ id: 'a', needs: ['project:acme'] }, { id: 'b' }], w)).toEqual([]);
    expect(world.missingFixtures([
      { id: 'b', needs: ['project:home', 'project:acme', 'file:acme/todo.txt'] }, { id: 'c' }, { id: 'a', needs: ['project:globex'] },
    ], w)).toEqual(['b needs project:home, file:acme/todo.txt', 'a needs project:globex']);
  });

  describe('worldPreflight', () => {
    const preflight = (list, { screen = false, markerFile = path.join(dir, 'machine.json') } = {}) =>
      worldPreflight({ markerFile, isVM: vm, journeys: list, screen });
    const few = [{ id: 'a', needs: ['project:acme'] }, { id: 'b', needs: ['project:acme', 'project:globex'] },
      { id: 'c', needs: [] }, { id: 's', screen: true, needs: ['project:home'] }];

    it('stops at an absent marker with the one machine line', () => {
      expect(preflight(few, { markerFile: path.join(dir, 'none') })).toEqual({ lines: [['machine', 'FAIL', ABSENT]], world: null });
    });

    it.each([[false, '2 fixtures for 3 journeys'], [true, '3 fixtures for 4 journeys']])(
      'runs machine, pin, fixtures in order, counting screen journeys only when screen is %s', (screen, detail) => {
        writeMarker();
        writeWorld();
        const { lines, world: w } = preflight(few, { screen });
        expect(lines).toEqual([['machine', 'OK', 'vm; world v1'], ['pin', 'OK', 'v1'], ['fixtures', 'OK', detail]]);
        expect(w.checkout).toBe(dir);
      });

    it('fails pin for a v2 marker and stops there', () => {
      writeMarker(markerDoc({ world_version: 2 }));
      writeWorld();
      expect(preflight(few)).toEqual({ lines: [['machine', 'OK', 'vm; world v2'],
        ['pin', 'FAIL', 'BLOCKED fixture: this machine\'s world is v2; eve needs v1']], world: null });
    });

    it.each([
      ['a catalogue without project:globex, naming the journeys that need it',
        () => writeWorld(worldDoc({ fixtures: CATALOGUE.filter(id => id !== 'project:globex') })),
        'BLOCKED fixture: world-projects-listed needs project:globex; terminal-on-request needs project:globex'],
      ['a world it cannot read', () => {}, 'BLOCKED fixture: world data is not readable'],
    ])('fails fixtures for %s', (_label, setup, detail) => {
      writeMarker();
      setup();
      const { lines, world: w } = preflight(journeys);
      expect(lines.map(l => l[0])).toEqual(['machine', 'pin', 'fixtures']);
      expect(lines[2]).toEqual(['fixtures', 'FAIL', detail]);
      expect(w).toBeNull();
    });
  });

  it('main.js without a marker prints one machine FAIL line, exits 2 and takes no lock', () => {
    const lock = path.join(dir, 'lock');
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'devboxverify', 'main.js')], {
      encoding: 'utf8',
      timeout: 60000,
      // RELAY_BIN: a build that wrongly gets past preflight stops at the service check, not at the real relay.
      env: { ...process.env, DEVBOXWORLD_MARKER: path.join(dir, 'none'), EVE_BROWSER_LOCK: lock, RELAY_BIN: path.join(dir, 'no-relay'), NIGHTLY_LOG_DIR: path.join(dir, 'logs') },
    });
    const total = require('../../devboxverify/journeys').journeys.length;
    expect({ status: out.status, stdout: out.stdout }).toEqual({
      status: 2, stdout: `SELECTION\tfull\t${total}/${total}\t-\tnot a PR run\nPREFLIGHT\tmachine\tFAIL\t${ABSENT}\n`,
    });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('newPage spreads a device over the 1280x800 default and leaves the default alone without one', async () => {
    const { DEVICES } = require('../../devboxverify/journey-kit');
    const opened = [];
    const browser = { newContext: async (opts) => { opened.push(opts); return { newPage: async () => ({}), close: async () => {} }; } };
    const j = { id: 'x', timeoutMs: 5000, areas: ['verify'], fixture: true, needs: [],
      run: async (env) => { await env.newPage({ device: DEVICES.phone }); await env.newPage(); return { state: 'PASS' }; } };
    await runJourney(j, {}, browser, { timeoutMs: 5000, projects: null, world: loaded, pending: [], screen: null, log: () => {} });
    expect(opened).toEqual([{ viewport: { width: 390, height: 844 }, hasTouch: true }, { viewport: { width: 1280, height: 800 } }]);
  });

  it.each([
    ['PASS for a declared lookup', env => env.world.projects.acme.name, 'PASS', 'Acme Corp'],
    ['BLOCKED for an undeclared project', env => env.world.projects.globex, 'BLOCKED', 'undeclared fixture project:globex'],
    ['BLOCKED for an undeclared file', env => env.world.file('acme', 'todo.txt'), 'BLOCKED', 'undeclared fixture file:acme/todo.txt'],
    ['BLOCKED for an undeclared env.projects key', env => env.projects.globex, 'BLOCKED', 'undeclared fixture project:globex'],
    ['PASS listing only declared env.projects keys', env => Object.keys(env.projects).join(','), 'PASS', 'acme'],
    ['FAIL for any other error', () => { throw new Error('boom'); }, 'FAIL', 'boom'],
  ])('runJourney records %s', async (_label, lookup, state, detail) => {
    const j = { id: 'x', timeoutMs: 5000, areas: ['verify'], fixture: true, needs: ['project:acme'],
      run: async env => ({ state: 'PASS', detail: lookup(env) }) };
    const r = await runJourney(j, {}, {}, { timeoutMs: 5000, projects: null, world: loaded, pending: [], screen: null, log: () => {} });
    expect(r).toEqual({ id: 'x', state, detail });
  });

  describe('relay hook config left in a project folder', () => {
    const HOOK = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [
      { command: '/opt/testbox/Relay.app/Contents/Helpers/relay-sessions hook', timeout: 120, type: 'command' }] }] } }, null, 2);
    const OTHER = JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2);
    const EMPTY = { sessions: [], tasks: [], terminals: [] };
    let folder;
    beforeEach(() => { folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-proj-')); });
    afterEach(() => removeScratch(folder));
    const settings = () => path.join(folder, '.claude', 'settings.local.json');
    // The journey stands in for relay-sessions starting a Claude session in the project.
    const runWith = (files) => {
      const api = { snapshot: async () => EMPTY };
      const j = { id: 'x', timeoutMs: 5000, areas: ['verify'], fixture: true, needs: [],
        run: async () => {
          fs.mkdirSync(path.join(folder, '.claude'), { recursive: true });
          for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(folder, '.claude', name), body);
          return { state: 'PASS' };
        } };
      const projects = [{ key: 'acme', name: 'Acme Corp', id: 'p1', path: folder }];
      return runJourney(j, { api }, {}, { timeoutMs: 5000, projects, world: loaded, pending: [], screen: null, log: () => {} });
    };

    it('removes the hook file and the then-empty .claude folder, and keeps the PASS', async () => {
      const r = await runWith({ 'settings.local.json': HOOK });
      expect(r.state).toBe('PASS');
      expect(fs.existsSync(path.join(folder, '.claude'))).toBe(false);
    });

    it('leaves a settings.local.json with other content untouched', async () => {
      const r = await runWith({ 'settings.local.json': OTHER });
      expect(r.state).toBe('PASS');
      expect(fs.readFileSync(settings(), 'utf8')).toBe(OTHER);
    });

    it('leaves relay\'s hook config with extra top-level content untouched', async () => {
      const merged = JSON.stringify({ ...JSON.parse(HOOK), permissions: { allow: ['Bash'] } }, null, 2);
      const r = await runWith({ 'settings.local.json': merged });
      expect(r.state).toBe('PASS');
      expect(fs.readFileSync(settings(), 'utf8')).toBe(merged);
    });

    it('leaves a hook config whose command is not relay\'s untouched', async () => {
      const foreign = JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [
        { command: '/usr/local/bin/other hook', timeout: 120, type: 'command' }] }] } }, null, 2);
      const r = await runWith({ 'settings.local.json': foreign });
      expect(r.state).toBe('PASS');
      expect(fs.readFileSync(settings(), 'utf8')).toBe(foreign);
    });

    it('removes the hook file but keeps .claude when it holds another file', async () => {
      const r = await runWith({ 'settings.local.json': HOOK, 'notes.txt': 'keep' });
      expect(r.state).toBe('PASS');
      expect(fs.existsSync(settings())).toBe(false);
      expect(fs.readFileSync(path.join(folder, '.claude', 'notes.txt'), 'utf8')).toBe('keep');
    });
  });

  describe('a context whose close never settles', () => {
    const CLOSE_TIMEOUT_MS = require('../../devboxverify/main').CLOSE_TIMEOUT_MS ?? 10000;
    const EMPTY = { sessions: [], tasks: [], terminals: [] };
    const stalled = (events) => ({
      newContext: async () => ({ newPage: async () => ({}), close: () => { events.push('close'); return new Promise(() => {}); } }),
    });
    const start = (run, events) => {
      jest.useFakeTimers();
      const api = { snapshot: async () => { events.push('snapshot'); return EMPTY; } };
      const j = { id: 'x', timeoutMs: 5000, areas: ['verify'], fixture: true, needs: [],
        run: async (env) => { await env.newPage(); return run(); } };
      const out = { settled: false, result: null };
      runJourney(j, { api }, stalled(events), { timeoutMs: 5000, projects: [], world: loaded, pending: [], screen: null, log: () => {} })
        .then((r) => { out.settled = true; out.result = r; });
      return out;
    };

    it('settles within the bound, records FAIL for a passing journey and still takes the leak snapshot', async () => {
      const events = [];
      const out = start(async () => ({ state: 'PASS' }), events);
      await jest.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);
      expect(out.settled).toBe(true);
      expect(out.result).toEqual({ id: 'x', state: 'FAIL', detail: 'context close timed out after 10s' });
      expect(events).toEqual(['snapshot', 'close', 'snapshot']);
    });

    it('keeps FAIL for a failing journey and appends the close timeout to its detail', async () => {
      const events = [];
      const out = start(async () => { throw new Error('boom'); }, events);
      await jest.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);
      expect(out.settled).toBe(true);
      expect(out.result).toEqual({ id: 'x', state: 'FAIL', detail: 'boom; context close timed out after 10s' });
    });
  });

  describe('boundedClose', () => {
    const { boundedClose, CLOSE_TIMEOUT_MS } = require('../../devboxverify/main');

    it('exports the 10 second bound', () => {
      expect(CLOSE_TIMEOUT_MS).toBe(10000);
    });

    it.each([
      ['resolves', () => Promise.resolve()],
      ['rejects', () => Promise.reject(new Error('gone'))],
    ])('is true for a close that %s', async (_label, close) => {
      await expect(boundedClose(close)).resolves.toBe(true);
    });

    it('is false when the bound passes before close settles', async () => {
      jest.useFakeTimers();
      let result;
      boundedClose(() => new Promise(() => {}), 50).then((v) => { result = v; });
      await jest.advanceTimersByTimeAsync(49);
      expect(result).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      expect(result).toBe(false);
    });
  });
});

describe('devboxverify/main.js main', () => {
  const { main } = require('../../devboxverify/main');
  const GRACE = 1000;
  let savedExitCode;
  let stderrSpy;

  beforeEach(() => {
    savedExitCode = process.exitCode;
    jest.useFakeTimers();
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    jest.useRealTimers();
    process.exitCode = savedExitCode;
  });

  function deferred() {
    const d = {};
    d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
    return d;
  }

  it('does not exit while the run is open, then exits once with its code after the grace', async () => {
    const run = deferred();
    const exit = jest.fn();
    const done = main([], { runFn: () => run.promise, exit, graceMs: GRACE });
    await jest.advanceTimersByTimeAsync(GRACE * 10);
    expect(exit).not.toHaveBeenCalled();
    run.resolve(1);
    await expect(done).resolves.toBe(1);
    await jest.advanceTimersByTimeAsync(GRACE - 1);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 2 after the grace when the run rejects', async () => {
    const exit = jest.fn();
    const done = main([], { runFn: () => Promise.reject(new Error('boom')), exit, graceMs: GRACE });
    await expect(done).resolves.toBe(2);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(GRACE);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it('exits 0 when the run resolves 0', async () => {
    const exit = jest.fn();
    await main([], { runFn: () => Promise.resolve(0), exit, graceMs: GRACE });
    await jest.advanceTimersByTimeAsync(GRACE);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('devboxverify Chief of Staff project from relay (eve#249)', () => {
  const { chiefOfStaffSourceProblem } = require('../../devboxverify/main');
  const {
    cosProjectBSetup, parseMintOutput, frontendSocketIn, frontendRequest, cosLaunchRows, cosLaunchProblem, cosConfigLine, launchRowsFromJsonl, hostLaunchProblem, noreadReplyProblem,
  } = require('../../devboxverify/journeys');
  const TOKEN = 'f'.repeat(32) + '0123456789abcdef'.repeat(2);

  describe('chiefOfStaffSourceProblem', () => {
    const line = (source, project) => `2026-10-07 info Chief of Staff config from ${source}: project ${project}, model haiku, 40 calls a day\n`;
    it.each([
      ['the file wins', line('settings.json', 'p1'), ''],
      ['relay holds the V-COS project', line('relay', 'p1'), ''],
      ['no setting anywhere', line('defaults', 'automatic'), ''],
    ])('accepts when %s', (_n, text) => {
      expect(chiefOfStaffSourceProblem(`noise\n${text}`, 'p1')).toBe('');
    });

    it('blocks with the Not-set message when relay holds another project', () => {
      expect(chiefOfStaffSourceProblem(line('relay', 'p2'), 'p1'))
        .toBe('setup V-COS: relay holds a Chief of Staff setting; set it to Not set in relay\'s Settings');
    });

    it.each([['an empty log', ''], ['a log without the line', 'eve listening\n']])('blocks on %s, never passes silently', (_n, text) => {
      expect(chiefOfStaffSourceProblem(text, 'p1')).toMatch(/^setup V-COS: .*no "Chief of Staff config from" line/);
    });
  });

  describe('cosProjectBSetup', () => {
    const grant = (...views) => JSON.stringify(views);
    const b = (mcps) => ({ kind: 'project', id: 'pb', name: 'Verify Chief of Staff B', mcps });
    it('returns the id when exactly one project holds exactly the eve-cos grant', () => {
      expect(cosProjectBSetup(grant(b([{ mcp: 'relay-eve-cos-verify' }])))).toEqual({ projectId: 'pb', problem: '' });
    });
    it.each([
      ['no project', grant(), /0 projects named "Verify Chief of Staff B"/],
      ['two projects', grant(b([]), b([])), /2 projects named/],
      ['a grant too many', grant(b([{ mcp: 'relay-eve-cos-verify' }, { mcp: 'other' }])), /granted \[relay-eve-cos-verify, other\]/],
      ['unreadable JSON', 'nope', /unreadable JSON/],
    ])('blocks on %s and points at the README', (_n, out, re) => {
      const r = cosProjectBSetup(out);
      expect(r.projectId).toBe('');
      expect(r.problem).toMatch(/^setup V-COS-B: /);
      expect(r.problem).toMatch(re);
      expect(r.problem).toMatch(/see devboxverify\/README\.md$/);
    });
  });

  describe('parseMintOutput and frontendSocketIn', () => {
    it('reads the id and token lines', () => {
      expect(parseMintOutput(`minted\nid: c-1\ntoken: ${TOKEN}\nexpires: soon\n`)).toEqual({ id: 'c-1', token: TOKEN });
    });
    it('returns empty strings when the lines are missing', () => {
      expect(parseMintOutput('id: c-1\n')).toEqual({ id: 'c-1', token: '' });
      expect(parseMintOutput('')).toEqual({ id: '', token: '' });
    });
    it('picks the single frontend socket and refuses none or several', () => {
      expect(frontendSocketIn(['relay.sock', 'relay-frontend-12.sock'])).toBe('relay-frontend-12.sock');
      expect(frontendSocketIn(['relay.sock'])).toBeNull();
      expect(frontendSocketIn(['relay-frontend-1.sock', 'relay-frontend-2.sock'])).toBeNull();
    });
  });

  describe('frontendRequest', () => {
    const http = require('http');
    let dir, server, seen;
    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-sock-'));
      seen = [];
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
          if (req.url === '/hang') return;
          res.writeHead(req.url === '/bad' ? 500 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ configured: false }));
        });
      });
      await new Promise((r) => server.listen(path.join(dir, 's.sock'), r));
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      if (dir && dir.includes('dbv-sock-')) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('sends the token as a bearer header and the body as JSON, and parses the answer', async () => {
      const r = await frontendRequest(path.join(dir, 's.sock'), TOKEN, 'PUT', '/api/x', { a: 1 });
      expect(r).toEqual({ status: 200, json: { configured: false } });
      expect(seen.at(-1)).toEqual({ method: 'PUT', url: '/api/x', auth: `Bearer ${TOKEN}`, body: '{"a":1}' });
    });
    it('returns a non-2xx status instead of throwing', async () => {
      expect((await frontendRequest(path.join(dir, 's.sock'), TOKEN, 'GET', '/bad')).status).toBe(500);
    });
    it('gives up at the bound and keeps the token out of the error', async () => {
      const err = await frontendRequest(path.join(dir, 's.sock'), TOKEN, 'GET', '/hang', undefined, 200).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/no answer within/);
      expect(err.message).not.toContain(TOKEN);
    });
    it('keeps the token out of the error when the socket is gone', async () => {
      const err = await frontendRequest(path.join(dir, 'gone.sock'), TOKEN, 'GET', '/x').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(String(err.message) + String(err.stack)).not.toContain(TOKEN);
    });
  });

  describe('session_launch audit verdict', () => {
    const row = (o) => JSON.stringify({
      event: 'session_launch', id: 'a1', outcome: 'ok', actor: { project_id: 'pb' }, args: { read_only_projects: true }, ...o,
    });
    it('passes on a new ok row in the project with read-only roots', () => {
      expect(cosLaunchProblem(cosLaunchRows(row({ id: 'new' })), new Set(['old']), 'pb')).toBeNull();
    });
    it.each([
      ['only rows from before the PUT', row({ id: 'old' })],
      ['a refused launch', row({ id: 'n', outcome: 'refused' })],
      ['another project', row({ id: 'n', actor: { project_id: 'pa' } })],
      ['a launch without read-only roots', row({ id: 'n', args: {} })],
      ['no rows', ''],
    ])('fails on %s', (_n, jsonl) => {
      expect(cosLaunchProblem(cosLaunchRows(jsonl), new Set(['old']), 'pb')).toMatch(/^no new ok session_launch row/);
    });
    it('ignores other events and unreadable lines', () => {
      expect(cosLaunchRows(`junk\n${row({ event: 'session_message' })}`)).toEqual([]);
    });
  });

  describe('hosted session_launch audit verdict (cos-host-agent)', () => {
    const line = (o) => JSON.stringify({ event: 'session_launch', outcome: 'ok', args: { session_id: 's1', origin: 'chief-of-staff', host_id: 'h1' }, ...o });
    it('reads outcome, origin and host of the rows naming the session', () => {
      const other = line({ args: { session_id: 's2', origin: 'chief-of-staff', host_id: 'h1' } });
      expect(launchRowsFromJsonl(`junk\n${line({})}\n${other}\n${line({ event: 'session_message' })}`, 's1'))
        .toEqual([{ outcome: 'ok', origin: 'chief-of-staff', hostId: 'h1' }]);
    });
    it('passes on an ok chief-of-staff row naming the host', () => {
      expect(hostLaunchProblem(launchRowsFromJsonl(line({}), 's1'), 'h1')).toBeNull();
    });
    it.each([
      ['no rows', ''],
      ['a refused launch', line({ outcome: 'denied' })],
      ['another origin', line({ args: { session_id: 's1', origin: 'user', host_id: 'h1' } })],
      ['no host', line({ args: { session_id: 's1', origin: 'chief-of-staff' } })],
      ['another host', line({ args: { session_id: 's1', origin: 'chief-of-staff', host_id: 'h2' } })],
    ])('fails on %s', (_n, jsonl) => {
      expect(hostLaunchProblem(launchRowsFromJsonl(jsonl, 's1'), 'h1')).toMatch(/^relay audit holds no ok session_launch row/);
    });
  });

  describe('cannot-read reply verdict (cos-host-noread)', () => {
    const name = 'Drop-in Host noread n1';
    const reply = (body) => ({ kind: 'reply', body });
    const good = reply(`I can\u2019t read files in ${name}: it lives on an SSH host.`);
    it.each([
      ['cannot read', `I cannot read files in ${name}.`],
      ["can't read", `I can't read files in ${name}.`],
      ['unable to read', `I am unable to read files in ${name}.`],
    ])('passes on a reply naming the project that says %s', (_n, body) => {
      expect(noreadReplyProblem([reply(body)], name)).toBeNull();
    });
    it('passes on the curly apostrophe', () => {
      expect(noreadReplyProblem([good], name)).toBeNull();
    });
    it('fails when the reply does not name the project', () => {
      expect(noreadReplyProblem([reply('I cannot read files there.')], name)).toMatch(/does not name the project and says it cannot read/);
    });
    it('fails when the reply does not say it cannot read', () => {
      expect(noreadReplyProblem([reply(`${name} has a README with a title.`)], name)).toMatch(/names the project and does not say it cannot read/);
    });
    it('fails when a started post follows the reply', () => {
      expect(noreadReplyProblem([good, { kind: 'started' }], name)).toMatch(/^the question started an agent \(started\)/);
    });
    it('fails on a start_card', () => {
      expect(noreadReplyProblem([{ kind: 'start_card', body: 'Start?' }], name)).toMatch(/^the question started an agent \(start_card\)/);
    });
    it('fails when the first post is not a reply', () => {
      expect(noreadReplyProblem([{ kind: 'notice', body: `cannot read ${name}` }], name)).toMatch(/^the thread posted "notice", want reply/);
    });
    const person = { kind: 'person', text: 'What is in README.md?' };
    it('skips the person\'s own question before the reply', () => {
      expect(noreadReplyProblem([person, good], name)).toBeNull();
    });
    it('fails on a start_card after the person post', () => {
      expect(noreadReplyProblem([person, { kind: 'start_card', body: 'Start?' }], name)).toMatch(/^the question started an agent \(start_card\)/);
    });
    it('ignores alert, finished, question and sent posts', () => {
      const others = [{ kind: 'alert', body: 'x' }, { kind: 'finished' }, { kind: 'question' }, { kind: 'sent' }];
      expect(noreadReplyProblem([person, ...others, good], name)).toBeNull();
    });
    it('fails when only the person post is there', () => {
      expect(noreadReplyProblem([person], name)).toMatch(/posted nothing/);
    });
    it('matches the project name in any case', () => {
      expect(noreadReplyProblem([reply(`I cannot read files in ${name.toUpperCase()}.`)], name)).toBeNull();
    });
    it('still needs the nonce to match', () => {
      expect(noreadReplyProblem([reply('I cannot read files in drop-in host noread n2.')], name)).toMatch(/does not name the project/);
    });
    it('fails with no posts', () => {
      expect(noreadReplyProblem([], name)).toMatch(/posted nothing/);
    });
  });

  it('names the log line eve writes for relay\'s setting', () => {
    expect(cosConfigLine('pb', 'haiku', 40)).toBe('Chief of Staff config from relay: project pb, model haiku, 40 calls a day');
  });
});

describe('writeHeartbeat', () => {
  const { writeHeartbeat } = require('../../devboxverify/main');
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('writes id, event, pid and a decimal monotonic stamp', () => {
    const file = path.join(dir, 'hb.json');
    const before = process.hrtime.bigint();
    expect(writeHeartbeat(file, { id: 'j1', event: 'start' })).toBe(true);
    const after = process.hrtime.bigint();
    const hb = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(hb).toEqual({ id: 'j1', event: 'start', pid: process.pid, mono: expect.stringMatching(/^\d+$/) });
    expect(BigInt(hb.mono)).toBeGreaterThanOrEqual(before);
    expect(BigInt(hb.mono)).toBeLessThanOrEqual(after);
  });

  it('overwrites the previous heartbeat and leaves no temp file', () => {
    const file = path.join(dir, 'hb.json');
    writeHeartbeat(file, { id: 'j1', event: 'start' });
    writeHeartbeat(file, { id: 'j2', event: 'end' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ id: 'j2', event: 'end' });
    expect(fs.readdirSync(dir)).toEqual(['hb.json']);
  });

  it('returns false with one scrubbed stderr line when the directory is missing', () => {
    const file = path.join(os.homedir(), `.no-such-dir-${Math.random().toString(36).slice(2)}`, 'hb.json');
    const writes = [];
    let result;
    expect(() => { result = writeHeartbeat(file, { id: 'j1', event: 'start' }, { stderr: { write: (s) => writes.push(s) } }); }).not.toThrow();
    expect(result).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^heartbeat: [^\n]*\n$/);
    expect(writes[0]).not.toContain(os.homedir());
  });
});

describe('devboxverify run record (eve#269)', () => {
  const MAIN = path.join(__dirname, '..', '..', 'devboxverify', 'main.js');
  const REPO = path.join(__dirname, '..', '..');
  const ABSENT = 'not a test machine: run devboxWorld bootstrap on a VM';
  // Deliberate: a git hook exports GIT_DIR and friends, which would point the child at the wrong repo.
  const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  let scratch;
  beforeEach(() => { scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dbv-rec-')); });
  afterEach(() => { if (scratch && scratch.startsWith(os.tmpdir())) fs.rmSync(scratch, { recursive: true, force: true }); });

  const spawnMain = (args, logDir) => spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...cleanEnv(), DEVBOXWORLD_MARKER: path.join(scratch, 'none'), EVE_BROWSER_LOCK: path.join(scratch, 'lock'),
      RELAY_BIN: path.join(scratch, 'no-relay'), NIGHTLY_LOG_DIR: logDir },
  });
  const repoHead = () => execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: cleanEnv() }).trim();
  const total = () => require('../../devboxverify/journeys').journeys.length;
  const expectedStdout = () => `SELECTION\tfull\t${total()}/${total()}\t-\tnot a PR run\nPREFLIGHT\tmachine\tFAIL\t${ABSENT}\n`;

  it('a blocked run writes one record holding its stdout lines, a POST line and the exit code', () => {
    const logs = path.join(scratch, 'logs');
    const out = spawnMain([], logs);
    expect({ status: out.status, stdout: out.stdout }).toEqual({ status: 2, stdout: expectedStdout() });
    const runs = path.join(logs, 'runs');
    const files = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
    expect(files).toHaveLength(1);
    const head = repoHead();
    const m = files[0].match(/^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-([0-9a-f]{12}|unknown)\.out$/);
    expect(m).not.toBeNull();
    expect(m[1]).toBe(head.slice(0, 12));
    const lines = fs.readFileSync(path.join(runs, files[0]), 'utf8').split('\n');
    expect(lines.pop()).toBe('');
    const [run, ...rest] = lines;
    expect(run).toMatch(new RegExp(`^RUN\\t\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z\\t${head}\\tdevboxverify/main\\.js`));
    expect(rest).toEqual([
      `SELECTION\tfull\t${total()}/${total()}\t-\tnot a PR run`,
      `PREFLIGHT\tmachine\tFAIL\t${ABSENT}`,
      'POST\tnot posted\tno --post',
      'EXIT\t2',
    ]);
  });

  it('a record that cannot be written leaves stdout and exit code alone and warns once on stderr', () => {
    const notADir = path.join(scratch, 'file');
    fs.writeFileSync(notADir, 'x');
    const out = spawnMain([], notADir);
    expect({ status: out.status, stdout: out.stdout }).toEqual({ status: 2, stdout: expectedStdout() });
    const warnings = out.stderr.split('\n').filter(l => l.startsWith('run record: '));
    expect(warnings).toHaveLength(1);
  });

  it('an unknown --only id writes no record', () => {
    const logs = path.join(scratch, 'logs');
    const out = spawnMain(['--only', 'no-such-journey'], logs);
    expect(out.status).toBe(2);
    expect(fs.existsSync(path.join(logs, 'runs'))).toBe(false);
  });

  describe('openRunRecord', () => {
    const { openRunRecord, runRecordDir } = require('../../devboxverify/main');
    const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
    const START = Date.UTC(2026, 9, 7, 12, 34, 56, 789);
    const open = (extra = {}) => {
      const writes = [];
      const rec = openRunRecord({ dir: path.join(scratch, 'runs'), startedAtMs: START, head: HEAD,
        argv: ['--post', '7'], home: HOME, post: true, stderr: { write: (s) => writes.push(s) }, ...extra });
      return { rec, writes, lines: () => fs.readFileSync(rec.file, 'utf8').split('\n').filter(Boolean) };
    };

    it('names the file by start time and the first 12 characters of the head', () => {
      const { rec } = open();
      expect(path.basename(rec.file)).toBe('2026-10-07T12-34-56-789Z-abcdef012345.out');
    });

    it('runRecordDir is runs under the log dir override, else under the home log dir', () => {
      expect(runRecordDir({ NIGHTLY_LOG_DIR: '/srv/acme/logs' }, HOME)).toBe('/srv/acme/logs/runs');
      expect(runRecordDir({}, HOME)).toBe(path.join(HOME, 'Library', 'Logs', 'devboxverify', 'runs'));
    });

    it('writes the RUN line on open with home shown as ~', () => {
      const { lines } = open({ argv: ['--checkout', `${HOME}/src/eve`] });
      expect(lines()).toEqual([`RUN\t2026-10-07T12:34:56.789Z\t${HEAD}\tdevboxverify/main.js --checkout ~/src/eve`]);
    });

    it('writes unknown for a missing head', () => {
      const { rec } = open({ head: '' });
      expect(path.basename(rec.file)).toMatch(/-unknown\.out$/);
    });

    it('records a successful post with state, description and url, then the exit code', () => {
      const { rec, lines } = open();
      rec.line('SUMMARY\t1 PASS');
      rec.posted({ state: 'success', description: '1 PASS of 1', url: 'https://example.test/c/1' });
      rec.finish(0);
      expect(lines().slice(1)).toEqual(['SUMMARY\t1 PASS', 'POST\tsuccess\t1 PASS of 1\thttps://example.test/c/1', 'EXIT\t0']);
    });

    it('records a failed post with the reason', () => {
      const { rec, lines } = open();
      rec.posted({ error: 'gh exploded' });
      rec.finish(1);
      expect(lines().slice(1)).toEqual(['POST\tfailed\tgh exploded', 'EXIT\t1']);
    });

    it('records a --post run that never posted as stopped before posting', () => {
      const { rec, lines } = open();
      rec.finish(2);
      expect(lines().slice(1)).toEqual(['POST\tnot posted\tstopped before posting', 'EXIT\t2']);
    });

    it('records a run that is not a --post run as not posted', () => {
      const { rec, lines } = open({ post: false });
      rec.finish(0);
      expect(lines().slice(1)).toEqual(['POST\tnot posted\tno --post', 'EXIT\t0']);
    });

    it('records a throw as EXIT threw with the first line of the error', () => {
      const { rec, lines } = open();
      rec.finish(undefined, new Error('first line\nsecond line'));
      const last = lines().pop();
      expect(last).toBe('EXIT\tthrew\tfirst line');
    });

    it('never throws on an unwritable dir, and warns once', () => {
      const notADir = path.join(scratch, 'file');
      fs.writeFileSync(notADir, 'x');
      const writes = [];
      let rec;
      expect(() => {
        rec = openRunRecord({ dir: path.join(notADir, 'runs'), startedAtMs: START, head: HEAD, argv: [], home: HOME, post: false,
          stderr: { write: (s) => writes.push(s) } });
        for (let i = 0; i < 20; i++) rec.line(`JOURNEY\tj${i}\tPASS\t-`);
        rec.posted({ error: 'x' });
        rec.finish(0);
      }).not.toThrow();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/^run record: [^\n]*\n$/);
    });
  });
});
