// applyChatDefaults(frame, models) decides the relay-tools / CLAUDE.md flags
// for every web and voice chat launch. Non-Claude providers get both; Claude
// and any model we can't identify get neither, since an unknown model might
// be Claude.
const { applyChatDefaults } = require('../../public/core/ui-utils.js');

const MODELS = [
  { value: 'chat-a', label: 'Chat A', provider: 'chat' },
  { value: 'pi/b', label: 'Pi B', provider: 'pi' },
  { value: 'sonnet', label: 'Claude Sonnet', provider: 'claude' },
];

function frame(overrides = {}) {
  return { type: 'create_session', projectId: 'p1', model: 'chat-a', settings: null, name: 'Acme - Chat', ...overrides };
}

describe('applyChatDefaults', () => {
  it('is exported as a function', () => {
    expect(typeof applyChatDefaults).toBe('function');
  });

  it('adds both flags for a chat-provider model', () => {
    const out = applyChatDefaults(frame(), MODELS);
    expect(out).toEqual({
      type: 'create_session', projectId: 'p1', model: 'chat-a', name: 'Acme - Chat',
      settings: { useRelayTools: true },
      appendClaudeMd: true,
    });
  });

  it('adds both flags for a pi-provider model', () => {
    const out = applyChatDefaults(frame({ model: 'pi/b' }), MODELS);
    expect(out.settings).toEqual({ useRelayTools: true });
    expect(out.appendClaudeMd).toBe(true);
  });

  it('leaves a Claude model frame unchanged, with no appendClaudeMd key', () => {
    const input = frame({ model: 'sonnet', settings: { thinking: 'high' } });
    const out = applyChatDefaults(input, MODELS);
    expect(out).toEqual(input);
    expect(out).not.toHaveProperty('appendClaudeMd');
    expect(out.settings).toEqual({ thinking: 'high' });
    expect(out.settings).not.toHaveProperty('useRelayTools');
  });

  it('passes a Claude frame with null settings through as null', () => {
    const out = applyChatDefaults(frame({ model: 'sonnet', settings: null }), MODELS);
    expect(out.settings).toBeNull();
    expect(out).not.toHaveProperty('appendClaudeMd');
  });

  it('adds no flags for a model missing from the list', () => {
    const input = frame({ model: 'mystery-model' });
    const out = applyChatDefaults(input, MODELS);
    expect(out).toEqual(input);
    expect(out).not.toHaveProperty('appendClaudeMd');
    expect(out.settings).toBeNull();
  });

  it('adds no flags when the model list is empty (not loaded yet)', () => {
    const input = frame();
    const out = applyChatDefaults(input, []);
    expect(out).toEqual(input);
    expect(out).not.toHaveProperty('appendClaudeMd');
  });

  it('adds no flags for a model entry with no provider', () => {
    const out = applyChatDefaults(frame({ model: 'bare' }), [{ value: 'bare', label: 'Bare' }]);
    expect(out).not.toHaveProperty('appendClaudeMd');
    expect(out.settings).toBeNull();
  });

  it('keeps existing settings alongside useRelayTools', () => {
    const out = applyChatDefaults(frame({ model: 'pi/b', settings: { thinkingLevel: 'high' } }), MODELS);
    expect(out.settings).toEqual({ thinkingLevel: 'high', useRelayTools: true });
  });

  it('overrides useRelayTools: false for a non-Claude model', () => {
    const out = applyChatDefaults(frame({ settings: { useRelayTools: false } }), MODELS);
    expect(out.settings.useRelayTools).toBe(true);
    expect(out.appendClaudeMd).toBe(true);
  });

  it('overrides appendClaudeMd: false for a non-Claude model', () => {
    const out = applyChatDefaults(frame({ appendClaudeMd: false }), MODELS);
    expect(out.appendClaudeMd).toBe(true);
  });

  it('treats null or missing settings as empty for a non-Claude model', () => {
    const withNull = applyChatDefaults(frame({ settings: null }), MODELS);
    const { settings, ...noSettings } = frame();
    const missing = applyChatDefaults(noSettings, MODELS);
    expect(withNull.settings).toEqual({ useRelayTools: true });
    expect(missing.settings).toEqual({ useRelayTools: true });
  });

  it('keeps the other frame fields', () => {
    const input = frame({ systemPrompt: 'be brief', sessionType: 'voice', voice: 'af_heart' });
    const out = applyChatDefaults(input, MODELS);
    expect(out).toMatchObject({
      type: 'create_session', projectId: 'p1', model: 'chat-a', name: 'Acme - Chat',
      systemPrompt: 'be brief', sessionType: 'voice', voice: 'af_heart',
    });
  });

  it('never mutates the input frame or its settings', () => {
    const settings = { thinkingLevel: 'high', useRelayTools: false };
    const input = frame({ settings });
    const snapshot = JSON.parse(JSON.stringify(input));
    const out = applyChatDefaults(input, MODELS);
    expect(input).toEqual(snapshot);
    expect(input).not.toHaveProperty('appendClaudeMd');
    expect(out).not.toBe(input);
    expect(out.settings).not.toBe(settings);
  });

  it('returns a new object even when no flags are added', () => {
    const input = frame({ model: 'sonnet' });
    const out = applyChatDefaults(input, MODELS);
    expect(out).not.toBe(input);
  });
});
