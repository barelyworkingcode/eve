'use strict';

// Checks eve.log against relay's logging schema (docs/logging-schema.json in the
// relay commit eve pins). Hand-rolled, no dependency: it implements the keywords
// the schema uses and throws on any other, so a schema change fails loudly
// instead of passing unchecked. Plain Node; nothing here runs at require time.

const fs = require('fs');
const path = require('path');

class LogSchemaError extends Error {}
class LogLineError extends Error {
  constructor(message, failures) {
    super(message);
    this.failures = failures;
  }
}

const KEYWORDS = new Set([
  '$schema', '$id', 'title', 'description', 'type', 'required', 'properties', 'enum', 'const',
  'pattern', 'maxLength', 'minLength', 'minimum', 'additionalProperties', 'allOf', 'if', 'then',
]);
const TYPES = new Set(['object', 'string', 'integer']);
const MAX_SHOWN = 10;
const MAX_TEXT = 300;

function walk(file, node, pointer) {
  const fail = (what) => new LogSchemaError(`${file}: ${pointer || '#'}: ${what}`);
  if (node === null || typeof node !== 'object' || Array.isArray(node)) throw fail('schema is not an object');
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) throw fail(`unsupported keyword "${key}"`);
  }
  if ('type' in node && !TYPES.has(node.type)) throw fail(`unsupported type "${node.type}"`);
  if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
    throw fail('unsupported keyword "additionalProperties" (only true or false)');
  }
  if ('pattern' in node) {
    try { new RegExp(node.pattern, 'u'); } catch (err) { throw fail(`bad "pattern": ${err.message}`); }
  }
  if (node.properties) {
    for (const [name, sub] of Object.entries(node.properties)) walk(file, sub, `${pointer}/properties/${name}`);
  }
  if (node.allOf) {
    if (!Array.isArray(node.allOf)) throw fail('"allOf" is not a list');
    node.allOf.forEach((sub, i) => walk(file, sub, `${pointer}/allOf/${i}`));
  }
  if ('if' in node) walk(file, node.if, `${pointer}/if`);
  if ('then' in node) walk(file, node.then, `${pointer}/then`);
}

const memo = new Map();
const origin = new WeakMap(); // schema object -> the file it was read from

function loadSchema(file) {
  const key = path.resolve(file);
  if (memo.has(key)) return memo.get(key);
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new LogSchemaError(`${file}: cannot read schema: ${err.message}`);
  }
  walk(file, schema, '');
  memo.set(key, schema);
  origin.set(schema, file);
  return schema;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codePoints = (s) => Array.from(s).length;

function typeOk(type, value) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  return Number.isInteger(value);
}

function check(schema, value, at, errors) {
  if ('type' in schema && !typeOk(schema.type, value)) {
    errors.push(`${at}: not ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.some((v) => sameJson(v, value))) {
    errors.push(schema.enum.length > 10
      ? `${at}: not one of the ${schema.enum.length} allowed values`
      : `${at}: not one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
  }
  if ('const' in schema && !sameJson(schema.const, value)) errors.push(`${at}: not ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if ('pattern' in schema && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if ('maxLength' in schema && codePoints(value) > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
    if ('minLength' in schema && codePoints(value) < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  }
  if (typeof value === 'number' && 'minimum' in schema && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) errors.push(`${at}.${key}: missing`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, key)) check(sub, value[key], `${at}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push(`${at}.${key}: not allowed`);
      }
    }
  }
  if ('if' in schema) {
    const probe = [];
    check(schema.if, value, at, probe);
    if (probe.length === 0 && 'then' in schema) check(schema.then, value, at, errors);
  }
  (schema.allOf || []).forEach((entry, i) => {
    const inner = [];
    check(entry, value, at, inner);
    const label = entry.description ? `allOf[${i}] "${entry.description}": ` : `allOf[${i}]: `;
    for (const e of inner) errors.push(label + e);
  });
}

function lineErrors(schema, text) {
  if (!text.startsWith('{')) return [];
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return [`not JSON (${err.message})`];
  }
  const errors = [];
  check(schema, value, '$', errors);
  return errors;
}

function cut(text) {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
}

function checkLogFile(file, schema, { name = path.basename(file) } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new LogLineError(`${name}: missing`, []);
    throw err;
  }
  const lines = raw.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const failures = [];
  lines.forEach((text, i) => {
    const errors = lineErrors(schema, text);
    if (errors.length) failures.push({ line: i + 1, text, rule: errors.join('; ') });
  });
  if (!failures.length) return;
  const shown = failures.slice(0, MAX_SHOWN).map((f) => `${name}:${f.line}: ${f.rule} | ${cut(f.text)}`);
  const out = [`${name}: ${failures.length} of ${lines.length} lines break relay's logging schema (${origin.get(schema) || 'inline schema'})`, ...shown];
  if (failures.length > MAX_SHOWN) out.push(`... and ${failures.length - MAX_SHOWN} more`);
  throw new LogLineError(out.join('\n'), failures);
}

module.exports = { loadSchema, lineErrors, checkLogFile, LogSchemaError, LogLineError };
