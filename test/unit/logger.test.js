const { Logger, ChildLogger, NullLogger } = require('../../logger');

describe('Logger', () => {
  let originalConsole;

  beforeEach(() => {
    originalConsole = {
      debug: console.debug,
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
  });

  afterEach(() => {
    console.debug = originalConsole.debug;
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  test('logs at all levels when level is debug', () => {
    const logger = new Logger('debug');
    const calls = { debug: [], log: [], warn: [], error: [] };

    console.debug = (...args) => calls.debug.push(args);
    console.log = (...args) => calls.log.push(args);
    console.warn = (...args) => calls.warn.push(args);
    console.error = (...args) => calls.error.push(args);

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(calls.debug).toHaveLength(1);
    expect(calls.log).toHaveLength(1);
    expect(calls.warn).toHaveLength(1);
    expect(calls.error).toHaveLength(1);
  });

  test('suppresses debug and info at level warn', () => {
    const logger = new Logger('warn');
    const calls = { debug: [], log: [], warn: [], error: [] };

    console.debug = (...args) => calls.debug.push(args);
    console.log = (...args) => calls.log.push(args);
    console.warn = (...args) => calls.warn.push(args);
    console.error = (...args) => calls.error.push(args);

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(calls.debug).toHaveLength(0);
    expect(calls.log).toHaveLength(0);
    expect(calls.warn).toHaveLength(1);
    expect(calls.error).toHaveLength(1);
  });

  test('suppresses all at level none', () => {
    const logger = new Logger('none');
    const calls = { debug: [], log: [], warn: [], error: [] };

    console.debug = (...args) => calls.debug.push(args);
    console.log = (...args) => calls.log.push(args);
    console.warn = (...args) => calls.warn.push(args);
    console.error = (...args) => calls.error.push(args);

    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    expect(calls.debug).toHaveLength(0);
    expect(calls.log).toHaveLength(0);
    expect(calls.warn).toHaveLength(0);
    expect(calls.error).toHaveLength(0);
  });

  test('setLevel changes filtering dynamically', () => {
    const logger = new Logger('debug');
    const calls = [];

    console.debug = (...args) => calls.push(args);
    logger.debug('before');
    expect(calls).toHaveLength(1);

    logger.setLevel('error');
    logger.debug('after');
    expect(calls).toHaveLength(1); // still 1 — debug suppressed

    logger.setLevel('debug');
    logger.debug('restored');
    expect(calls).toHaveLength(2);
  });

  test('level getter returns current level name', () => {
    const logger = new Logger('warn');
    expect(logger.level).toBe('warn');
    logger.setLevel('error');
    expect(logger.level).toBe('error');
  });

  test('invalid level string keeps current level', () => {
    const logger = new Logger('info');
    logger.setLevel('invalid');
    expect(logger.level).toBe('info');
  });
});

describe('ChildLogger', () => {
  let originalConsole;

  beforeEach(() => {
    originalConsole = { log: console.log };
  });

  afterEach(() => {
    console.log = originalConsole.log;
  });

  test('prepends prefix to messages', () => {
    const logger = new Logger('debug');
    const child = logger.child('STT');
    const calls = [];
    console.log = (...args) => calls.push(args);

    child.info('ready');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('[STT]');
    expect(calls[0][1]).toBe('ready');
  });

  test('nested child produces combined prefix', () => {
    const logger = new Logger('debug');
    const child = logger.child('TTS');
    const sub = child.child('browser');
    const calls = [];
    console.log = (...args) => calls.push(args);

    sub.info('loaded');
    expect(calls[0][0]).toBe('[TTS:browser]');
    expect(calls[0][1]).toBe('loaded');
  });

  test('inherits parent level filtering', () => {
    const logger = new Logger('error');
    const child = logger.child('Module');
    const calls = [];
    console.log = (...args) => calls.push(args);

    child.info('suppressed');
    expect(calls).toHaveLength(0);
  });

  test('parent setLevel affects child', () => {
    const logger = new Logger('debug');
    const child = logger.child('X');
    const calls = [];
    console.log = (...args) => calls.push(args);

    child.info('before');
    expect(calls).toHaveLength(1);

    logger.setLevel('error');
    child.info('after');
    expect(calls).toHaveLength(1); // still 1
  });
});

describe('NullLogger', () => {
  test('all methods are no-ops', () => {
    const logger = new NullLogger();
    // Should not throw
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    logger.setLevel('debug');
  });

  test('child returns itself', () => {
    const logger = new NullLogger();
    const child = logger.child('STT');
    expect(child).toBe(logger);
  });

  test('level returns none', () => {
    const logger = new NullLogger();
    expect(logger.level).toBe('none');
  });
});
