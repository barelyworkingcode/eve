// Jest global setup (setupFilesAfterEnv) — runs in every test file's sandbox
// before its tests.
//
// Why this exists: under Jest 30 + Node 26, `jest.useFakeTimers()` followed by
// `jest.useRealTimers()` does NOT restore the global timer functions — it
// leaves `setTimeout`/`clearTimeout`/etc. as `undefined`. Any test declared
// after a fake-timer test then blows up with "ReferenceError: clearTimeout is
// not defined" the moment product code touches a timer (file-watcher.js debounce
// scheduling was the first casualty). The product code is correct — in real Node
// those globals always exist; this is purely a Jest teardown bug.
//
// Fix: snapshot the pristine timer globals once per test file (captured here at
// setup time, before any test mutates them) and force-restore them after every
// test. This makes the suite immune to fake-timer leakage regardless of which
// test enables fake timers or whether it remembers to undo them.

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
  // useRealTimers() may itself null the globals (the bug we're guarding), so
  // call it first, then unconditionally restore the captured real functions.
  jest.useRealTimers();
  Object.assign(global, REAL_TIMERS);
});
