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

describe('the page singleton', () => {
  // A panes/*.js file registers against `panes` the moment its <script> tag is
  // parsed, long before initApp() runs, so the instance must already exist.
  it('exposes a ready-to-use `panes` instance', () => {
    expect(sandbox.panes).toBeInstanceOf(PaneRegistry);
    expect(sandbox.panes.types()).toEqual([]);
    expect(sandbox.panes.views()).toEqual([]);
  });
});

describe('PaneRegistry.registerType / .type / .hasType', () => {
  it('registers a type descriptor and looks it up by name', () => {
    const r = new PaneRegistry();
    const d = { type: 'file', create() {}, view() {}, ref() {} };
    r.registerType(d);
    expect(r.type('file')).toBe(d);
    expect(r.hasType('file')).toBe(true);
  });

  it('returns null, not undefined, for an unregistered type', () => {
    const r = new PaneRegistry();
    expect(r.type('nope')).toBeNull();
    expect(r.hasType('nope')).toBe(false);
  });

  it('requires a type', () => {
    expect(() => new PaneRegistry().registerType({})).toThrow(/needs a type/);
  });

  it('rejects a duplicate type id', () => {
    const r = new PaneRegistry();
    r.registerType({ type: 'file' });
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
  it('registers a view descriptor and looks it up by name', () => {
    const r = new PaneRegistry();
    const d = { view: 'editor', elementId: 'editor', show() {} };
    r.registerView(d);
    expect(r.view('editor')).toBe(d);
    expect(r.hasView('editor')).toBe(true);
  });

  it('returns null, not undefined, for an unregistered view', () => {
    const r = new PaneRegistry();
    expect(r.view('nope')).toBeNull();
    expect(r.hasView('nope')).toBe(false);
  });

  it('requires a view', () => {
    expect(() => new PaneRegistry().registerView({})).toThrow(/needs a view/);
  });

  it('rejects a duplicate view id', () => {
    const r = new PaneRegistry();
    r.registerView({ view: 'editor', elementId: 'editor' });
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

  it('registerType does not register a view, and vice versa', () => {
    const r = new PaneRegistry();
    r.registerType({ type: 'file' });
    expect(r.hasView('file')).toBe(false);
    r.registerView({ view: 'editor', elementId: 'editor' });
    expect(r.hasType('editor')).toBe(false);
  });
});

describe('construction and DOM', () => {
  it('registerType and registerView construct nothing and touch no DOM', () => {
    const r = new PaneRegistry();
    const create = jest.fn();
    const show = jest.fn();
    r.registerType({ type: 'file', create });
    r.registerView({ view: 'editor', elementId: 'editor', show });
    expect(create).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });
});
