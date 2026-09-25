// raw_output is the one frame that puts arbitrary provider text into the
// assistant reply. A raw_output whose text is a JSON object with a string
// `type` is an untranslated provider event, never reply text, and must not
// render; everything else renders exactly as before.
const MessageDispatcher = require('../../public/message-dispatcher');

const SESSION = 's1';

function makeDispatcher() {
  const renderer = { appendRawOutput: jest.fn() };
  const log = { debug: jest.fn(), info() {}, warn() {}, error() {} };
  const values = {
    logger: { child: () => log },
    messageRenderer: renderer,
    modalManager: {},
    tabManager: {},
    sidebarRenderer: {},
    terminalManager: {},
    fileBrowser: {},
    ttsManager: {},
    sttManager: {},
    voiceChatManager: {},
    taskManager: {},
    permissions: {},
    state: { currentSessionId: SESSION },
    ws: { send: jest.fn() },
    bus: { emit: jest.fn(), on: jest.fn() },
    app: {},
  };
  const dispatcher = new MessageDispatcher({ get: (name) => values[name] });
  const sendRaw = (text) => dispatcher.dispatch({ type: 'raw_output', sessionId: SESSION, text });
  return { sendRaw, renderer, log };
}

describe('MessageDispatcher raw_output for the current session', () => {
  it.each([
    ['a bare provider event', '{"type":"agent_settled"}'],
    ['a provider event with surrounding whitespace', '  {"type":"agent_settled"}\n'],
  ])('drops %s and logs it at debug', (_label, text) => {
    const { sendRaw, renderer, log } = makeDispatcher();

    sendRaw(text);

    expect(renderer.appendRawOutput).not.toHaveBeenCalled();
    const logged = log.debug.mock.calls.map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    expect(logged.some((line) => line.includes('agent_settled') && line.includes(SESSION))).toBe(true);
  });

  it.each([
    ['plain text', 'Retry succeeded on attempt 2'],
    ['a JSON number', '42'],
    ['a JSON array', '[1]'],
    ['JSON null', 'null'],
    ['an object without a type', '{"foo":"bar"}'],
    ['an object with a non-string type', '{"type":1}'],
    ['an object with an empty type', '{"type":""}'],
    ['malformed JSON starting with {', '{"type":"agent_settled"'],
  ])('renders %s unchanged', (_label, text) => {
    const { sendRaw, renderer } = makeDispatcher();

    expect(() => sendRaw(text)).not.toThrow();

    expect(renderer.appendRawOutput).toHaveBeenCalledTimes(1);
    expect(renderer.appendRawOutput).toHaveBeenCalledWith(text);
  });
});
