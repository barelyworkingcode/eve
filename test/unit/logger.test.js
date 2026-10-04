const { Logger, NullLogger } = require('../../logger');

const T0 = Date.parse('2026-01-02T03:04:05.678Z');

function setup(level, opts = {}) {
  const writes = [];
  const clock = { t: T0 };
  const stream = { write: (s) => { writes.push(s); return true; } };
  const logger = new Logger(level, { stream, now: () => clock.t, service: 'eve', ...opts });
  return { logger, clock, lines: () => writes.map((w) => JSON.parse(w)) };
}
const emitAll = (l) => { l.debug('d'); l.info('i'); l.warn('w'); l.error('e'); };

describe('Logger level filtering', () => {
  it.each([
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ])('at %s writes %j', (level, expected) => {
    const { logger, lines } = setup(level);
    emitAll(logger);
    expect(lines().map((l) => l.level)).toEqual(expected);
    expect(logger.level).toBe(level);
  });
});

describe('Logger.fromEnv', () => {
  let spy;
  let written;
  beforeEach(() => {
    written = [];
    spy = jest.spyOn(process.stderr, 'write').mockImplementation((s) => { written.push(String(s)); return true; });
  });
  afterEach(() => spy.mockRestore());
  const parsed = () => written.filter((w) => w.startsWith('{')).map((w) => JSON.parse(w));

  it('reads RELAY_LOG_LEVEL', () => {
    expect(Logger.fromEnv({ RELAY_LOG_LEVEL: 'warn' }).level).toBe('warn');
    expect(Logger.fromEnv({ RELAY_LOG_LEVEL: 'debug' }).level).toBe('debug');
  });

  it('ignores the old LOG_LEVEL and defaults to info without a warning', () => {
    const logger = Logger.fromEnv({ LOG_LEVEL: 'debug' });
    expect(logger.level).toBe('info');
    logger.debug('quiet');
    expect(parsed()).toEqual([]);
  });

  it('falls back to info on an invalid level with one warn line that omits the value', () => {
    const logger = Logger.fromEnv({ RELAY_LOG_LEVEL: 'verbose-zq7' });
    expect(logger.level).toBe('info');
    logger.info('after');
    logger.warn('again');
    const levelLines = parsed().filter((l) => l.op === 'log.level');
    expect(levelLines).toHaveLength(1);
    expect(levelLines[0].level).toBe('warn');
    expect(written.join('')).not.toContain('verbose-zq7');
  });
});

describe('debug window', () => {
  it('stays at debug at 29:59, then writes one warn line at 30:00 and filters debug for good', () => {
    const { logger, clock, lines } = setup('debug');
    clock.t = T0 + 30 * 60 * 1000 - 1000;
    logger.debug('still on');
    expect(lines().map((l) => l.msg)).toEqual(['still on']);

    clock.t = T0 + 30 * 60 * 1000;
    logger.debug('too late');
    logger.debug('again');
    logger.info('kept');
    clock.t += 60 * 60 * 1000;
    logger.debug('much later');
    logger.info('kept too');

    const after = lines().slice(1);
    expect(after.filter((l) => l.op === 'log.level')).toHaveLength(1);
    expect(after.find((l) => l.op === 'log.level').level).toBe('warn');
    expect(after.filter((l) => l.level === 'debug')).toEqual([]);
    expect(after.map((l) => l.msg)).toEqual(expect.arrayContaining(['kept', 'kept too']));
  });

  it('never warns for a logger that started at info', () => {
    const { logger, clock, lines } = setup('info');
    clock.t = T0 + 31 * 60 * 1000;
    logger.info('x');
    expect(lines().filter((l) => l.op === 'log.level')).toEqual([]);
  });
});

describe('child and withTrace', () => {
  it('puts the prefix in the component key, nested with a colon', () => {
    const { logger, lines } = setup('debug');
    logger.child('STT').info('ready');
    logger.child('TTS').child('browser').info('loaded');
    expect(lines().map((l) => [l.component, l.msg])).toEqual([['STT', 'ready'], ['TTS:browser', 'loaded']]);
  });

  it('inherits the parent level', () => {
    const { logger, lines } = setup('error');
    const child = logger.child('Module');
    child.info('suppressed');
    child.error('shown');
    expect(lines().map((l) => l.msg)).toEqual(['shown']);
  });

  it('withTrace stamps trace_id on its own lines only, and keeps the component', () => {
    const { logger, lines } = setup('info');
    const traced = logger.child('Relay').withTrace('abcd1234efgh');
    traced.info('inside');
    logger.info('outside');
    const [inside, outside] = lines();
    expect(inside).toMatchObject({ trace_id: 'abcd1234efgh', component: 'Relay' });
    expect(outside.trace_id).toBe('');
  });
});

describe('NullLogger', () => {
  it('writes nothing and never throws', () => {
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = new NullLogger();
      expect(() => { emitAll(logger); logger.info('x', { a: 1 }, new Error('e')); }).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('child and withTrace return itself', () => {
    const logger = new NullLogger();
    expect(logger.child('STT')).toBe(logger);
    expect(logger.withTrace('abcd1234efgh')).toBe(logger);
  });
});
