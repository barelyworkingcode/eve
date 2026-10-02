// A failed routine's reason lives in the newest history entry. This cache is
// shared by the project page and the Routines page: one fetch per
// (task, lastRun), for at most `limit` tasks, never polled. A newer run
// supersedes the task's older entry, so the cap counts tasks.
class RoutineHistory {
  // load(taskId) → Promise<history[]>; onChange() runs when an entry lands.
  constructor({ load, onChange, limit = 20 }) {
    this._load = load;
    this._onChange = onChange;
    this._limit = limit;
    this._cache = new Map();
  }

  // The newest history entry of a failed task, or null (not failed, not
  // loaded yet, or over the cap).
  lastExec(task) {
    if (task.lastStatus !== 'error' && task.lastStatus !== 'timeout') return null;
    return this.newest(task);
  }

  // The same for a task of any status.
  newest(task) {
    const key = `${task.id}|${task.lastRun}`;
    if (this._cache.has(key)) return this._cache.get(key);
    if (this._cache.size >= this._limit) return null;
    for (const k of this._cache.keys()) if (k.startsWith(`${task.id}|`)) this._cache.delete(k);
    this._cache.set(key, null);
    Promise.resolve(this._load(task.id)).then((history) => {
      this._cache.set(key, Array.isArray(history) ? history[0] || null : null);
      this._onChange();
    });
    return null;
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = RoutineHistory;
