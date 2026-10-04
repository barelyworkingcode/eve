const { newTraceId, isValidTraceId, acceptTraceId, isOnBoxHost, traceMiddleware } = require('../../trace');

const HEX32 = /^[0-9a-f]{32}$/;

describe('newTraceId', () => {
  it('is 32 lowercase hex characters and distinct per call', () => {
    const ids = Array.from({ length: 500 }, () => newTraceId());
    ids.forEach((id) => expect(id).toMatch(HEX32));
    expect(new Set(ids).size).toBe(500);
  });
});

describe('trace id validation', () => {
  it.each([
    ['empty', '', false],
    ['7 chars', 'a'.repeat(7), false],
    ['8 chars', 'a'.repeat(8), true],
    ['64 chars', 'a'.repeat(64), true],
    ['65 chars', 'a'.repeat(65), false],
    ['dash and underscore', 'ab-cd_ef-12', true],
    ['dot', 'abcdefgh.ij', false],
    ['space', 'abcdefgh ij', false],
    ['trailing newline', 'abcdefgh\n', false],
    ['embedded newline', 'abcdefgh\n{"level":"error"}', false],
    ['comma list', 'a,b', false],
    ['not a string', 12345678, false],
    ['undefined', undefined, false],
  ])('isValidTraceId: %s', (_, value, valid) => {
    expect(isValidTraceId(value)).toBe(valid);
  });

  it('acceptTraceId keeps a valid id and replaces anything else with a fresh one', () => {
    expect(acceptTraceId('abcd1234efgh')).toBe('abcd1234efgh');
    for (const bad of ['', 'short', 'abcdefgh\n', 'a,b', undefined]) {
      const out = acceptTraceId(bad);
      expect(out).toMatch(HEX32);
      expect(out).not.toBe(bad);
    }
  });
});

describe('isOnBoxHost', () => {
  it.each([
    ['127.9.9.9', true], ['127.0.0.1', true], ['::1', true], ['LOCALHOST', true], ['localhost', true],
    ['relay.example', false], ['10.0.0.5', false], ['127.evil.example', false],
  ])('%s -> %s', (host, expected) => {
    expect(isOnBoxHost(host)).toBe(expected);
  });
});

describe('traceMiddleware', () => {
  function run(headers) {
    const req = { headers };
    const next = jest.fn();
    traceMiddleware()(req, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req.traceId;
  }

  it('keeps a valid inbound X-Trace-Id', () => {
    expect(run({ 'x-trace-id': 'abcd1234efgh' })).toBe('abcd1234efgh');
  });

  it('uses the first value when the header repeats', () => {
    expect(run({ 'x-trace-id': ['first-trace-1', 'second-trace-2'] })).toBe('first-trace-1');
  });

  it.each([
    ['missing', {}],
    ['invalid', { 'x-trace-id': 'bad id!' }],
  ])('creates a fresh id when the header is %s', (_, headers) => {
    expect(run(headers)).toMatch(HEX32);
  });

  it('never writes a rejected value to stderr, stdout or console', () => {
    const sinks = [
      jest.spyOn(process.stderr, 'write').mockImplementation(() => true),
      jest.spyOn(process.stdout, 'write').mockImplementation(() => true),
    ];
    try {
      run({ 'x-trace-id': 'zq7-forged\n{"level":"error"}' });
      for (const s of sinks) expect(s.mock.calls.flat().join('')).not.toContain('zq7-forged');
    } finally { sinks.forEach((s) => s.mockRestore()); }
  });
});
