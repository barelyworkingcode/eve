/**
 * Container - lightweight dependency injection.
 * Modules register themselves by name; others request by name.
 */
class Container {
  constructor() {
    this._services = new Map();
  }

  register(name, instance) {
    this._services.set(name, instance);
  }

  get(name) {
    const service = this._services.get(name);
    if (!service) {
      throw new Error(`[Container] Service not found: ${name}`);
    }
    return service;
  }

  has(name) {
    return this._services.has(name);
  }

  entries() {
    return this._services.entries();
  }
}
