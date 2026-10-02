/**
 * Today's data sources. Each wraps one existing loader (app.js#loadProjects,
 * #loadSessions, task-manager.js#loadTasks), which keeps its behaviour for the
 * sidebar and additionally reports begin/succeed/fail here. A part reads
 * `status` ('loading' | 'ready' | 'error') and `describe()`; two parts on one
 * source fail together, which is accepted (docs/design-today-s1.md).
 */
class TodaySource {
  constructor({ name, label, bus, state, load, timeoutMs = 20000, downText = "Can't reach relay." }) {
    this.name = name;
    this.downText = downText;
    this.label = label;
    this.bus = bus;
    this.state = state;
    this._load = load;
    this.timeoutMs = timeoutMs;
    this.status = 'loading';
    this.error = null;
    this._started = false;
    this._timer = null;
  }

  // The first mount starts nothing: the app's own startup chain loads each
  // source. A source that never answers (no socket) is reported, not left spinning.
  ensure() {
    if (this._started || this.status !== 'loading') return;
    this._started = true;
    this._timer = setTimeout(() => {
      if (this.status === 'loading') this.fail(Object.assign(new Error('timeout'), { timeout: true }));
    }, this.timeoutMs);
  }

  begin() {
    this.status = 'loading';
    this.error = null;
    this._notify();
  }

  succeed() {
    clearTimeout(this._timer);
    this.status = 'ready';
    this.error = null;
    this._notify();
  }

  fail(err) {
    clearTimeout(this._timer);
    this.status = 'error';
    this.error = err;
    this._notify();
  }

  reload() {
    this.begin();
    this._started = false;
    this.ensure();
    return Promise.resolve(this._load()).catch(() => {});
  }

  describe() {
    const err = this.error;
    if (this.state?.connection?.relay === false) return "Can't reach relay.";
    const down = err && (err.timeout || err.network || [404, 502, 503, 504].includes(err.status));
    return down ? this.downText : `Couldn't load ${this.label}.`;
  }

  _notify() {
    this.bus.emit(`today:source:${this.name}`, { status: this.status });
  }
}

class TodaySources {
  constructor({ bus, state, loaders }) {
    this.projects = new TodaySource({ name: 'projects', label: 'projects', bus, state, load: loaders.projects });
    this.sessions = new TodaySource({ name: 'sessions', label: 'threads', bus, state, load: loaders.sessions });
    this.tasks = new TodaySource({ name: 'tasks', label: 'tasks', bus, state, load: loaders.tasks, downText: "Can't reach the scheduler." });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { TodaySource, TodaySources };
