'use strict';
// The world, reached only through devboxWorld's machine marker. The marker
// names the world checkout and root; world.json there names every project and
// publishes the fixture catalogue journeys declare against. The spec is
// devboxWorld's docs/WORLD.md.
/** @typedef {{ schema: 1, world_checkout: string, world_root: string, world_version: number, written_at: * }} Marker */
/** @typedef {{ key: string, name: string, mode: string, folder: string }} WorldProject */
/** @typedef {{ id: string, tools: string }} RelayMcp */
/** @typedef {{ account: string, mailbox: string, subject: string, sendTo: string, fetchUrl: string }} BriefInjection */
/** @typedef {{ id: string, tool: string, results: object[] }} SearchStub */
/** @typedef {{ version: number, root: string, checkout: string, projects: Object<string, WorldProject>, fixtures: Set<string>, relayMcp: RelayMcp, briefInjection: BriefInjection | null, searchStub: SearchStub | null }} World */
/** @typedef {{ projects: Object<string, WorldProject>, file: (key: string, rel: string) => string, relayMcp: RelayMcp, briefInjection: BriefInjection | null, searchStub: SearchStub | null }} View */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORLD_VERSION = 1;
const MARKER_SCHEMA = 1;
const ABSENT = 'not a test machine: run devboxWorld bootstrap on a VM';
const FIELDS = ['world_checkout', 'world_root', 'world_version', 'written_at'];

function markerPath(env, home) {
  const given = env.DEVBOXWORLD_MARKER;
  if (typeof given === 'string' && given !== '') return given;
  return path.join(home, '.config', 'devboxWorld', 'machine.json');
}

// Deliberate: no env override. A marker restored onto a host from a backup
// must still refuse.
function isVM() {
  const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.hv_vmm_present'], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.trim() === '1';
}

function refuse(reason) {
  return new Error(`not a test machine: ${reason}; run devboxWorld bootstrap on a VM`);
}

function vmPresent(check) {
  try { return Boolean(check()); } catch { return false; }
}

/** @returns {Marker} */
function readMarker(file, { isVM: vmCheck = module.exports.isVM } = {}) {
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error(ABSENT);
  }
  if (!vmPresent(vmCheck)) throw refuse('not a VM: kern.hv_vmm_present is not 1');
  if (!st) throw refuse('marker is not readable');
  if (!st.isFile()) throw refuse('marker is not a regular file');
  if (st.mode & 0o077) {
    throw refuse(`marker is open to group or others (mode ${(st.mode & 0o7777).toString(8).padStart(4, '0')})`);
  }
  let raw;
  try {
    // O_NOFOLLOW: a symlink swapped in after the lstat is refused, not followed.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { raw = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    throw refuse('marker is not readable');
  }
  let doc;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw refuse('marker is not valid JSON');
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw refuse('marker is not a JSON object');
  if (doc.schema !== MARKER_SCHEMA) throw refuse(`marker schema is not ${MARKER_SCHEMA}`);
  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(doc, field)) throw refuse(`marker lacks ${field}`);
  }
  for (const field of ['world_checkout', 'world_root']) {
    const v = doc[field];
    if (typeof v !== 'string' || !path.isAbsolute(v)) throw refuse(`marker ${field} is not an absolute path`);
  }
  if (!positiveInteger(doc.world_version)) throw refuse('marker world_version is not a positive integer');
  return doc;
}

// A world-data failure. The message is the reason alone, so main.js can
// prefix `BLOCKED fixture: `; the code tells it apart from any other error.
function badWorld(reason) {
  return Object.assign(new Error(reason), { code: 'EWORLDDATA' });
}

function nonEmptyString(v) {
  return typeof v === 'string' && v !== '';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// D12: rejects true and "1"; JSON.parse has already turned 1.0 into 1.
function positiveInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function resolves(id, keys) {
  let key;
  let rel = null;
  if (id.startsWith('project:')) {
    key = id.slice('project:'.length);
  } else if (id.startsWith('file:')) {
    const rest = id.slice('file:'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return false;
    key = rest.slice(0, slash);
    rel = rest.slice(slash + 1);
  } else {
    return false;
  }
  if (!keys.has(key)) return false;
  if (rel === null) return true;
  return rel !== '' && !rel.startsWith('/') && !rel.includes('..');
}

// Checks run in the order of devboxWorld's "World data failures" list; the
// first failure wins. data/files is never statted.
/** @returns {World} */
function loadWorld(marker) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(marker.world_checkout, 'data', 'world.json'));
  } catch {
    throw badWorld('world data is not readable');
  }
  let doc;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw badWorld('world data is not valid JSON');
  }
  if (!isPlainObject(doc)) throw badWorld('world data is not valid JSON');
  if (!positiveInteger(doc.world_version)) throw badWorld('world_version is not a positive integer');
  if (!Array.isArray(doc.fixtures) || !doc.fixtures.every((id) => typeof id === 'string')) {
    throw badWorld('fixtures is not a list of strings');
  }
  if (!Array.isArray(doc.projects)) throw badWorld('projects is not a list');
  doc.projects.forEach((p, i) => {
    if (!isPlainObject(p) || !nonEmptyString(p.key) || !nonEmptyString(p.name) || !nonEmptyString(p.mode)) {
      throw badWorld(`project ${i} is malformed`);
    }
  });
  const mcp = doc.relay_mcp;
  if (!isPlainObject(mcp) || !nonEmptyString(mcp.id) || !nonEmptyString(mcp.tools)) {
    throw badWorld('relay_mcp is malformed');
  }
  const keys = new Set(doc.projects.map((p) => p.key));
  for (const id of doc.fixtures) {
    if (!resolves(id, keys)) throw badWorld(`fixture ${id} does not resolve`);
  }
  const root = marker.world_root;
  const projects = {};
  for (const p of doc.projects) {
    projects[p.key] = { key: p.key, name: p.name, mode: p.mode, folder: path.join(root, p.name) };
  }
  return {
    version: doc.world_version,
    root,
    checkout: marker.world_checkout,
    projects,
    fixtures: new Set(doc.fixtures),
    relayMcp: { id: mcp.id, tools: mcp.tools },
    briefInjection: briefInjection(doc.brief_injection, keys),
    searchStub: searchStub(doc.search_stub),
  };
}

// Reserved names only (RFC 2606/6761): the .example TLD, or example.com,
// .net, .org and their subdomains.
function reservedHost(host) {
  return /(^|\.)example$/.test(host) || /(^|\.)example\.(com|net|org)$/.test(host);
}

// Deliberate: an absent or unusable brief_injection is null, never an error.
// It is optional and only brief-injection-refused uses it; that journey reports
// BLOCKED fixture, so a bad value can't stop the rest of the run. A target off
// the reserved names is unusable: the probe sends to it for real.
/** @returns {BriefInjection | null} */
function briefInjection(raw, keys) {
  if (!isPlainObject(raw)) return null;
  const fields = ['project', 'mailbox', 'subject', 'send_to', 'fetch_url'];
  if (!fields.every((f) => nonEmptyString(raw[f])) || !keys.has(raw.project)) return null;
  const at = raw.send_to.lastIndexOf('@');
  if (at < 1 || !reservedHost(raw.send_to.slice(at + 1).toLowerCase())) return null;
  let url;
  try { url = new URL(raw.fetch_url); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !/\.example$/.test(url.hostname)) return null;
  return Object.freeze({
    account: raw.project, mailbox: raw.mailbox, subject: raw.subject, sendTo: raw.send_to, fetchUrl: raw.fetch_url,
  });
}

// Deliberate: as brief_injection, an absent or unusable search_stub is null,
// never an error. Only research-citations uses it, and reports BLOCKED fixture.
/** @returns {SearchStub | null} */
function searchStub(raw) {
  if (!isPlainObject(raw) || !nonEmptyString(raw.id) || !nonEmptyString(raw.tool)) return null;
  if (!Array.isArray(raw.results) || !raw.results.length || !raw.results.every(isPlainObject)) return null;
  return Object.freeze({ id: raw.id, tool: raw.tool, results: raw.results.map((r) => Object.freeze({ ...r })) });
}

function undeclared(id) {
  return Object.assign(new Error(`undeclared fixture ${id}`), { code: 'EUNDECLARED' });
}

// A journey sees only the fixtures it declared. Anything else throws, so an
// undeclared lookup reports as BLOCKED rather than as a product failure.
// `world` is a loadWorld result, or the same shape with extra fields (id,
// path) on each project entry; entries are passed through as they are.
/** @returns {View} */
function scoped(world, needs) {
  const declared = new Set(needs || []);
  const own = (key) => Object.prototype.hasOwnProperty.call(world.projects, key);
  const visible = (key) => typeof key === 'string' && declared.has(`project:${key}`) && own(key);
  const projects = new Proxy(world.projects, {
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      if (visible(key)) return target[key];
      throw undeclared(`project:${key}`);
    },
    // Enumeration and `in` show only the declared projects, so
    // Object.values(view.projects) is the journey's own list.
    has(target, key) { return visible(key); },
    ownKeys(target) { return Reflect.ownKeys(target).filter(visible); },
  });
  function file(key, rel) {
    const id = `file:${key}/${rel}`;
    if (!declared.has(id) || !own(key)) throw undeclared(id);
    return path.join(world.root, world.projects[key].name, rel);
  }
  const relayMcp = Object.freeze({ id: world.relayMcp.id, tools: world.relayMcp.tools });
  return { root: world.root, projects, file, relayMcp, briefInjection: world.briefInjection || null, searchStub: world.searchStub || null };
}

function missingFixtures(journeys, world) {
  const out = [];
  for (const j of journeys) {
    const ids = (j.needs || []).filter((id) => !world.fixtures.has(id));
    if (ids.length) out.push(`${j.id} needs ${ids.join(', ')}`);
  }
  return out;
}

module.exports = { WORLD_VERSION, markerPath, isVM, readMarker, loadWorld, scoped, missingFixtures };
