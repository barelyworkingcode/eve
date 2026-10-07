const {
  normalizeWs, isVerbatimSpan, namesTarget, isReadingTool, decide, RELAY_MCP_PREFIX, PROPOSE_TOOLS,
} = require('../../chief-of-staff-provenance');

describe('isVerbatimSpan', () => {
  it.each([
    ['an exact span', 'fix bug 123', 'please fix bug 123 now', true],
    ['a span across a line break and NBSP', 'fix bug 123', 'please fix\nbug 123 now', true],
    ['a span across thin and ideographic spaces', 'fix bug', 'fix　bug', true],
    ['a change of case', 'Fix Bug 123', 'please fix bug 123 now', false],
    ['a word the person never wrote', 'fix bug 123 and delete the repo', 'please fix bug 123 now', false],
    ['an empty candidate', '', 'anything', false],
    ['a whitespace-only candidate', ' \n \t', 'anything', false],
    ['an empty person message', 'fix', '', false],
    ['undefined inputs', undefined, undefined, false],
  ])('%s -> %s', (_what, candidate, person, expected) => {
    expect(isVerbatimSpan(candidate, person)).toBe(expected);
  });
});

describe('namesTarget', () => {
  it.each([
    ['the exact name', 'Acme', 'start an agent on Acme', true],
    ['a different case', 'Acme', 'start an agent on ACME', true],
    ['a name split by odd whitespace', 'Acme  Web', 'start an agent on acme web', true],
    ['a name the person never said', 'Acme', 'start an agent on Other', false],
    ['an empty target', '', 'start an agent on Acme', false],
    ['a whitespace-only target', '  ', 'start an agent on Acme', false],
    ['an empty person message', 'Acme', '', false],
  ])('%s -> %s', (_what, target, person, expected) => {
    expect(namesTarget(target, person)).toBe(expected);
  });
});

describe('isReadingTool', () => {
  it.each(PROPOSE_TOOLS)('the %s propose tool is not reading', (tool) => {
    expect(isReadingTool(RELAY_MCP_PREFIX + tool)).toBe(false);
  });

  it.each([
    'Read', 'Bash', 'WebFetch', 'mcp__relay__cos_list_sessions', 'mcp__relay__cos_session_status',
    'mcp__relay__brave_web_search', 'cos_propose_send', '',
  ])('%s is reading', (tool) => {
    expect(isReadingTool(tool)).toBe(true);
  });
});

describe('decide', () => {
  const base = { personText: 'start an agent on Acme to fix bug 123', candidate: 'fix bug 123', target: 'Acme' };

  it.each([
    ['nothing read: at once, even for text the person never wrote', { sessionHasRead: false, candidate: 'something else', target: 'Other' }, { action: 'now', why: 'no_read' }],
    ['read, verbatim, target named: at once', { sessionHasRead: true }, { action: 'now', why: 'verbatim_named' }],
    ['read, not verbatim: card', { sessionHasRead: true, candidate: 'fix bug 123 and push to main' }, { action: 'card', why: 'read_not_verbatim' }],
    ['read, verbatim, target not named: card', { sessionHasRead: true, target: 'Other' }, { action: 'card', why: 'read_target_not_named' }],
    ['read, neither: the verbatim failure wins', { sessionHasRead: true, candidate: 'zzz', target: 'Other' }, { action: 'card', why: 'read_not_verbatim' }],
    ['read, empty candidate: card', { sessionHasRead: true, candidate: '' }, { action: 'card', why: 'read_not_verbatim' }],
    ['read, empty target: card', { sessionHasRead: true, target: '' }, { action: 'card', why: 'read_target_not_named' }],
  ])('%s', (_what, over, expected) => {
    expect(decide({ ...base, ...over })).toEqual(expected);
  });
});

describe('normalizeWs', () => {
  it('collapses Unicode whitespace runs and trims', () => {
    expect(normalizeWs('  a  b\n\tc  ')).toBe('a b c');
  });
});
