// chat-tool-search's step-order rule (eve#202): a failed call_tool on an
// unknown name may come before tool_search; nothing else may.
const { searchStep, detailProblem } = require('../../devboxverify/journeys-tool-search');

const step = (name, output, input = '') => ({ name, input, output });
const search = step('tool_search', '{"loaded":[{"name":"tides_lookup"}]}', '{"query":"tide"}');
const lookup = step('call_tool', 'TIDE-1234abcd', '{"name":"tides_lookup"}');
const guessed = step('call_tool', '{"error":"unknown tool \\"relay-tides\\""}', '{"name":"relay-tides"}');

describe('chat-tool-search searchStep', () => {
  it('accepts tool_search as the first step', () => {
    expect(searchStep([search, lookup])).toEqual({ index: 0 });
  });

  it('accepts a failed call_tool on an unknown name before tool_search', () => {
    expect(searchStep([guessed, search, lookup])).toEqual({ index: 1 });
  });

  it('accepts more than one failed guess before tool_search', () => {
    expect(searchStep([guessed, guessed, search, lookup])).toEqual({ index: 2 });
  });

  it('fails when tool_search never runs', () => {
    expect(searchStep([guessed, lookup]).error).toMatch(/is "call_tool", not tool_search/);
    expect(searchStep([]).error).toMatch(/missing/);
  });

  it('fails when a call before tool_search succeeded', () => {
    expect(searchStep([lookup, search, lookup]).error).toMatch(/is "call_tool", not tool_search/);
  });

  it('fails when a call before tool_search was refused for another reason', () => {
    const notLoaded = step('call_tool', '{"error":"tool \\"tides_lookup\\" is not loaded; call tool_search first"}', '{"name":"tides_lookup"}');
    expect(searchStep([notLoaded, search, lookup]).error).toMatch(/is "call_tool", not tool_search/);
  });

  it('accepts a pretty-printed unknown-tool refusal', () => {
    const pretty = step('call_tool', '{\n  "error": "unknown tool \\"relay-tides\\""\n}');
    expect(searchStep([pretty, search, lookup])).toEqual({ index: 1 });
  });

  it('fails when a call before tool_search only mentions an unknown tool in its output', () => {
    const mentions = step('call_tool', 'weather: unknown tool "relay-tides" is not a port', '{"name":"weather"}');
    expect(searchStep([mentions, search, lookup]).error).toMatch(/is "call_tool", not tool_search/);
  });

  it('fails when the tool_search result does not name tides_lookup', () => {
    const empty = step('tool_search', '{"loaded":[]}');
    expect(searchStep([guessed, empty, lookup]).error).toMatch(/does not name tides_lookup/);
  });
});

describe('chat-tool-search detailProblem', () => {
  const nonce = 'Verify1234';

  it('passes a call_tool step whose detail names tides_lookup', () => {
    expect(detailProblem([lookup], nonce)).toBeNull();
  });

  it('passes a direct tides_lookup step whose detail carries the nonce', () => {
    expect(detailProblem([step('tides_lookup', 'TIDE-1234abcd', `{"port":"${nonce}"}`)], nonce)).toBeNull();
  });

  it('fails a call_tool step whose detail is empty', () => {
    expect(detailProblem([step('call_tool', 'TIDE-1234abcd', '{}')], nonce)).toMatch(/no call_tool step's detail shows tides_lookup/);
  });

  it('does not count a guessed call before tool_search as the shown call', () => {
    const guess = step('call_tool', '{"error":"unknown tool \\"relay_tides_lookup\\""}', '{"name":"relay_tides_lookup"}');
    const steps = [guess, search, step('tides_lookup', 'TIDE-1234abcd', '{}')];
    expect(detailProblem(steps.slice(searchStep(steps).index + 1), nonce)).toMatch(/no tides_lookup step shows its arguments/);
  });

  it('fails a direct tides_lookup step whose detail lacks the nonce', () => {
    expect(detailProblem([step('tides_lookup', 'TIDE-1234abcd', '{}')], nonce)).toMatch(/no tides_lookup step shows its arguments/);
  });
});
