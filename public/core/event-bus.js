/**
 * EventBus - synchronous pub/sub for decoupled module communication.
 * Replaces direct app.* cross-references between modules.
 */
class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function.
   */
  on(event, handler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Unsubscribe from an event.
   */
  off(event, handler) {
    const handlers = this._handlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this._handlers.delete(event);
    }
  }

  /**
   * Emit an event to all subscribers.
   */
  emit(event, data) {
    const handlers = this._handlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${event}":`, err);
      }
    }
  }
}
