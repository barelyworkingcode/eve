const { execSync } = require('child_process');
const path = require('path');
const GeminiProvider = require('../../../providers/gemini-provider');
const { MockWebSocket, createMockSession } = require('../../helpers/mock-session');

// Check if Gemini CLI is available
let cliAvailable = false;
try {
  execSync('which gemini', { stdio: 'ignore' });
  cliAvailable = true;
} catch (e) {
  // CLI not found
}

const describeIfCli = cliAvailable ? describe : describe.skip;

describeIfCli('GeminiProvider (integration)', () => {
  let provider;
  let session;
  let ws;
  let events;

  function waitForResult(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for result after ${timeoutMs}ms`));
      }, timeoutMs);

      const check = setInterval(() => {
        if (events.some(e => e.type === 'result')) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 100);
    });
  }

  function getTextContent() {
    // Gemini sends streaming events via ws.send, look for llm_event messages
    let text = '';
    for (const msg of ws.sentMessages) {
      if (msg.type === 'llm_event' && msg.event?.type === 'assistant' && msg.event?.delta?.text) {
        text += msg.event.delta.text;
      }
    }
    return text;
  }

  beforeEach(() => {
    events = [];
    ws = new MockWebSocket();
    session = createMockSession({
      ws,
      model: 'auto-gemini-2.5',
      directory: path.join(__dirname, '..', '..', '..')
    });
    provider = new GeminiProvider(session);

    const originalHandleEvent = provider.handleEvent.bind(provider);
    provider.handleEvent = (event) => {
      events.push(event);
      originalHandleEvent(event);
    };
  });

  afterEach(async () => {
    provider.kill();
    // Wait for process to fully exit to avoid log-after-test warnings
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  it('responds to a simple message', async () => {
    provider.sendMessage('Say hello in one sentence.');
    await waitForResult();

    const content = getTextContent();
    expect(content.length).toBeGreaterThan(0);
  });

  it('responds to a calculation', async () => {
    provider.sendMessage('What is 2 + 2? Answer with just the number.');
    await waitForResult();

    const content = getTextContent();
    expect(content.length).toBeGreaterThan(0);
  });
});
