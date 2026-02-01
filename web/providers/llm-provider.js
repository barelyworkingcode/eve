class LLMProvider {
  constructor(session) {
    this.session = session;
  }

  startProcess() {
    throw new Error('Not implemented');
  }

  sendMessage() {
    throw new Error('Not implemented');
  }

  handleEvent() {
    throw new Error('Not implemented');
  }

  kill() {
    throw new Error('Not implemented');
  }

  getMetadata() {
    throw new Error('Not implemented');
  }

  static getModels() {
    throw new Error('Not implemented');
  }

  // Normalize provider-specific events to common format
  // Default: pass through (for providers already using common format)
  normalizeEvent(event) {
    return event;
  }

  // Send normalized event to client
  sendEvent(event) {
    const normalizedEvent = this.normalizeEvent(event);
    if (this.session.ws && this.session.ws.readyState === 1) {
      this.session.ws.send(JSON.stringify({
        type: 'llm_event',
        sessionId: this.session.sessionId,
        event: normalizedEvent
      }));
    }
  }
}

module.exports = LLMProvider;
