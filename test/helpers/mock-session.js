const path = require('path');

class MockWebSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.sentMessages = [];
  }

  send(data) {
    this.sentMessages.push(JSON.parse(data));
  }

  getMessages(type) {
    return this.sentMessages.filter(m => m.type === type);
  }

  getLastMessage(type) {
    const msgs = this.getMessages(type);
    return msgs[msgs.length - 1] || null;
  }

  clear() {
    this.sentMessages = [];
  }
}

function createMockSession(overrides = {}) {
  const ws = overrides.ws || new MockWebSocket();
  return {
    sessionId: 'test-session-id',
    model: 'haiku',
    directory: path.join(__dirname, '..', '..'),
    projectId: null,
    processing: false,
    ws,
    messages: [],
    stats: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0
    },
    saveHistory: jest.fn(),
    ...overrides
  };
}

module.exports = { MockWebSocket, createMockSession };
