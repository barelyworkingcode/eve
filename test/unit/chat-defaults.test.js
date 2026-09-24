const { applyChatDefaults } = require('../../public/core/ui-utils.js');

const MODELS = [
  { value: 'chat-a', provider: 'chat' },
  { value: 'pi/b', provider: 'pi' },
  { value: 'sonnet', provider: 'claude' },
];
const frame = (model, settings = null) => ({ type: 'create_session', projectId: 'p1', model, settings });

describe('applyChatDefaults', () => {
  it.each(['chat-a', 'pi/b'])('%s gets both flags', (model) => {
    expect(applyChatDefaults(frame(model), MODELS))
      .toEqual({ ...frame(model), settings: { useRelayTools: true }, appendClaudeMd: true });
  });

  it.each([
    ['Claude', 'sonnet', MODELS],
    ['unknown', 'mystery', MODELS],
    ['empty list', 'chat-a', []],
  ])('%s model gets neither flag', (_, model, models) => {
    const input = frame(model, { thinking: 'high' });
    const out = applyChatDefaults(input, models);
    expect(out).toEqual(input);
    expect(out).not.toHaveProperty('appendClaudeMd');
  });

  it('merges existing settings and overrides false flags, without mutating', () => {
    const input = { ...frame('pi/b', { thinkingLevel: 'high', useRelayTools: false }), appendClaudeMd: false };
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = applyChatDefaults(input, MODELS);
    expect(out.settings).toEqual({ thinkingLevel: 'high', useRelayTools: true });
    expect(out.appendClaudeMd).toBe(true);
    expect(input).toEqual(snapshot);
  });
});
