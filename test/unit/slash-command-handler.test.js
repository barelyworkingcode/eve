// Verifies dispatch + the exact frames sent to the browser, since the client
// dispatcher keys off these `type`s.
const SlashCommandHandler = require('../../slash-command-handler');

function mockWs() {
  return {
    sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
  };
}

function mockRelay(overrides = {}) {
  return {
    currentSessionId: 'sess-1',
    sessionDirectory: '/work/proj',
    currentProjectId: 'proj-1',
    cleared: [],
    clearSession(id) { this.cleared.push(id); },
    ...overrides,
  };
}

describe('SlashCommandHandler', () => {
  let handler;
  beforeEach(() => { handler = new SlashCommandHandler(); });

  it('ignores non-slash input and sends nothing', () => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay(), 'hello there')).toBe(false);
    expect(ws.sent).toEqual([]);
  });

  it('returns false for an unknown command (forwarded to relay)', () => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay(), '/wat')).toBe(false);
    expect(ws.sent).toEqual([]);
  });

  it('/clear clears the active session and completes', () => {
    const ws = mockWs();
    const relay = mockRelay();
    expect(handler.handle(ws, relay, '/clear')).toBe(true);
    expect(relay.cleared).toEqual(['sess-1']);
    expect(ws.sent.map(m => m.type)).toEqual(['message_complete']);
  });

  it('/clear without an active session still completes, no clearSession', () => {
    const ws = mockWs();
    const relay = mockRelay({ currentSessionId: null });
    expect(handler.handle(ws, relay, '/clear')).toBe(true);
    expect(relay.cleared).toEqual([]);
    expect(ws.sent.map(m => m.type)).toEqual(['message_complete']);
  });

  it('/help sends a system_message then completes', () => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay(), '/help')).toBe(true);
    expect(ws.sent.map(m => m.type)).toEqual(['system_message', 'message_complete']);
    expect(ws.sent[0].message).toContain('/clear');
  });

  it.each(['/zsh', '/bash'])('%s requests a shell terminal at the session dir, carrying the project id', (cmd) => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay(), cmd)).toBe(true);
    const req = ws.sent.find(m => m.type === 'terminal_request');
    expect(req).toMatchObject({ command: 'shell', directory: '/work/proj', projectId: 'proj-1' });
  });

  it.each(['/zsh', '/bash'])('%s still opens an ad-hoc terminal with no project active', (cmd) => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay({ currentProjectId: null }), cmd)).toBe(true);
    const req = ws.sent.find(m => m.type === 'terminal_request');
    expect(req).toMatchObject({ command: 'shell', projectId: '' });
  });

  it('/claude requests a claude terminal, carrying the project id', () => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay(), '/claude')).toBe(true);
    const req = ws.sent.find(m => m.type === 'terminal_request');
    expect(req).toMatchObject({ command: 'claude-code', projectId: 'proj-1' });
  });

  it('/rh requests a relayHarness terminal, carrying the project id', () => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay(), '/rh')).toBe(true);
    const req = ws.sent.find(m => m.type === 'terminal_request');
    expect(req).toMatchObject({ command: 'rh', directory: '/work/proj', projectId: 'proj-1' });
  });

  it('/rh with no active project refuses with a system message instead of a broken terminal', () => {
    const ws = mockWs();
    expect(handler.handle(ws, mockRelay({ currentProjectId: null }), '/rh')).toBe(true);
    expect(ws.sent.map(m => m.type)).toEqual(['system_message', 'message_complete']);
    expect(ws.sent[0].message).toMatch(/project/i);
    expect(ws.sent.find(m => m.type === 'terminal_request')).toBeUndefined();
  });

  it('is case-insensitive and tolerates trailing args', () => {
    const ws = mockWs();
    const relay = mockRelay();
    expect(handler.handle(ws, relay, '/CLEAR  please')).toBe(true);
    expect(relay.cleared).toEqual(['sess-1']);
  });
});
