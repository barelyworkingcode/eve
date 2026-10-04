const fs = require('fs');
const path = require('path');
const { Logger } = require('../../logger');

const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'logging-schema.json'), 'utf8'));

// Test-local checker: exactly the keywords the schema uses. Any other keyword
// throws, so a schema change cannot silently stop being checked.
const ANNOTATIONS = new Set(['$schema', '$id', 'title', 'description']);
const KEYWORDS = new Set(['type', 'required', 'enum', 'pattern', 'maxLength', 'minLength', 'minimum', 'additionalProperties', 'properties']);
function assertSupported(s) {
  for (const k of Object.keys(s)) {
    if (ANNOTATIONS.has(k)) continue;
    if (!KEYWORDS.has(k)) throw new Error(`unsupported schema keyword: ${k}`);
  }
  for (const sub of Object.values(s.properties || {})) assertSupported(sub);
}
function validate(s, v, at = '$') {
  assertSupported(s);
  const errs = [];
  const typeOk = { object: (x) => x && typeof x === 'object' && !Array.isArray(x), string: (x) => typeof x === 'string', integer: Number.isInteger };
  if (s.type && !typeOk[s.type](v)) return [`${at}: not ${s.type}`];
  if (s.enum && !s.enum.includes(v)) errs.push(`${at}: not in enum`);
  if (s.pattern && !new RegExp(s.pattern).test(v)) errs.push(`${at}: pattern`);
  if (s.maxLength !== undefined && v.length > s.maxLength) errs.push(`${at}: too long`);
  if (s.minLength !== undefined && v.length < s.minLength) errs.push(`${at}: too short`);
  if (s.minimum !== undefined && v < s.minimum) errs.push(`${at}: below minimum`);
  if (s.type === 'object') {
    for (const r of s.required || []) if (!(r in v)) errs.push(`${at}.${r}: missing`);
    for (const [k, sub] of Object.entries(s.properties || {})) if (k in v) errs.push(...validate(sub, v[k], `${at}.${k}`));
    if (s.additionalProperties === false) for (const k of Object.keys(v)) if (!(k in (s.properties || {}))) errs.push(`${at}.${k}: extra`);
  }
  return errs;
}

function setup(level = 'debug') {
  const writes = [];
  const stream = { write: (s) => { writes.push(s); return true; } };
  const logger = new Logger(level, { stream, now: () => Date.parse('2026-01-02T03:04:05.678Z'), service: 'eve' });
  return { logger, writes, lines: () => writes.map((w) => JSON.parse(w)) };
}

describe('schema checker (test-local)', () => {
  it('throws on a keyword it does not implement, even nested', () => {
    expect(() => validate({ type: 'string', format: 'date-time' }, 'x')).toThrow(/format/);
    expect(() => validate({ type: 'object', properties: { a: { type: 'string', oneOf: [] } } }, {})).toThrow(/oneOf/);
  });

  it('rejects a line that breaks the fixture', () => {
    expect(validate(schema, {})).not.toEqual([]);
    const ok = { ts: '2026-01-02T03:04:05.678Z', level: 'info', msg: 'm', service: 's', op: 'a.b', status: 'ok', duration_ms: 0, error: '', trace_id: '' };
    expect(validate(schema, ok)).toEqual([]);
    expect(validate(schema, { ...ok, ts: '2026-01-02 03:04:05' })).not.toEqual([]);
    expect(validate(schema, { ...ok, duration_ms: 1.5 })).not.toEqual([]);
  });
});

describe('Logger line format', () => {
  it.each([
    ['debug', 'ok'], ['info', 'ok'], ['warn', 'error'], ['error', 'error'],
  ])('%s: one schema-valid line, all nine keys, defaults', (level, status) => {
    const { logger, writes, lines } = setup();
    logger[level]('hello');
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const [line] = lines();
    expect(validate(schema, line)).toEqual([]);
    expect(line).toEqual({
      ts: '2026-01-02T03:04:05.678Z', level, msg: 'hello', service: 'eve',
      op: 'log', status, duration_ms: 0, error: '', trace_id: '',
    });
  });

  it('keeps a multi-line, quoted message on one line', () => {
    const { logger, writes, lines } = setup();
    logger.info('a\nb "q"\r\n{"level":"error"}');
    expect(writes).toHaveLength(1);
    expect(writes[0].indexOf('\n')).toBe(writes[0].length - 1);
    expect(lines()[0].msg).toBe('a\nb "q"\r\n{"level":"error"}');
  });

  it('carries a trailing attrs object, and valid status and op', () => {
    const { logger, lines } = setup();
    logger.info('done', { op: 'schedule.create', status: 'denied', duration_ms: 12, job_id: 'j1', session_id: 's1', method: 'POST' });
    expect(lines()[0]).toMatchObject({ msg: 'done', op: 'schedule.create', status: 'denied', duration_ms: 12, job_id: 'j1', session_id: 's1', method: 'POST' });
  });

  it('an Error argument sets error to its message and leaves out the stack', () => {
    const { logger, writes, lines } = setup();
    logger.error('upstream failed', new Error('connect refused'));
    const [line] = lines();
    expect(line.error).toBe('connect refused');
    expect(line.msg).toContain('upstream failed');
    expect(writes[0]).not.toContain('log-line.test.js');
    expect(validate(schema, line)).toEqual([]);
  });

  it.each(['ts', 'level', 'msg', 'service', 'trace_id'])('renames writer-owned attr %s to attr_%s', (key) => {
    const { logger, lines } = setup();
    logger.info('real msg', { [key]: 'forged' });
    const [line] = lines();
    expect(line[`attr_${key}`]).toBe('forged');
    expect(line.msg).toBe('real msg');
    expect(line.level).toBe('info');
    expect(line.service).toBe('eve');
    expect(line.trace_id).toBe('');
    expect(line.ts).toBe('2026-01-02T03:04:05.678Z');
    expect(validate(schema, line)).toEqual([]);
  });

  it.each([
    ['a numeric status', { status: 404 }, { http_status: 404, status: 'ok' }],
    ['an unknown status string', { status: 'weird' }, { attr_status: 'weird', status: 'ok' }],
    ['a malformed op', { op: 'Bad Op!' }, { attr_op: 'Bad Op!', op: 'log' }],
  ])('%s is moved aside, not emitted as the line value', (_, attrs, expected) => {
    const { logger, lines } = setup();
    logger.info('x', attrs);
    const [line] = lines();
    expect(line).toMatchObject(expected);
    expect(validate(schema, line)).toEqual([]);
  });

  it.each([[12.6, 13], [12.4, 12], [-5, 0]])('duration_ms %p is written as %p', (given, written) => {
    const { logger, lines } = setup();
    logger.info('x', { duration_ms: given });
    expect(lines()[0].duration_ms).toBe(written);
  });

  it('truncates msg and error to 500 characters', () => {
    const { logger, lines } = setup();
    logger.error('m'.repeat(600), new Error('e'.repeat(600)));
    const [line] = lines();
    expect(line.msg.length).toBeLessThanOrEqual(500);
    expect(line.msg.startsWith('m'.repeat(400))).toBe(true);
    expect(line.error.length).toBeLessThanOrEqual(500);
    expect(line.error.startsWith('e'.repeat(400))).toBe(true);
    expect(validate(schema, line)).toEqual([]);
  });
});
