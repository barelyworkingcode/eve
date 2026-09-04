// Under Jest 30 + Node 26, `jest.useFakeTimers()` followed by `jest.useRealTimers()`
// does not restore the global timer functions — it leaves `setTimeout`/`clearTimeout`/etc.
// as `undefined`, so any later test that touches a timer throws "ReferenceError:
// clearTimeout is not defined". The product code is correct; this is a Jest teardown bug.
// Snapshot the real timer globals here before any test mutates them, and force-restore
// them after every test regardless of whether the test remembers to undo fake timers.

const REAL_TIMERS = {
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout,
  setInterval: global.setInterval,
  clearInterval: global.clearInterval,
  setImmediate: global.setImmediate,
  clearImmediate: global.clearImmediate,
  queueMicrotask: global.queueMicrotask,
};

afterEach(() => {
  jest.useRealTimers();
  Object.assign(global, REAL_TIMERS);
});
