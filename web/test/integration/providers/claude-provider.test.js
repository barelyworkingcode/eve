const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ClaudeProvider = require('../../../providers/claude-provider');
const { createMockSession } = require('../../helpers/mock-session');

// Check if Claude CLI is available
let cliAvailable = false;
try {
  execSync('which claude', { stdio: 'ignore' });
  cliAvailable = true;
} catch (e) {
  // CLI not found
}

const describeIfCli = cliAvailable ? describe : describe.skip;

describeIfCli('ClaudeProvider (integration)', () => {
  let provider;
  let session;
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
    let text = '';
    for (const event of events) {
      if (event.type === 'assistant' && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            text += block.text;
          }
        }
      }
    }
    return text;
  }

  beforeEach(() => {
    events = [];
    session = createMockSession({
      model: 'haiku',
      directory: path.join(__dirname, '..', '..', '..')
    });
    provider = new ClaudeProvider(session);

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

  it('handles file attachment', async () => {
    const readmePath = path.join(__dirname, '..', '..', '..', 'README.md');
    const readmeContent = fs.readFileSync(readmePath, 'utf8');

    provider.sendMessage(
      'Summarize this file in one sentence.',
      [{ name: 'README.md', content: readmeContent, type: 'text' }]
    );
    await waitForResult();

    const content = getTextContent();
    expect(content.length).toBeGreaterThan(0);
  });
});
