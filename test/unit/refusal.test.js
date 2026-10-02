// S3b-2: a tool_result is a refusal when it carries scope_violation (macMCP's
// scope check) or is_error with relay's "access denied: " text. docs/design-mode-presets.md
const Refusal = require('../../public/core/refusal');

const DENIED = 'Error: mcp: call "mail_send": access denied: tool \'mail_send\' is not in the allowed tools';
const result = (extra) => ({ v: 2, type: 'result', subtype: 'tool_result', tool_use_id: 'tu-1', tool_name: 'mail_get_emails', content: 'ok', ...extra });
const block = (extra) => ({ type: 'tool_result', tool_use_id: 'tu-1', ...extra });

describe('Refusal.detect', () => {
  it('the relay marker is "access denied: "', () => {
    expect(Refusal.RELAY_MARKER).toBe('access denied: ');
  });

  it.each([
    ['scope_violation with is_error', result({ is_error: true, scope_violation: true, content: 'Account is out of scope' }), 'scope'],
    ['scope_violation alone', result({ scope_violation: true }), 'scope'],
    ['is_error with the marker in string content', result({ is_error: true, content: DENIED }), 'relay'],
    ['is_error with the marker in a later text block', result({ is_error: true, content: [{ type: 'text', text: 'Error:' }, { type: 'text', text: DENIED }] }), 'relay'],
  ])('%s is a refusal of that kind, naming the tool', (_what, event, kind) => {
    expect(Refusal.detect(event)).toEqual({ tool: 'mail_get_emails', kind });
  });

  it('a Claude tool_result block with is_error and the marker is a relay refusal', () => {
    const found = Refusal.detect(block({ is_error: true, content: [{ type: 'text', text: DENIED }] }));
    expect(found).toEqual({ tool: expect.any(String), kind: 'relay' });
  });

  it.each([
    ['a success', result({ is_error: false })],
    ['a success that mentions access denied', result({ is_error: false, content: DENIED })],
    ['the marker with is_error missing', result({ content: DENIED })],
    ['is_error with other text', result({ is_error: true, content: 'Error: mcp: timeout' })],
    ['scope_violation as a string', result({ scope_violation: 'true' })],
    ['scope_violation as 1', result({ scope_violation: 1 })],
    ['scope_violation false', result({ is_error: true, scope_violation: false })],
    ['a block without is_error', block({ content: DENIED })],
  ])('%s is not a refusal', (_what, event) => {
    expect(Refusal.detect(event)).toBeNull();
  });
});
