#!/usr/bin/env node

const ClaudeProvider = require('./providers/claude-provider');
const fs = require('fs');
const path = require('path');

class TestSession {
  constructor() {
    this.model = 'haiku';
    this.directory = __dirname;
    this.sessionId = 'test-session';
    this.processing = false;
    this.ws = null;
    this.stats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      contextWindow: 200000
    };
    this.events = [];
  }

  recordEvent(event) {
    this.events.push(event);
  }

  getTextContent() {
    let text = '';
    for (const event of this.events) {
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

  hasResult() {
    return this.events.some(e => e.type === 'result');
  }

  clearEvents() {
    this.events = [];
  }
}

async function runTest() {
  console.log('Starting ClaudeProvider test...\n');

  const session = new TestSession();
  const provider = new ClaudeProvider(session);

  // Override handleEvent to capture events
  const originalHandleEvent = provider.handleEvent.bind(provider);
  provider.handleEvent = (event) => {
    session.recordEvent(event);
    originalHandleEvent(event);
  };

  // Test 1: Simple hello
  console.log('Test 1: Sending hello message...');
  await new Promise((resolve) => {
    provider.sendMessage('Say hello in one sentence.');

    const checkComplete = setInterval(() => {
      if (session.hasResult()) {
        clearInterval(checkComplete);
        const content = session.getTextContent();
        console.log('Response:', content.substring(0, 100));
        console.log('✓ Test 1 passed - got valid response\n');
        resolve();
      }
    }, 100);
  });

  // Test 2: Summarize README
  session.clearEvents();
  console.log('Test 2: Asking to summarize README.md...');

  const readmePath = path.join(__dirname, 'README.md');
  const readmeContent = fs.readFileSync(readmePath, 'utf8');

  await new Promise((resolve) => {
    provider.sendMessage(
      'Summarize this file in one sentence.',
      [{ name: 'README.md', content: readmeContent, type: 'text' }]
    );

    const checkComplete = setInterval(() => {
      if (session.hasResult()) {
        clearInterval(checkComplete);
        const content = session.getTextContent();
        console.log('Response:', content.substring(0, 100));
        console.log('✓ Test 2 passed - got valid response\n');
        resolve();
      }
    }, 100);
  });

  // Summary
  console.log('=== Test Summary ===');
  console.log(`Total input tokens: ${session.stats.inputTokens}`);
  console.log(`Total output tokens: ${session.stats.outputTokens}`);
  console.log(`Total cost: $${session.stats.costUsd.toFixed(4)}`);
  console.log('\n✓ All tests passed');

  provider.kill();
  process.exit(0);
}

// Handle errors
process.on('unhandledRejection', (err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

runTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
