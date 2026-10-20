#!/usr/bin/env node
'use strict';

// Self-test for OutsideThreadPage.toolShape (#583): relay's kind and name tags
// decide a tool entry's shape; the text-shape guess is the fallback for an
// older relay or a tag that is missing or malformed.

const assert = require('assert');
const path = require('path');

const EVE = path.resolve(__dirname, '..', '..');
const OutsideThreadPage = require(path.join(EVE, 'public', 'outside-thread'));
const shape = (...a) => OutsideThreadPage.toolShape(...a);

const CALL = 'Bash {"command":"ls"}';
const guessed = { kind: 'call', name: 'Bash', input: '{"command":"ls"}' };

// Unknown kind: the text-shape guess decides.
let s = shape(CALL, 'other');
assert.deepStrictEqual({ kind: s.kind, name: s.name, input: s.input }, guessed);
s = shape('plain output line', 'other');
assert.deepStrictEqual(s, { kind: 'result', text: 'plain output line' });

// kind call without a string name: same fallback.
for (const bad of [undefined, 7]) {
  s = shape(CALL, 'call', bad);
  assert.deepStrictEqual({ kind: s.kind, name: s.name, input: s.input }, guessed, `name ${bad}`);
  assert.deepStrictEqual(shape('plain output line', 'call', bad), { kind: 'result', text: 'plain output line' });
}

// kind call, empty name: a call with an empty name, not a guess.
s = shape(CALL, 'call', '');
assert.strictEqual(s.kind, 'call');
assert.strictEqual(s.name, '');

// kind result: always a result, whole raw string, even when call-shaped.
assert.deepStrictEqual(shape(CALL, 'result'), { kind: 'result', text: CALL });

// kind call with name: name from the tag, input after the name prefix.
s = shape(CALL, 'call', 'Bash');
assert.strictEqual(s.kind, 'call');
assert.strictEqual(s.name, 'Bash');
assert.strictEqual(s.input, '{"command":"ls"}');

console.log('outside-thread-tool-kind-selftest: ok');
