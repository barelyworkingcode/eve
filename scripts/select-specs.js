#!/usr/bin/env node
'use strict';

// Picks the hermetic specs a change reaches, for the CI e2e job.
//
// Usage: node scripts/select-specs.js (--base REV [--head REV] | --full)
//          [--labels-json JSON] [--env FILE] [--summary FILE]
// Output: AREAS <a,b|->, SPECS <n>/<N>, UNMAPPED <path>, NARROWED <path> <spec,...>,
//         and, on success, RUN all|none|<paths>.
// --env appends SELECT_MODE=all|some|none and SELECT_SPECS=<paths> to FILE;
// --summary appends a Markdown summary to FILE. Neither is written on exit 2.
// Exit: 0 selected; 1 a map finding, an unmapped path, or narrowing without the
//       map-narrowing-approved label; 2 usage or a git error (a shallow clone).
// There is no path that selects the whole suite because something went wrong.
// Docs: docs/test.md, "Test selection".

const fs = require('fs');
const { select, git, splitNul, TOP_SPEC, ROOT } = require('./spec-map');

const USAGE = 'usage: select-specs.js (--base REV [--head REV] | --full) [--labels-json JSON] [--env FILE] [--summary FILE]';
const VALUE_FLAGS = new Set(['--base', '--head', '--labels-json', '--env', '--summary']);

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') opts.full = true;
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      if (opts[a] !== undefined) throw new UsageError(`${a} given twice`);
      opts[a] = v;
    } else throw new UsageError(`unknown argument ${a}`);
  }
  if (opts.full && opts['--base'] !== undefined) throw new UsageError('--full and --base exclude each other');
  if (!opts.full && opts['--base'] === undefined) throw new UsageError('give --base REV or --full');
  if (opts.full && opts['--head'] !== undefined) throw new UsageError('--head goes with --base');
  return opts;
}

function parseLabels(json) {
  if (json === undefined) return [];
  let v;
  try { v = JSON.parse(json); } catch { throw new UsageError('--labels-json is not JSON'); }
  if (!Array.isArray(v) || !v.every((l) => typeof l === 'string' || (l && typeof l.name === 'string'))) {
    throw new UsageError('--labels-json must be an array of label names');
  }
  return v;
}

// A revision that starts with "-" would be read as a git option.
function resolve(rev) {
  if (!rev || rev.startsWith('-')) throw new UsageError(`bad revision "${rev}"`);
  return git(ROOT, ['rev-parse', '--verify', `${rev}^{commit}`]).trim();
}

function summaryText(sel, lines) {
  const out = ['### e2e spec selection', ''];
  if (lines.failed) {
    out.push('Selection failed; no spec ran.', '');
    for (const p of sel.unmapped) out.push(`- unmapped: \`${p}\` is in no area and not quiet in \`docs/areas.jsonc\``);
    for (const [p, s] of Object.entries(sel.narrowed)) out.push(`- narrowed${sel.approved ? ' (approved)' : ''}: \`${p}\` no longer selects ${s.join(', ')}`);
    return `${out.join('\n')}\n`;
  }
  out.push(`Mode: ${sel.mode} (${sel.why})`, `Affected areas: ${sel.areas.length ? sel.areas.join(', ') : 'none'}`,
    `Ran ${sel.specs.length} of ${sel.total} specs; ${sel.total - sel.specs.length} not run.`, '');
  for (const s of sel.specs) out.push(`- \`${s}\``);
  for (const [p, s] of Object.entries(sel.narrowed)) out.push(`- narrowing approved: \`${p}\` no longer selects ${s.join(', ')}`);
  return `${out.join('\n')}\n`;
}

function main(argv, { out = console.log, err = console.error } = {}) {
  let opts;
  let sel;
  try {
    opts = parseArgs(argv);
    const labels = parseLabels(opts['--labels-json']);
    const head = resolve(opts['--head'] || 'HEAD');
    const tracked = splitNul(git(ROOT, ['ls-tree', '-r', '-z', '--name-only', head]));
    const specsAtHead = tracked.filter((f) => TOP_SPEC.test(f));
    if (opts.full) {
      sel = { mode: 'all', why: '--full', areas: [], specs: [...specsAtHead].sort(), unmapped: [], narrowed: {}, total: specsAtHead.length, approved: false };
    } else {
      const base = resolve(opts['--base']);
      const mergeBase = git(ROOT, ['merge-base', base, head]).trim();
      const changed = splitNul(git(ROOT, ['diff', '--no-renames', '--name-only', '-z', `${base}...${head}`]));
      sel = select({ root: ROOT, base, head, mergeBase, changed, specsAtHead, trackedAtHead: tracked, labels });
    }
  } catch (e) {
    err(`select-specs: ${e instanceof UsageError ? `${e.message}\n${USAGE}` : e.message}`);
    return 2;
  }

  const failed = sel.unmapped.length > 0 || (Object.keys(sel.narrowed).length > 0 && !sel.approved);
  out(`AREAS ${sel.areas.length ? sel.areas.join(',') : '-'}`);
  out(`SPECS ${sel.specs.length}/${sel.total}`);
  for (const p of sel.unmapped) out(`UNMAPPED ${p}`);
  for (const [p, s] of Object.entries(sel.narrowed)) out(`NARROWED ${p} ${s.join(',')}`);
  if (!failed) out(`RUN ${sel.mode === 'some' ? sel.specs.join(' ') : sel.mode}`);
  try {
    if (opts['--summary']) fs.appendFileSync(opts['--summary'], summaryText(sel, { failed }));
    if (opts['--env'] && !failed) fs.appendFileSync(opts['--env'], `SELECT_MODE=${sel.mode}\nSELECT_SPECS=${sel.specs.join(' ')}\n`);
  } catch (e) {
    err(`select-specs: ${e.message}`);
    return 2;
  }
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { main, parseArgs };
