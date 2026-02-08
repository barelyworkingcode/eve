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

  // Returns provider-specific state to persist (override in subclasses)
  getSessionState() { return null; }

  // Restore provider-specific state from persisted data (override in subclasses)
  restoreSessionState(state) {}

  // Clear provider-specific state from a session (e.g., before /clear).
  // Override in subclasses that persist state on the session object.
  static clearSessionState(session) {
    delete session.providerState;
  }

  // Returns commands this provider handles
  // Override in subclasses to define provider-specific commands
  static getCommands() {
    return [];
  }

  // Handle a provider-specific command
  // Returns true if handled, false to pass through to LLM
  handleCommand(command, args, sendSystemMessage, rawText) {
    return false;
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
