const http = require('http');
const fs = require('fs');
const path = require('path');
const LMStudioProvider = require('../../../providers/lmstudio-provider');
const { MockWebSocket, createMockSession } = require('../../helpers/mock-session');

// Check if LM Studio config exists and server is reachable
let serverAvailable = false;
const configPath = path.join(__dirname, '..', '..', '..', 'data', 'lmstudio-config.json');
try {
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const url = new URL(config.baseUrl || 'http://localhost:1234/v1');
    // Synchronous check: try to connect
    const { execSync } = require('child_process');
    execSync(`curl -sf -o /dev/null --max-time 2 ${url.origin}/v1/models`, { stdio: 'ignore' });
    serverAvailable = true;
  }
} catch (e) {
  // Config not found or server not running
}

const describeIfServer = serverAvailable ? describe : describe.skip;

describeIfServer('LMStudioProvider (integration)', () => {
  let provider;
  let session;
  let ws;
  let config;

  function waitForComplete(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for message_complete after ${timeoutMs}ms`));
      }, timeoutMs);

      const check = setInterval(() => {
        if (ws.getMessages('message_complete').length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
        // Also check for errors
        const errors = ws.getMessages('error');
        if (errors.length > 0) {
          clearInterval(check);
          clearTimeout(timeout);
          reject(new Error(errors[0].message));
        }
      }, 100);
    });
  }

  function getTextContent() {
    let text = '';
    for (const msg of ws.sentMessages) {
      if (msg.type === 'llm_event' && msg.event?.type === 'assistant' && msg.event?.delta?.text) {
        text += msg.event.delta.text;
      }
    }
    return text;
  }

  beforeEach(() => {
    ws = new MockWebSocket();
    config = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'data', 'lmstudio-config.json'), 'utf8'
    ));
    const modelId = config.models?.[0]?.id;
    if (!modelId) {
      throw new Error('No models configured in lmstudio-config.json');
    }

    session = createMockSession({
      ws,
      model: modelId,
      directory: path.join(__dirname, '..', '..', '..')
    });
    provider = new LMStudioProvider(session);
  });

  afterEach(() => {
    provider.kill();
  });

  it('responds to a simple message', async () => {
    provider.sendMessage('Say hello in one sentence.');
    await waitForComplete();

    const content = getTextContent();
    expect(content.length).toBeGreaterThan(0);
  });

  it('handles file attachment', async () => {
    const readmePath = path.join(__dirname, '..', '..', '..', 'README.md');
    const readmeContent = fs.readFileSync(readmePath, 'utf8');

    provider.sendMessage(
      'Summarize this file in one sentence.',
      [{ name: 'README.md', content: readmeContent, type: 'text' }]
    );
    await waitForComplete();

    const content = getTextContent();
    expect(content.length).toBeGreaterThan(0);
  });

  it('maintains conversation history', async () => {
    provider.sendMessage('Say hello in one sentence.');
    await waitForComplete();

    ws.clear();
    provider.sendMessage('What was the first thing I asked you?');
    await waitForComplete();

    const content = getTextContent();
    expect(content.length).toBeGreaterThan(0);
    expect(provider.conversationHistory.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant
  });
});
