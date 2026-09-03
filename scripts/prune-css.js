#!/usr/bin/env node
'use strict';

// scripts/prune-css.js
//
// Prunes provably dead rules from public/styles.css.
//
// public/index.html loads styles.css first and later sheets after it. A
// later rule with the same selector wins, so a styles.css block whose
// entire effect is re-declared by later sheets is inert: it is parsed,
// it costs bytes, but it changes nothing on screen.
//
// A block in styles.css is DEAD only if, for EVERY comma-separated
// selector in it AND for EVERY declaration in it, some rule in a
// later-loading sheet has:
//   - an IDENTICAL selector string,
//   - an IDENTICAL enclosing at-rule context (e.g. @media (max-width: 768px);
//     empty at top level),
//   - a re-declaration of that property. A declaration marked !important
//     in styles.css is NOT covered by a later declaration without
//     !important.
//
// Deliberately conservative: identical selector strings in identical
// at-rule contexts only. No specificity reasoning, no
// shorthand-vs-longhand expansion, no selector-equivalence guesses.
// Missing a dead rule is free; deleting a live one breaks the design.
//
// Usage: node scripts/prune-css.js [--apply]
//   (no flag)  dry run: report DEAD / PARTIAL / UNIQUE blocks and lines
//   --apply    remove exactly the DEAD blocks (plus at-rules left with no
//              children) and rewrite public/styles.css

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const TARGET_HREF = 'styles.css';

// Sheet load order from index.html, in document order. Hrefs starting with
// / are served from node_modules and are not ours.
function sheetOrder() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const sheets = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']*)["']/i);
    if (!rel || rel[1].trim() !== 'stylesheet') continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    if (href[1].startsWith('/')) continue;
    sheets.push(href[1]);
  }
  return sheets;
}

// Walk a parsed sheet and collect every style rule with its metadata.
// Rules inside @keyframes are not style rules; they are excluded entirely.
function collectRules(root, sheetIdx) {
  const rules = [];
  const walk = (nodes, ctx) => {
    for (const node of nodes) {
      if (node.type === 'atrule') {
        if (node.name === 'keyframes') continue;
        const label = node.name + (node.params ? ' ' + node.params : '');
        walk(node.nodes || [], ctx ? ctx + ' > ' + label : label);
      } else if (node.type === 'rule') {
        const decls = new Map();
        for (const n of node.nodes || []) {
          if (n.type === 'decl') decls.set(n.prop, { value: n.value, important: !!n.important });
        }
        rules.push({
          node,
          sheetIdx,
          selectors: node.selectors,
          ctx,
          decls,
          startLine: node.source && node.source.start ? node.source.start.line : 0,
          endLine: node.source && node.source.end ? node.source.end.line : 0,
        });
      }
    }
  };
  walk(root.nodes, '');
  return rules;
}

function main() {
  const apply = process.argv.slice(2).includes('--apply');
  const sheets = sheetOrder();
  if (!sheets.includes(TARGET_HREF)) {
    console.error(`ERROR: ${TARGET_HREF} is not in the stylesheet load order of public/index.html.`);
    process.exit(1);
  }
  const targetIdx = sheets.indexOf(TARGET_HREF);

  const parsed = sheets.map((href, idx) => {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, href), 'utf8');
    let root;
    try {
      root = postcss.parse(src, { from: href });
    } catch (err) {
      console.error(`ERROR: ${href} failed to parse: ${err.message}`);
      process.exit(1);
    }
    return { href, idx, src, root, rules: collectRules(root, idx) };
  });

  // Coverage from later-loading sheets: (ctx, selector) -> prop -> flags.
  const cov = new Map();
  for (const sheet of parsed.slice(targetIdx + 1)) {
    for (const r of sheet.rules) {
      if (r.decls.size === 0) continue;
      for (const sel of r.selectors) {
        const key = r.ctx + '\u0000' + sel;
        let props = cov.get(key);
        if (!props) { props = new Map(); cov.set(key, props); }
        for (const [prop, d] of r.decls) {
          const e = props.get(prop) || { plain: false, important: false };
          if (d.important) e.important = true; else e.plain = true;
          props.set(prop, e);
        }
      }
    }
  }

  const target = parsed[targetIdx];
  const counts = {
    DEAD: { blocks: 0, lines: 0 },
    PARTIAL: { blocks: 0, lines: 0 },
    UNIQUE: { blocks: 0, lines: 0 },
  };
  let emptySkipped = 0;
  const deadNodes = new Set();

  for (const r of target.rules) {
    const lines = r.endLine - r.startLine + 1;
    if (r.decls.size === 0) { emptySkipped++; continue; } // empty rules: skip, never dead
    if (r.selectors.length === 0) { // no selector to compare: never provably dead
      counts.UNIQUE.blocks++; counts.UNIQUE.lines += lines;
      continue;
    }

    // DEAD: every selector AND every declaration is re-declared later, in
    // the same at-rule context. A !important declaration is only covered
    // by a later !important declaration.
    const isDead = r.selectors.every(sel => {
      const props = cov.get(r.ctx + '\u0000' + sel);
      if (!props) return false;
      for (const [prop, d] of r.decls) {
        const e = props.get(prop);
        if (!e) return false;
        if (d.important && !e.important) return false;
      }
      return true;
    });

    if (isDead) {
      counts.DEAD.blocks++; counts.DEAD.lines += lines;
      deadNodes.add(r.node);
    } else if (r.selectors.some(sel => cov.has(r.ctx + '\u0000' + sel))) {
      // Some later rule carries one of these selectors but not everything
      // is covered: some declarations survive.
      counts.PARTIAL.blocks++; counts.PARTIAL.lines += lines;
    } else {
      // No later rule with any of these selectors at all.
      counts.UNIQUE.blocks++; counts.UNIQUE.lines += lines;
    }
  }
  console.log(`Load order: ${sheets.length} stylesheets from public/index.html (skipping /-served sheets)`);
  console.log(`Target: ${TARGET_HREF} at position ${targetIdx + 1} of ${sheets.length}; compared against ${sheets.length - 1 - targetIdx} later sheet(s)`);
  console.log('');
  console.log(`DEAD     blocks=${counts.DEAD.blocks}  lines=${counts.DEAD.lines}`);
  console.log(`PARTIAL  blocks=${counts.PARTIAL.blocks}  lines=${counts.PARTIAL.lines}`);
  console.log(`UNIQUE   blocks=${counts.UNIQUE.blocks}  lines=${counts.UNIQUE.lines}`);
  if (emptySkipped) console.log(`(skipped ${emptySkipped} empty rule(s); not counted)`);

  if (!apply) {
    console.log(`\nDry run: nothing written. Re-run with --apply to remove ${counts.DEAD.blocks} dead block(s).`);
    return;
  }

  // Round-trip assertion: the untouched file must stringify back
  // byte-identically, or the rewrite would reformat rules we did not
  // delete. Abort before changing anything.
  const roundTrip = target.root.toResult().css;
  if (roundTrip !== target.src) {
    console.error('ERROR: postcss round-trip of public/styles.css is not byte-identical; refusing to rewrite. No file was modified.');
    process.exit(1);
  }

  // Which at-rules had children at parse time, recorded before any
  // removal, so that at-rules left with no children (e.g. an @media
  // whose rules all died) can be identified; statement at-rules
  // (@charset and the like) never qualify and are never touched.
  const hadChildren = new Set();
  target.root.walkAtRules(at => {
    if (at.nodes && at.nodes.length) hadChildren.add(at);
  });

  for (const node of deadNodes) node.remove();

  // Drop at-rules left with no children, cascading so a wrapper at-rule
  // emptied by the removal of its nested at-rule goes too.
  let changed = true;
  while (changed) {
    changed = false;
    const emptied = [];
    target.root.walkAtRules(at => {
      if (hadChildren.has(at) && (!at.nodes || at.nodes.length === 0)) emptied.push(at);
    });
    for (const at of emptied) { at.remove(); changed = true; }
  }

  fs.writeFileSync(path.join(PUBLIC_DIR, TARGET_HREF), target.root.toResult().css);
  console.log(`\nApplied: removed ${counts.DEAD.blocks} dead block(s) (${counts.DEAD.lines} lines) from ${TARGET_HREF}.`);
}

main();
