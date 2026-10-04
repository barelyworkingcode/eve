// Paired devbox/verify status for a relay + eve set, driven through a fake gh.
const { renderSetComment, postSet } = require('../../devboxverify/set-status');

const HOME = '/home/tester';
const RELAY_SHA = '1a'.repeat(20);
const EVE_SHA = '2b'.repeat(20);
const TOOL_SHA = '3c'.repeat(20);
const RELAY_URL = 'https://github.com/acme/relay/pull/7';
const EVE_URL = 'https://github.com/acme/eve/pull/12';

const SUM = (pass, fail = 0, blocked = 0, notrun = 0) => `SUMMARY\tpass=${pass}\tfail=${fail}\tblocked=${blocked}\tnotrun=${notrun}`;
const J = (id, state, detail = '') => `JOURNEY\t${id}\t${state}\t${detail}`;
const phase = (label, lines, extra = {}) => ({
  label, repo: label === 'eve' ? 'eve' : 'relay', sha: label === 'eve' ? EVE_SHA : RELAY_SHA,
  code: 0, timedOut: false, stdout: lines.join('\n') + '\n', ...extra,
});
const green = () => [
  phase('relay-api', [J('api-login', 'PASS'), SUM(1)]),
  phase('eve', [J('chat-reply', 'PASS'), SUM(1)]),
  phase('relay-screen', [J('tray-open', 'PASS'), J('tray-badge', 'NOTRUN', 'screen journey; run with --screen'), SUM(1, 0, 0, 1)]),
];
const evidence = (phases) => ({
  relay: { repo: 'relay', pr: 7, branch: null, sha: RELAY_SHA, url: RELAY_URL, checkout: '/w/relay' },
  eve: { repo: 'eve', pr: 12, branch: null, sha: EVE_SHA, url: EVE_URL, checkout: '/w/eve' },
  phases, toolCommit: TOOL_SHA, runMs: 61000, home: HOME,
});

function fakeGh(fail = () => false) {
  const calls = [];
  const gh = async (args, { cwd, stdin }) => {
    const call = { args, cwd, stdin };
    calls.push(call);
    if (fail(call)) throw new Error('gh failed');
    if (args[0] === 'pr' && args[1] === 'comment') return `${cwd === '/w/relay' ? RELAY_URL : EVE_URL}#issuecomment-${args[2]}\n`;
    return '{}';
  };
  return { gh, calls };
}

const isStatus = (c) => c.args[0] === 'api';
const field = (c, k) => (c.args.find((a) => a.startsWith(`${k}=`)) || '').slice(k.length + 1);
const statusSha = (c) => (/\/statuses\/([0-9a-f]+)$/.exec(c.args.find((a) => a.includes('/statuses/'))) || [])[1];

describe('postSet', () => {
  it('posts the same comment on both PRs, then a devbox/verify status on each head linking its own comment', async () => {
    const phases = [
      phase('relay-api', [J('api-login', 'PASS'), SUM(3)]),
      phase('eve', [SUM(1, 1), J('chat-reply', 'PASS'), SUM(4)]),
      phase('relay-screen', [J('tray-open', 'PASS'), SUM(2, 0, 0, 1)]),
    ];
    const { gh, calls } = fakeGh();
    const urls = await postSet(evidence(phases), { gh });

    expect(calls.map((c) => [c.args.slice(0, 3).join(' '), c.cwd])).toEqual([
      ['pr comment 7', '/w/relay'], ['pr comment 12', '/w/eve'], ['api -X POST', '/w/relay'], ['api -X POST', '/w/eve'],
    ]);
    expect(calls[0].stdin).toBe(calls[1].stdin);
    expect(urls).toEqual({ relay: `${RELAY_URL}#issuecomment-7`, eve: `${EVE_URL}#issuecomment-12` });

    const [relayStatus, eveStatus] = calls.filter(isStatus);
    expect(statusSha(relayStatus)).toBe(RELAY_SHA);
    expect(statusSha(eveStatus)).toBe(EVE_SHA);
    for (const s of [relayStatus, eveStatus]) {
      expect(field(s, 'context')).toBe('devbox/verify');
      expect(field(s, 'state')).toBe('success');
      expect(field(s, 'description').length).toBeLessThanOrEqual(140);
    }
    expect(field(relayStatus, 'target_url')).toBe(urls.relay);
    expect(field(eveStatus, 'target_url')).toBe(urls.eve);
    expect(field(relayStatus, 'description'))
      .toBe(`set relay@${RELAY_SHA.slice(0, 12)} eve@${EVE_SHA.slice(0, 12)}; with eve#12; pass=9 fail=0 blocked=0 notrun=1`);
    expect(field(eveStatus, 'description'))
      .toBe(`set relay@${RELAY_SHA.slice(0, 12)} eve@${EVE_SHA.slice(0, 12)}; with relay#7; pass=9 fail=0 blocked=0 notrun=1`);
  });

  const failing = (label, lines, extra) => (p) => p.map((x) => (x.label === label ? phase(label, lines, extra) : x));
  it.each([
    ['every phase green', (p) => p, 'success'],
    ['relay-api has a failing journey', failing('relay-api', [J('api-login', 'FAIL'), SUM(0, 1)], { code: 1 }), 'failure'],
    ['eve has a failing journey', failing('eve', [J('chat-reply', 'FAIL'), SUM(0, 1)], { code: 1 }), 'failure'],
    ['relay-screen has a failing journey', failing('relay-screen', [J('tray-open', 'FAIL'), SUM(0, 1)], { code: 1 }), 'failure'],
    ['eve is RED with every journey passing', failing('eve', [J('chat-reply', 'PASS'), SUM(1)], { code: 1 }), 'failure'],
    ['eve has a blocked journey', failing('eve', [J('chat-reply', 'BLOCKED'), SUM(0, 0, 1)], { code: 1 }), 'error'],
    ['relay-screen has no SUMMARY line', failing('relay-screen', ['PREFLIGHT\tconsole\tFAIL\tssh session'], { code: 2 }), 'error'],
    ['relay-api timed out after its SUMMARY', failing('relay-api', [J('api-login', 'PASS'), SUM(1)], { code: null, timedOut: true }), 'error'],
    ['eve fails while relay-screen is blocked',
      (p) => failing('relay-screen', [J('tray-open', 'BLOCKED'), SUM(0, 0, 1)], { code: 1 })(
        failing('eve', [J('chat-reply', 'FAIL'), SUM(0, 1)], { code: 1 })(p)), 'failure'],
  ])('when %s, both PRs get state %s', async (_, mutate, state) => {
    const { gh, calls } = fakeGh();
    await postSet(evidence(mutate(green())), { gh });
    const states = calls.filter(isStatus).map((c) => field(c, 'state'));
    expect(states).toEqual([state, state]);
    expect(calls[0].stdin).toMatch(new RegExp(`^### devbox/verify \\(set\\): ${state}\\n`));
  });

  it('re-posts the relay status as error when the eve status fails, then rejects', async () => {
    const { gh, calls } = fakeGh((c) => isStatus(c) && c.cwd === '/w/eve');
    await expect(postSet(evidence(green()), { gh })).rejects.toThrow();
    const last = calls[calls.length - 1];
    expect(statusSha(last)).toBe(RELAY_SHA);
    expect(field(last, 'state')).toBe('error');
    expect(field(last, 'context')).toBe('devbox/verify');
    expect(field(last, 'description')).toBe('set post failed on eve#12');
  });

  it('posts no status when the eve comment fails', async () => {
    const { gh, calls } = fakeGh((c) => c.args[1] === 'comment' && c.cwd === '/w/eve');
    await expect(postSet(evidence(green()), { gh })).rejects.toThrow();
    expect(calls.filter(isStatus)).toEqual([]);
  });
});

describe('renderSetComment', () => {
  const body = renderSetComment(evidence([
    phase('relay-api', [J('api-login', 'PASS'), SUM(1)]),
    phase('eve', [J('settings-sheet', 'FAIL', `expected a|b in ${HOME}/acme/x`), SUM(0, 1)], { code: 1 }),
    phase('relay-screen', ['PREFLIGHT\tconsole\tOK\tconsole', 'PREFLIGHT\tlock\tFAIL\theld by pid 9'], { code: 2 }),
  ]));

  it('names both PRs, both full commits and the tool commit', () => {
    expect(body).toMatch(/^### devbox\/verify \(set\): failure\n/);
    for (const row of [`| Relay PR | ${RELAY_URL} |`, `| Relay commit | \`${RELAY_SHA}\` |`, `| Eve PR | ${EVE_URL} |`,
      `| Eve commit | \`${EVE_SHA}\` |`, `| Tool commit | \`${TOOL_SHA}\` |`, '| Run time | 61 s |']) {
      expect(body).toContain(row);
    }
  });

  it('has one result row per phase in nightly order and a journey row with pipes escaped and home scrubbed', () => {
    const rows = [
      /\| relay-api \| GREEN \| SUMMARY\s+pass=1\s+fail=0\s+blocked=0\s+notrun=0 \|/,
      /\| eve \| RED \| SUMMARY\s+pass=0\s+fail=1\s+blocked=0\s+notrun=0 \|/,
      /\| relay-screen \| BLOCKED \| PREFLIGHT\s+lock\s+FAIL\s+held by pid 9 \|/,
    ].map((re) => body.search(re));
    expect(rows.every((i) => i >= 0)).toBe(true);
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);
    expect(body).toContain('| eve | `settings-sheet` | FAIL | expected a\\|b in ~/acme/x |');
    expect(body).not.toContain(HOME);
  });
});
