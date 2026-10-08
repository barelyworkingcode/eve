// chat-tool-search's step-order rule (eve#202): a failed call_tool on an
// unknown name may come before tool_search; nothing else may.
const { searchStep } = require('../../devboxverify/journeys-tool-search');

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
    expect(searchStep([lookup, search, lookup]).error).toMatch(/call_tool/);
  });

  it('fails when a call before tool_search was refused for another reason', () => {
    const notLoaded = step('call_tool', '{"error":"tool \\"tides_lookup\\" is not loaded; call tool_search first"}', '{"name":"tides_lookup"}');
    expect(searchStep([notLoaded, search, lookup]).error).toMatch(/call_tool/);
  });

  it('fails when the tool_search result does not name tides_lookup', () => {
    const empty = step('tool_search', '{"loaded":[]}');
    expect(searchStep([guessed, empty, lookup]).error).toMatch(/does not name tides_lookup/);
  });
});
