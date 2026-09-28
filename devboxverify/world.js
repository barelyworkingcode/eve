'use strict';
// The world, reached only through devboxWorld's machine marker. The marker
// names the world checkout and root; world.json there names every project and
// publishes the fixture catalogue journeys declare against. The spec is
// devboxWorld's docs/WORLD.md.
/** @typedef {{ schema: 1, world_checkout: string, world_root: string, world_version: number, written_at: * }} Marker */
/** @typedef {{ key: string, name: string, mode: string, folder: string }} WorldProject */
/** @typedef {{ version: number, root: string, checkout: string, projects: Object<string, WorldProject>, fixtures: Set<string> }} World */
/** @typedef {{ projects: Object<string, WorldProject> }} View */
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
  const version = doc.world_version;
  if (!Number.isInteger(version) || version < 1) throw refuse('marker world_version is not a positive integer');
  return doc;
}

/** @returns {World} */
function loadWorld(marker) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(marker.world_checkout, 'data', 'world.json'), 'utf8');
  } catch {
    throw new Error('world.json is not readable');
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('world.json is not valid JSON');
  }
  if (!doc || !Array.isArray(doc.fixtures)) throw new Error('world.json has no fixtures list');
  if (!Array.isArray(doc.projects)) throw new Error('world.json has no projects list');
  const root = marker.world_root;
  const projects = {};
  for (const p of doc.projects) {
    projects[p.key] = { key: p.key, name: p.name, mode: p.mode, folder: path.join(root, p.name) };
  }
  return { version: doc.world_version, root, checkout: marker.world_checkout, projects, fixtures: new Set(doc.fixtures) };
}

// A journey sees only the projects it declared. Anything else throws, so an
// undeclared lookup reports as BLOCKED rather than as a product failure.
/** @returns {View} */
function scoped(world, needs) {
  const declared = new Set(needs || []);
  const projects = new Proxy(world.projects, {
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      if (declared.has(`project:${key}`) && Object.prototype.hasOwnProperty.call(target, key)) return target[key];
      throw Object.assign(new Error(`undeclared fixture project:${key}`), { code: 'EUNDECLARED' });
    },
  });
  return { projects };
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
