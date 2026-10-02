const assert = require('assert');
const RoutinePanel = require('../../public/routine-panel.js');

describe('RoutinePanel.resolveModel', () => {
  const models = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }];
  test('keeps the thread model when it is still offered', () => {
    assert.deepStrictEqual(RoutinePanel.resolveModel('b', models), { value: 'b', replaced: null });
  });
  test('falls back to the first offered model and names the old one', () => {
    assert.deepStrictEqual(RoutinePanel.resolveModel('gone', models), { value: 'a', replaced: 'gone' });
  });
  test('returns an empty value when nothing is offered', () => {
    assert.strictEqual(RoutinePanel.resolveModel('a', []).value, '');
  });
});

describe('RoutinePanel.firstPrompt', () => {
  test('returns the first non-empty user entry', () => {
    const h = [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'do it' }, { role: 'user', content: 'later' }];
    assert.strictEqual(RoutinePanel.firstPrompt(h), 'do it');
  });
  test('returns empty when there is no user entry', () => {
    assert.strictEqual(RoutinePanel.firstPrompt([{ role: 'assistant', content: 'x' }]), '');
    assert.strictEqual(RoutinePanel.firstPrompt(undefined), '');
  });
});
