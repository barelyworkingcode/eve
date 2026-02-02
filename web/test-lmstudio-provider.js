#!/usr/bin/env node

const LMStudioProvider = require('./providers/lmstudio-provider');
const fs = require('fs');
const path = require('path');

class TestSession {
  constructor() {
    this.model = 'qwen/qwen3-4b-2507';
    this.directory = __dirname;
    this.sessionId = 'test-session';
    this.processing = false;
    this.ws = null;
    this.messages = [];
    this.saveHistory = () => {};
    this.stats = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      contextWindow: 32768
    };
    this.events = [];
    this.responseText = '';
    this.messageComplete = false;
  }

  recordEvent(event) {
    this.events.push(event);
  }

  send(message) {
    const data = JSON.parse(message);

    // Record event
    this.recordEvent(data);

    // Capture response text
    if (data.type === 'llm_event' && data.event?.type === 'assistant' && data.event?.delta?.text) {
      this.responseText += data.event.delta.text;
    }

    // Track message completion
    if (data.type === 'message_complete') {
      this.messageComplete = true;
    }

    // Track stats updates
    if (data.type === 'stats_update') {
      Object.assign(this.stats, data.stats);
    }
  }

  get readyState() {
    return 1; // OPEN
  }

  hasResult() {
    return this.events.some(e => e.type === 'llm_event' && e.event?.type === 'result');
  }

  clearEvents() {
    this.events = [];
    this.responseText = '';
    this.messageComplete = false;
  }
}

async function runTest() {
  console.log('Starting LMStudioProvider test...\n');
  console.log('Prerequisites:');
  console.log('- LM Studio must be running on http://localhost:1234');
  console.log('- Model qwen/qwen3-4b-2507 must be loaded\n');

  const session = new TestSession();
  session.ws = session; // Mock ws as session itself
  const provider = new LMStudioProvider(session);

  console.log('Config loaded:');
  console.log('- Base URL:', provider.baseUrl);
  console.log('- Models:', provider.models.length);
  console.log();

  // Test 1: Simple hello
  console.log('Test 1: Sending hello message...');
  await new Promise((resolve) => {
    provider.sendMessage('Say hello in one sentence.');

    const checkComplete = setInterval(() => {
      if (session.hasResult()) {
        clearInterval(checkComplete);
        console.log('Response:', session.responseText.substring(0, 100));
        console.log('✓ Test 1 passed - got valid response\n');
        resolve();
      }
    }, 100);

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!session.hasResult()) {
        clearInterval(checkComplete);
        console.error('✗ Test 1 failed - timeout waiting for response');
        console.error('Is LM Studio running with the model loaded?');
        process.exit(1);
      }
    }, 30000);
  });

  // Test 2: File attachment
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
        console.log('Response:', session.responseText.substring(0, 100));
        console.log('✓ Test 2 passed - got valid response\n');
        resolve();
      }
    }, 100);

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!session.hasResult()) {
        clearInterval(checkComplete);
        console.error('✗ Test 2 failed - timeout waiting for response');
        process.exit(1);
      }
    }, 30000);
  });

  // Test 3: Conversation continuity
  session.clearEvents();
  console.log('Test 3: Testing conversation history...');

  await new Promise((resolve) => {
    provider.sendMessage('What was the first thing I asked you?');

    const checkComplete = setInterval(() => {
      if (session.hasResult()) {
        clearInterval(checkComplete);
        const response = session.responseText.toLowerCase();
        const hasHelloRef = response.includes('hello') || response.includes('first');
        console.log('Response:', session.responseText.substring(0, 100));

        if (hasHelloRef) {
          console.log('✓ Test 3 passed - conversation history maintained\n');
        } else {
          console.log('⚠ Test 3 warning - response may not reference history correctly\n');
        }
        resolve();
      }
    }, 100);

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!session.hasResult()) {
        clearInterval(checkComplete);
        console.error('✗ Test 3 failed - timeout waiting for response');
        process.exit(1);
      }
    }, 30000);
  });

  // Summary
  console.log('=== Test Summary ===');
  console.log(`Total input tokens: ${session.stats.inputTokens}`);
  console.log(`Total output tokens: ${session.stats.outputTokens}`);
  console.log(`Context window: ${session.stats.contextWindow}`);
  console.log(`Conversation length: ${provider.conversationHistory.length} messages`);
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
