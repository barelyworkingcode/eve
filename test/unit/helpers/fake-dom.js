// A deliberately small DOM stand-in for client unit tests. The repo has no
// jsdom (see test/unit/tab-manager-logic.test.js), and the Changes panel /
// diff viewer only use a narrow slice of the DOM: createElement, attribute
// and dataset access, appendChild/append/replaceChildren, classList,
// addEventListener + click, and attribute/class selectors. Anything outside
// that slice throws or returns null rather than pretending to work.
//
// Also exports helpers to load the classic-script files under public/ (no
// module.exports) into the test's realm, so jest fake timers and Date mocks
// reach them.
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', '..', '..', 'public');

function camel(attr) {
  return attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

class FakeClassList {
  constructor(el) { this._el = el; this._set = new Set(); }
  add(...cs) { cs.forEach((c) => this._set.add(c)); }
  remove(...cs) { cs.forEach((c) => this._set.delete(c)); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const on = force === undefined ? !this._set.has(c) : !!force;
    if (on) this._set.add(c); else this._set.delete(c);
    return on;
  }
  get length() { return this._set.size; }
  [Symbol.iterator]() { return this._set[Symbol.iterator](); }
  toString() { return [...this._set].join(' '); }
}

// Parses one compound selector: tag, .class, #id, [attr], [attr="v"].
function parseSelector(sel) {
  const s = sel.trim();
  if (/[\s>+~,:]/.test(s.replace(/\[[^\]]*\]/g, ''))) {
    throw new Error(`fake-dom: unsupported selector "${sel}"`);
  }
  const out = { tag: null, classes: [], id: null, attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1]) out.tag = m[1].toUpperCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.id = m[3];
    else out.attrs.push({ name: m[4], value: m[5] });
  }
  return out;
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList(this);
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.type = '';
    this.scrollTop = 0;
    this._attrs = new Map();
    this._listeners = {};
    this._text = '';
    this._html = '';
    this._id = '';
  }

  get className() { return this.classList.toString(); }
  set className(v) {
    this.classList._set = new Set(String(v).split(/\s+/).filter(Boolean));
  }

  get id() { return this._id; }
  set id(v) {
    this._id = String(v);
    if (this._id) this.ownerDocument._ids.set(this._id, this);
  }

  get firstChild() { return this.children[0] || null; }
  get childElementCount() { return this.children.length; }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._detachAll();
    this._html = '';
    this._text = v == null ? '' : String(v);
  }

  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._detachAll();
    this._text = '';
    this._html = String(v);
  }

  _detachAll() {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }

  replaceChildren(...nodes) {
    this._detachAll();
    this._text = '';
    this._html = '';
    this.append(...nodes);
  }

  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  remove() { if (this.parentNode) this.parentNode.removeChild(this); }

  setAttribute(name, value) {
    const v = String(value);
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = v;
    else if (name === 'class') this.className = v;
    else if (name === 'id') this.id = v;
    else this._attrs.set(name, v);
  }

  getAttribute(name) {
    if (name.startsWith('data-')) {
      const v = this.dataset[camel(name.slice(5))];
      return v === undefined ? null : v;
    }
    if (name === 'class') return this.className;
    if (name === 'id') return this._id || null;
    return this._attrs.has(name) ? this._attrs.get(name) : null;
  }

  hasAttribute(name) { return this.getAttribute(name) !== null; }
  removeAttribute(name) {
    if (name.startsWith('data-')) delete this.dataset[camel(name.slice(5))];
    else this._attrs.delete(name);
  }

  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }

  // No bubbling: every handler under test calls stopPropagation anyway.
  dispatchEvent(event) {
    const e = {
      target: this,
      currentTarget: this,
      defaultPrevented: false,
      stopPropagation() {},
      preventDefault() { this.defaultPrevented = true; },
      ...event,
    };
    for (const fn of this._listeners[e.type] || []) fn(e);
    return !e.defaultPrevented;
  }

  // Mirrors the browser: a disabled <button> swallows clicks.
  click() {
    if (this.disabled) return;
    this.dispatchEvent({ type: 'click' });
  }

  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }

  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  matches(selector) {
    const s = parseSelector(selector);
    if (s.tag && s.tag !== this.tagName) return false;
    if (s.id && s.id !== this._id) return false;
    if (s.classes.some((c) => !this.classList.contains(c))) return false;
    for (const a of s.attrs) {
      const v = this.getAttribute(a.name);
      if (v === null) return false;
      if (a.value !== undefined && v !== a.value) return false;
    }
    return true;
  }

  _descendants() {
    const out = [];
    const walk = (el) => { for (const c of el.children) { out.push(c); walk(c); } };
    walk(this);
    return out;
  }

  querySelectorAll(selector) { return this._descendants().filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

function createDocument() {
  const doc = {
    _ids: new Map(),
    activeElement: null,
    createElement(tag) { return new FakeElement(tag, doc); },
    createElementNS(_ns, tag) { return new FakeElement(tag, doc); },
    getElementById(id) {
      const el = doc._ids.get(id);
      return el && el.id === id ? el : null;
    },
    querySelectorAll(sel) { return doc.body.querySelectorAll(sel); },
    querySelector(sel) { return doc.body.querySelector(sel); },
    addEventListener() {},
    removeEventListener() {},
  };
  doc.body = new FakeElement('body', doc);
  return doc;
}

function fakeLocalStorage(initial = {}) {
  let store = { ...initial };
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
    _raw: () => store,
  };
}

// Lookup by exact data-testid (testids contain ':' and '/', which the
// selector parser above would otherwise have to quote).
function byTestId(root, testid) {
  return root.querySelectorAll('[data-testid]').find((el) => el.dataset.testid === testid) || null;
}

function allTestIds(root) {
  return root.querySelectorAll('[data-testid]').map((el) => el.dataset.testid);
}

// Evaluates a classic <script> file from public/ in this realm and returns
// the named top-level bindings. `params` become in-scope names for the file
// (e.g. a `window` stand-in), without touching `global`.
function loadScript(relPath, names, params = {}) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
  const keys = Object.keys(params);
  const body = `${src}\nreturn { ${names.join(', ')} };`;
  // eslint-disable-next-line no-new-func
  return new Function(...keys, body)(...keys.map((k) => params[k]));
}

function loadConstants() {
  return loadScript('core/constants.js', ['EVT'], { window: {} });
}

function loadEventBus() {
  return loadScript('core/event-bus.js', ['EventBus']).EventBus;
}

module.exports = {
  FakeElement,
  createDocument,
  fakeLocalStorage,
  byTestId,
  allTestIds,
  loadScript,
  loadConstants,
  loadEventBus,
};
