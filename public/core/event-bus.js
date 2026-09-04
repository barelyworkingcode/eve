class EventBus {
  constructor() {
    this._handlers = new Map();
  }

  on(event, handler) {
    if (!this._handlers.has(event)) {
      this._handlers.set(event, new Set());
    }
    this._handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this._handlers.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this._handlers.delete(event);
    }
  }

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
