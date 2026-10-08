'use strict';
// Which journeys a change needs. docs/areas.jsonc maps repo paths to areas;
// each journey names its areas; select() turns a diff into the journeys to run.
// Pure apart from changedFiles. Not read by main.js yet.
const { execFile } = require('child_process');
const { parse: parseJsonc } = require('jsonc-parser');

const MAP_PATH = 'docs/areas.jsonc';
// One journey per must-have goal G1 to G7, plus the fixture journeys, which
// select() always adds. chat-reply must stay: open-existing-thread and listen
// read the thread only it creates. Changing this set is a harness change.
const SMOKE = Object.freeze(['landing-view', 'chat-reply', 'open-existing-thread', 'terminal-on-request',
  'task-created-listed', 'changes-diff', 'file-edit-save']);

const AREA_NAME = /^[a-z][a-z-]*$/;
const MAP_KEYS = ['quiet', 'areas'];
const AREA_KEYS = ['full', 'code'];

// Globs match the whole repo-relative POSIX path. `*` and `?` stay inside one
// directory; `**/` is zero or more directories; a trailing `/**` is everything
// under that directory. Everything else is literal.
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
      else if (i + 2 === glob.length && out.endsWith('/')) { out += '.+'; i += 1; }
      else { out += '[^/]*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

function parseMap(text) {
  const errors = [];
  const raw = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) throw new Error(`${MAP_PATH}: not valid JSONC`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${MAP_PATH}: top level must be an object`);
  for (const key of Object.keys(raw)) {
    if (!MAP_KEYS.includes(key)) throw new Error(`${MAP_PATH}: unknown key ${key}`);
  }
  if (raw.quiet !== undefined && !isStringArray(raw.quiet)) throw new Error(`${MAP_PATH}: quiet must be an array of strings`);
  const rawAreas = raw.areas === undefined ? {} : raw.areas;
  if (!rawAreas || typeof rawAreas !== 'object' || Array.isArray(rawAreas)) throw new Error(`${MAP_PATH}: areas must be an object`);
  const areas = {};
  for (const [name, area] of Object.entries(rawAreas)) {
    if (!AREA_NAME.test(name)) throw new Error(`${MAP_PATH}: invalid area name ${name}`);
    if (!area || typeof area !== 'object' || Array.isArray(area)) throw new Error(`${MAP_PATH}: area ${name} must be an object`);
    for (const key of Object.keys(area)) {
      if (!AREA_KEYS.includes(key)) throw new Error(`${MAP_PATH}: area ${name}: unknown key ${key}`);
    }
    if (area.full !== undefined && typeof area.full !== 'boolean') throw new Error(`${MAP_PATH}: area ${name}: full must be a boolean`);
    if (!isStringArray(area.code) || area.code.length === 0) {
      throw new Error(`${MAP_PATH}: area ${name}: code must be a non-empty array of strings`);
    }
    areas[name] = { full: area.full === true, code: area.code };
  }
  return { quiet: raw.quiet || [], areas };
}

// Full-run triggers fixed in code, not in the map: the map is read from the
// head, so a PR could otherwise narrow its own grading.
function fixedTrigger(file) {
  if (file === MAP_PATH) return 'map';
  if (file === 'scripts/browser-lock.js') return 'harness';
  if (file.startsWith('devboxverify/') && !file.endsWith('.md')) return 'harness';
  return null;
}

function matchesAny(globs, file) {
  return globs.some((g) => globToRegExp(g).test(file));
}

function areasFor(map, file) {
  return Object.keys(map.areas).filter((name) => matchesAny(map.areas[name].code, file)).sort();
}

function unmapped(map, files) {
  return files.filter((f) => !fixedTrigger(f) && areasFor(map, f).length === 0 && !matchesAny(map.quiet, f));
}

/**
 * @param {{ map: object, journeys: Array<{id: string, areas: string[], fixture?: true}>,
 *   changed: string[] | { files: string[] } | { error: string } }} args
 *   `changed` is what changedFiles resolves to ({files} or {error}) or a bare file list.
 * @returns {{ mode: 'full'|'partial', why: string, areas: string[], ids: string[], total: number }}
 *   For a full run `ids` is every journey id; `why` says what forced it.
 */
function select({ map, journeys, changed }) {
  const total = journeys.length;
  const allIds = journeys.map((j) => j.id);
  const fullRun = (why) => ({ mode: 'full', why, areas: [], ids: allIds, total });
  if (changed && !Array.isArray(changed) && changed.error !== undefined) return fullRun(`no diff: ${changed.error}`);
  const files = Array.isArray(changed) ? changed : (changed && changed.files) || [];
  if (files.length === 0) return fullRun('no diff: empty');
  for (const j of journeys) {
    for (const a of j.areas) if (!map.areas[a]) return fullRun(`area not in map: ${a}`);
  }
  const touched = new Set();
  for (const file of [...files].sort()) {
    const trigger = fixedTrigger(file);
    if (trigger === 'map') return fullRun(`map: ${MAP_PATH}`);
    if (trigger) return fullRun(`harness: ${file}`);
    const hit = areasFor(map, file);
    const fullArea = hit.find((a) => map.areas[a].full);
    if (fullArea) return fullRun(`${fullArea}: ${file}`);
    if (hit.length === 0 && !matchesAny(map.quiet, file)) return fullRun(`unmapped: ${file}`);
    hit.forEach((a) => touched.add(a));
  }
  const ids = journeys
    .filter((j) => j.fixture || SMOKE.includes(j.id) || j.areas.some((a) => touched.has(a)))
    .map((j) => j.id);
  if (ids.length === total) return fullRun('all selected');
  return { mode: 'partial', why: 'by area', areas: [...touched].sort(), ids, total };
}

// Both ends of a rename are listed (--no-renames). A stale origin/main only
// makes the diff larger, which errs toward more journeys. Never rejects.
function changedFiles(checkout) {
  return new Promise((resolve) => {
    execFile('git', ['-C', checkout, 'diff', '--name-only', '--no-renames', '-z', 'origin/main...HEAD'],
      { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message).trim().split('\n')[0];
          resolve({ error: msg || 'git diff failed' });
          return;
        }
        resolve({ files: String(stdout).split('\0').filter(Boolean) });
      });
  });
}

module.exports = { globToRegExp, parseMap, fixedTrigger, areasFor, unmapped, select, changedFiles, SMOKE, MAP_PATH };
