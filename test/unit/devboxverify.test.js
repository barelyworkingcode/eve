const { execFileSync, spawnSync } = require('child_process');
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
      ['--world with a value', ['--world', '/srv/world']],
      ['--world=', ['--world=/srv/world']],
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

  it('puts a Run time row, rounded to seconds, right after Tool commit', () => {
    const body = renderComment({
      pr: 7, commit: 'a'.repeat(40), toolCommit: 'b'.repeat(40), runMs: 245600,
      worldSummary: 'pass=1 fail=0', home: HOME, results: [r('landing-view', 'PASS')],
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
  const areas = areaJourneys(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'FEATURES.md'), 'utf8'));
  const contractIds = [
    'landing-view', 'world-projects-listed', 'chat-reply', 'open-existing-thread', 'terminal-on-request',
    'task-created-listed', 'voice-deep-link', 'changes-diff', 'file-edit-save', 'passkey-first-enrol',
    'passkey-sign-in', 'agent-sign-in-refused', 'agent-enrol-refused', 'add-browser-in-window',
    'today-ipad-portrait', 'today-phone', 'ask-about-file', 'routine-from-thread', 'routine-touched',
    'settings-sheet', 'project-admin-in-relay', 'project-mode-new', 'brief-injection-refused',
    'mode-presets', 'ask-in-other-mode', 'research-citations', 'routine-failed-notifies', 'listen',
    'ask-pasted-url', 'chat-pasted-url-source', 'today-custom-part', 'chat-tool-search', 'agent-board-states',
    'cos-asking-post', 'cos-tell-sends-marked',
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

  it('marks only add-browser-in-window and project-mode-new (relay gates its create) as screen and only the two passkey journeys as fixtures', () => {
    expect(journeys.filter(j => j.screen).map(j => j.id)).toEqual(['project-mode-new', 'add-browser-in-window']);
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
        'mode-presets', 'routine-failed-notifies', 'listen', 'ask-pasted-url', 'agent-board-states',
        'cos-asking-post', 'cos-tell-sends-marked'].map(id => [id, acme])),
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
      'agent-sign-in-refused', 'today-ipad-portrait', 'today-phone', 'ask-about-file', 'ask-pasted-url', 'agent-board-states', 'cos-asking-post', 'cos-tell-sends-marked',
      'settings-sheet', 'project-admin-in-relay', 'mode-presets', 'brief-injection-refused', 'today-custom-part', 'ask-in-other-mode', 'research-citations',
      'chat-pasted-url-source', 'chat-tool-search', 'project-mode-new',
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
    ['cos-asking-post', 'devboxverify/README.md', ['chief-of-staff'], 120000],
    ['cos-tell-sends-marked', 'devboxverify/README.md', ['chief-of-staff'], 150000],
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
    relayAuditRows, serviceLogReader, chiefOfStaffSettings, projectIdFromGrant,
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

  describe('projectIdFromGrant', () => {
    const view = (id, name, kind = 'project') => ({ id, name, kind, mcps: [] });

    it('reads the id of the one project with that name', () => {
      expect(projectIdFromGrant(JSON.stringify([view('p2', 'Globex'), view('p1', 'Acme')]), 'Acme')).toBe('p1');
    });

    it.each([
      ['no match', [view('p2', 'Globex')]],
      ['two matches', [view('p1', 'Acme'), view('p3', 'Acme')]],
      ['a profile of that name', [view('p1', 'Acme', 'profile')]],
      ['not a list', { id: 'p1', name: 'Acme', kind: 'project' }],
    ])('refuses %s', (_l, views) => {
      expect(() => projectIdFromGrant(JSON.stringify(views), 'Acme')).toThrow();
    });

    it('refuses text that is not JSON', () => {
      expect(() => projectIdFromGrant('no projects', 'Acme')).toThrow(/unreadable/);
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
      env: { ...process.env, DEVBOXWORLD_MARKER: path.join(dir, 'none'), EVE_BROWSER_LOCK: lock, RELAY_BIN: path.join(dir, 'no-relay') },
    });
    expect({ status: out.status, stdout: out.stdout }).toEqual({ status: 2, stdout: `PREFLIGHT\tmachine\tFAIL\t${ABSENT}\n` });
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
});
