// persistSessionLabel(name, templates) maps a persistent tmux session name
// (`relay-<8 hex>-<template id>-<n>`) to a human label (`<template name> #<n>`).
//
// Location assumption: the helper is a pure function exported from
// public/remote-sessions.js — either as a property of the module export
// (`module.exports.persistSessionLabel`, which may be the class's static) or as
// a browser global set when the classic script loads. As a fallback, any
// public/core/*.js module exporting `persistSessionLabel` is accepted.
const fs = require('fs');
const path = require('path');

function locatePersistSessionLabel() {
  const candidates = [];
  try {
    const mod = require('../../public/remote-sessions.js');
    candidates.push(mod && mod.persistSessionLabel);
  } catch (_) { /* fall through */ }
  candidates.push(global.persistSessionLabel);
  const coreDir = path.join(__dirname, '../../public/core');
  for (const file of fs.readdirSync(coreDir).filter((f) => f.endsWith('.js'))) {
    try {
      const mod = require(path.join(coreDir, file));
      candidates.push(mod && mod.persistSessionLabel);
    } catch (_) { /* browser-only module; skip */ }
  }
  return candidates.find((fn) => typeof fn === 'function');
}

const persistSessionLabel = locatePersistSessionLabel();

describe('persistSessionLabel', () => {
  test('helper is exported', () => {
    expect(typeof persistSessionLabel).toBe('function');
  });

  const cases = [
    ['simple template',
      'relay-0123abcd-shell-1', [{ id: 'shell', name: 'Shell' }], 'Shell #1'],
    ['template id containing "-", multi-digit n',
      'relay-0123abcd-claude-code-12', [{ id: 'claude-code', name: 'Claude Code' }], 'Claude Code #12'],
    ['catalog id matched after sanitizing',
      'relay-0123abcd-a_b-3', [{ id: 'a.b', name: 'AB' }], 'AB #3'],
    ['picks the matching entry among several',
      'relay-0123abcd-claude-code-2',
      [{ id: 'shell', name: 'Shell' }, { id: 'claude-code', name: 'Claude Code' }], 'Claude Code #2'],
    ['no catalog match falls back to the template id',
      'relay-0123abcd-mystery-2', [{ id: 'shell', name: 'Shell' }], 'mystery #2'],
    ['empty catalog falls back to the template id',
      'relay-0123abcd-shell-4', [], 'shell #4'],
    ['plain display name unchanged',
      'Acme - Shell', [{ id: 'shell', name: 'Shell' }], 'Acme - Shell'],
    ['numeric-only name unchanged',
      '0', [{ id: 'shell', name: 'Shell' }], '0'],
    ['short prefix (not 8 chars) unchanged',
      'relay-short-x-1', [{ id: 'x', name: 'X' }], 'relay-short-x-1'],
    ['zero session number unchanged',
      'relay-0123abcd-shell-0', [{ id: 'shell', name: 'Shell' }], 'relay-0123abcd-shell-0'],
    ['plain name with empty catalog unchanged',
      'Acme - Shell', [], 'Acme - Shell'],
  ];

  test.each(cases)('%s', (_desc, name, templates, expected) => {
    expect(persistSessionLabel(name, templates)).toBe(expected);
  });
});

describe('sessionDisplayName for a persistent host terminal', () => {
  const { sessionDisplayName } = require('../../public/core/ui-utils');
  afterEach(() => { delete global.window; });

  test('sidebar lists show the tab label, not the tmux name', () => {
    global.window = { app: { state: { terminalTemplates: [{ id: 'shell', name: 'Shell' }] } } };
    expect(sessionDisplayName({ name: 'relay-0123abcd-shell-1' }, { name: 'Acme' })).toBe('Shell #1');
  });

  test('ordinary session names are unaffected', () => {
    expect(sessionDisplayName({ name: 'Acme - Shell' }, { name: 'Acme' })).toBe('Shell');
  });
});
