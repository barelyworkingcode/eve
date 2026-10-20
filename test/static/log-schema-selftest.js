#!/usr/bin/env node
'use strict';

// Self-test for the e2e log-schema checker (#327): the support module that
// checks eve.log against relay's logging schema at fixture teardown. Inline
// schemas and temp files only: no cache, no network, no relay clone.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const { loadSchema, lineErrors, checkLogFile, LogSchemaError, LogLineError } = require(path.join(EVE, 'test', 'e2e', 'support', 'log-schema'));
const { extractLoggingSchema, BuildError } = require(path.join(EVE, 'test', 'e2e', 'support', 'build-fakes'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-logschema-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

let n = 0;
let failed = 0;
function ok(name, fn) {
  n++;
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

function write(name, text) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, text);
  return file;
}

const inline = (schema) => loadSchema(write(`schema-${n}-${Math.random().toString(36).slice(2)}.json`, JSON.stringify(schema)));

const main = inline({
  $id: 'x',
  type: 'object',
  required: ['level', 'op'],
  properties: { level: { enum: ['info', 'warn'] }, op: { type: 'string', pattern: '^[a-z.]+$' } },
});

ok('valid line passes', () => assert.deepStrictEqual(lineErrors(main, '{"level":"info","op":"a.b"}'), []));
ok('plain non-JSON line passes', () => assert.deepStrictEqual(lineErrors(main, 'panic: something broke'), []));
ok('line starting with { that is not JSON fails', () => {
  const errs = lineErrors(main, '{"level": ');
  assert.strictEqual(errs.length, 1);
  assert.match(errs[0], /^not JSON \(/);
});

const rules = [
  ['required', { required: ['a'] }, '{}', '$.a: missing'],
  ['type string', { properties: { a: { type: 'string' } } }, '{"a":1}', '$.a: not string'],
  ['type object', { properties: { a: { type: 'object' } } }, '{"a":"s"}', '$.a: not object'],
  ['type integer', { properties: { a: { type: 'integer' } } }, '{"a":1.5}', '$.a: not integer'],
  ['enum', { properties: { a: { enum: ['x', 'y'] } } }, '{"a":"z"}', '$.a: not one of "x", "y"'],
  ['const', { properties: { a: { const: 'k' } } }, '{"a":"j"}', '$.a: not "k"'],
  ['pattern', { properties: { a: { type: 'string', pattern: '^a+$' } } }, '{"a":"b"}', '$.a: does not match ^a+$'],
  ['maxLength', { properties: { a: { type: 'string', maxLength: 2 } } }, '{"a":"abc"}', '$.a: longer than 2'],
  ['minLength', { properties: { a: { type: 'string', minLength: 2 } } }, '{"a":"a"}', '$.a: shorter than 2'],
  ['minimum', { properties: { a: { type: 'integer', minimum: 0 } } }, '{"a":-1}', '$.a: below 0'],
  ['additionalProperties false', { properties: { a: {} }, additionalProperties: false }, '{"a":1,"b":2}', '$.b: not allowed'],
];
for (const [name, schema, bad, rule] of rules) {
  const s = inline({ type: 'object', ...schema });
  ok(`${name}: bad line fails with its rule`, () => {
    const errs = lineErrors(s, bad);
    assert.deepStrictEqual(errs, [rule]);
  });
}
ok('maxLength counts code points', () => {
  const s = inline({ properties: { a: { type: 'string', maxLength: 2 } } });
  assert.deepStrictEqual(lineErrors(s, '{"a":"\u{1F600}\u{1F600}"}'), []);
});
ok('enum over 10 values names the count', () => {
  const s = inline({ properties: { a: { enum: Array.from({ length: 11 }, (_, i) => `v${i}`) } } });
  assert.deepStrictEqual(lineErrors(s, '{"a":"no"}'), ['$.a: not one of the 11 allowed values']);
});

const gated = inline({
  type: 'object',
  allOf: [{
    description: 'An error line names why.',
    if: { required: ['event'], properties: { status: { enum: ['error'] } } },
    then: { required: ['reason'] },
  }],
});
ok('allOf then applies when if matches, with the entry description', () => {
  assert.deepStrictEqual(lineErrors(gated, '{"event":"e","status":"error"}'), ['allOf[0] "An error line names why.": $.reason: missing']);
  assert.deepStrictEqual(lineErrors(gated, '{"event":"e","status":"error","reason":"r"}'), []);
});
ok('allOf then is ignored when if does not match', () => {
  assert.deepStrictEqual(lineErrors(gated, '{"status":"error"}'), []);
  assert.deepStrictEqual(lineErrors(gated, '{"event":"e","status":"ok"}'), []);
});

const unsupported = [
  ['format', { properties: { a: { type: 'string', format: 'date' } } }, 'format'],
  ['nested oneOf', { properties: { a: { oneOf: [{ type: 'string' }] } } }, 'oneOf'],
  ['top-level else', { if: { required: ['a'] }, else: { required: ['b'] } }, 'else'],
  ['array type', { properties: { a: { type: 'array' } } }, 'array'],
];
for (const [name, schema, word] of unsupported) {
  ok(`${name} makes loadSchema throw, naming it`, () => {
    const file = write(`unsupported-${word}.json`, JSON.stringify(schema));
    assert.throws(() => loadSchema(file), (err) => err instanceof LogSchemaError && err.message.includes(word) && err.message.includes(file));
  });
}
ok('a schema that is not JSON makes loadSchema throw', () => {
  assert.throws(() => loadSchema(write('broken.json', '{nope')), LogSchemaError);
});

ok('checkLogFile names eve.log:2, the rule and the line text', () => {
  const file = write('one-bad.log', '{"level":"info","op":"a.b"}\n{"level":"loud","op":"a.b"}\nplain text\n');
  assert.throws(() => checkLogFile(file, main, { name: 'eve.log' }), (err) => {
    assert(err instanceof LogLineError);
    assert.match(err.message, /^eve\.log: 1 of 3 lines break relay's logging schema/);
    assert(err.message.includes('eve.log:2: $.level: not one of "info", "warn" | {"level":"loud","op":"a.b"}'), err.message);
    assert.strictEqual(err.failures.length, 1);
    assert.strictEqual(err.failures[0].line, 2);
    assert.strictEqual(err.failures[0].text, '{"level":"loud","op":"a.b"}');
    return true;
  });
});
ok('checkLogFile passes a clean file, with or without a trailing newline', () => {
  checkLogFile(write('clean.log', '{"level":"info","op":"a"}\nnoise\n'), main);
  checkLogFile(write('clean2.log', '{"level":"info","op":"a"}'), main);
});
ok('a missing log file throws "eve.log: missing"', () => {
  assert.throws(() => checkLogFile(path.join(scratch, 'absent.log'), main, { name: 'eve.log' }),
    (err) => err instanceof LogLineError && err.message === 'eve.log: missing');
});
ok('more than 10 bad lines: 10 shown, "... and <m> more", all in failures', () => {
  const lines = Array.from({ length: 13 }, () => '{"level":"loud","op":"a"}').join('\n') + '\n';
  assert.throws(() => checkLogFile(write('many.log', lines), main, { name: 'eve.log' }), (err) => {
    const shown = err.message.split('\n').filter((l) => /^eve\.log:\d+:/.test(l));
    assert.strictEqual(shown.length, 10);
    assert(err.message.endsWith('... and 3 more'), err.message);
    assert.strictEqual(err.failures.length, 13);
    return true;
  });
});
ok('a long line is cut to 300 chars in the message', () => {
  const long = `{"level":"loud","op":"a","pad":"${'x'.repeat(400)}"}`;
  assert.throws(() => checkLogFile(write('long.log', `${long}\n`), main, { name: 'eve.log' }), (err) => {
    assert(err.message.includes(`${long.slice(0, 300)}...`));
    assert(!err.message.includes(long));
    return true;
  });
});

ok('extractLoggingSchema without docs/logging-schema.json throws BuildError naming it', () => {
  const src = fs.mkdtempSync(path.join(scratch, 'src-'));
  const dest = fs.mkdtempSync(path.join(scratch, 'dest-'));
  assert.throws(() => extractLoggingSchema(src, dest), (err) => err instanceof BuildError && err.message.includes('docs/logging-schema.json'));
});
ok('extractLoggingSchema copies the schema into the destination', () => {
  const src = fs.mkdtempSync(path.join(scratch, 'src-'));
  const dest = fs.mkdtempSync(path.join(scratch, 'dest-'));
  fs.mkdirSync(path.join(src, 'docs'));
  fs.writeFileSync(path.join(src, 'docs', 'logging-schema.json'), '{"type":"object"}');
  const out = extractLoggingSchema(src, dest);
  assert.strictEqual(out, path.join(dest, 'logging-schema.json'));
  assert.strictEqual(fs.readFileSync(out, 'utf8'), '{"type":"object"}');
  assert.deepStrictEqual(fs.readdirSync(dest), ['logging-schema.json']);
});

console.log(`${n - failed} of ${n} cases passed`);
process.exit(failed ? 1 : 0);
