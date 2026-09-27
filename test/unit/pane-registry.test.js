// public/ files are plain <script> globals, not modules, and the repo has no
// jsdom, so this loads the source into a vm sandbox rather than requiring it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '../../public/core/pane-registry.js'), 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.PaneRegistry = PaneRegistry; this.panes = panes;', sandbox);
const { PaneRegistry } = sandbox;

describe('PaneRegistry.registerType / .type / .hasType', () => {
  it('type registry: lookup, null for unknown, requires a type, rejects a duplicate', () => {
    const r = new PaneRegistry();
    const d = { type: 'file', create() {}, view() {}, ref() {} };
    r.registerType(d);
    expect(r.type('file')).toBe(d);
    expect(r.hasType('file')).toBe(true);

    expect(r.type('nope')).toBeNull();
    expect(r.hasType('nope')).toBe(false);

    expect(() => new PaneRegistry().registerType({})).toThrow(/needs a type/);

    expect(() => r.registerType({ type: 'file' })).toThrow(/duplicate pane type: file/);
  });

  it('types() returns descriptors in registration order', () => {
    const r = new PaneRegistry();
    r.registerType({ type: 'session' });
    r.registerType({ type: 'file' });
    r.registerType({ type: 'terminal' });
    expect(r.types().map((d) => d.type)).toEqual(['session', 'file', 'terminal']);
  });
});

describe('PaneRegistry.registerView / .view / .hasView', () => {
  it('view registry: lookup, null for unknown, requires a view, rejects a duplicate', () => {
    const r = new PaneRegistry();
    const d = { view: 'editor', elementId: 'editor', show() {} };
    r.registerView(d);
    expect(r.view('editor')).toBe(d);
    expect(r.hasView('editor')).toBe(true);

    expect(r.view('nope')).toBeNull();
    expect(r.hasView('nope')).toBe(false);

    expect(() => new PaneRegistry().registerView({})).toThrow(/needs a view/);

    expect(() => r.registerView({ view: 'editor', elementId: 'editor' })).toThrow(
      /duplicate pane view: editor/,
    );
  });

  it('views() returns descriptors in registration order', () => {
    const r = new PaneRegistry();
    r.registerView({ view: 'chat' });
    r.registerView({ view: 'voice' });
    r.registerView({ view: 'editor' });
    expect(r.views().map((d) => d.view)).toEqual(['chat', 'voice', 'editor']);
  });
});

describe('type and view registries are independent', () => {
  // 'viewer' is a real view id in production and a plausible pane-type name too.
  it('a type and a view may share the same name', () => {
    const r = new PaneRegistry();
    r.registerType({ type: 'viewer' });
    r.registerView({ view: 'viewer', elementId: 'fileViewer' });
    expect(r.hasType('viewer')).toBe(true);
    expect(r.hasView('viewer')).toBe(true);
    expect(r.type('viewer')).not.toBe(r.view('viewer'));
  });
});
