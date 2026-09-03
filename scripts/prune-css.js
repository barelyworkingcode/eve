#!/usr/bin/env node
'use strict';

// scripts/prune-css.js
//
// Prunes provably dead CSS from every sheet that public/index.html loads
// from under public/ (in load order; /-served sheets are skipped).
//
// A declaration in sheet i is covered only by rules in sheets i+1..n. It
// is DEAD if, for EVERY comma-separated selector of its rule, some rule in
// a later sheet has:
//   - an IDENTICAL selector string,
//   - an IDENTICAL enclosing at-rule context (e.g. @media (max-width: 768px);
//     empty at top level),
//   - a re-declaration of that property. A declaration marked !important
//     is NOT covered by a later declaration without !important.
//
// A rule whose declarations are ALL dead is removed as a whole block
// (counted once); otherwise only the dead declarations are removed, in
// place. Nothing is ever moved or reordered: a rule's position in the
// cascade matters even for same-specificity conflicts with a DIFFERENT
// selector that matches the same element, and this tool cannot see those.
// Deleting a declaration that is provably re-declared later for the same
// selector is safe; relocating a survivor is not.
//
// The rewrite must keep `git diff --minimal --numstat public/` at 0
// insertions: a line that is merely modified counts as an insertion. So a
// node is only removed when every source line it touches consists entirely
// of content being removed in the same pass, including the line's last
// byte (a leftover byte would rewrite the line). Dead declarations that
// share a line with live content are reported and left in place.
//
// Deliberately conservative: identical selector strings in identical
// at-rule contexts only. No specificity reasoning, no
// shorthand-vs-longhand expansion, no selector-equivalence guesses.
// Missing a dead rule is free; deleting a live one breaks the design.
//
// Usage: node scripts/prune-css.js [--apply]
//   (no flag)  dry run: per-sheet dead blocks / dead declarations / lines
//              removed, plus the PARTIAL/UNIQUE detail for styles.css
//   --apply    remove exactly the reported nodes (plus at-rules left with
//              no children) and rewrite the affected sheets

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const STYLES_CSS = 'styles.css'; // only used for the PARTIAL/UNIQUE detail report

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
// Rules inside @keyframes (and @-webkit-keyframes) are not style rules;
// they are excluded entirely.
function collectRules(root, sheetIdx) {
  const rules = [];
  const walk = (nodes, ctx) => {
    for (const node of nodes) {
      if (node.type === 'atrule') {
        if (node.name.endsWith('keyframes')) continue;
        const label = node.name + (node.params ? ' ' + node.params : '');
        walk(node.nodes || [], ctx ? ctx + ' > ' + label : label);
      } else if (node.type === 'rule') {
        const declNodes = (node.nodes || []).filter(n => n.type === 'decl');
        rules.push({
          node,
          sheetIdx,
          selectors: node.selectors,
          ctx,
          declNodes,
          startLine: node.source && node.source.start ? node.source.start.line : 0,
          endLine: node.source && node.source.end ? node.source.end.line : 0,
        });
      }
    }
  };
  walk(root.nodes, '');
  return rules;
}

// Exact number of lines removed: the serialized output is a strict
// subsequence of the original lines (pure deletions only — a modified
// line would be an insertion under `git diff --minimal`), so a greedy
// subsequence match counts the removed lines exactly, including the
// blank separators that vanish with a removed block.
function removedLineCount(orig, next) {
  const a = orig.split('\n');
  const b = next.split('\n');
  let i = 0, deleted = 0;
  for (let k = 0; k < b.length; k++) {
    while (i < a.length && a[i] !== b[k]) { deleted++; i++; }
    i++;
  }
  deleted += a.length - i;
  return deleted;
}

// Coverage index over a flat list of rules: (ctx, selector) -> prop ->
// {plain, important} — whether a later sheet re-declares the property,
// plain and/or important.
function addRulesToCoverage(cov, rules) {
  for (const r of rules) {
    if (r.declNodes.length === 0) continue;
    for (const sel of r.selectors) {
      const key = r.ctx + '\u0000' + sel;
      let props = cov.get(key);
      if (!props) { props = new Map(); cov.set(key, props); }
      for (const d of r.declNodes) {
        const e = props.get(d.prop) || { plain: false, important: false };
        if (d.important) e.important = true; else e.plain = true;
        props.set(d.prop, e);
      }
    }
  }
}

// A declaration is dead iff EVERY one of its rule's selectors has a later
// re-declaration in the same at-rule context. A !important declaration is
// covered only by a later !important one.
function declCovered(cov, rule, decl) {
  return rule.selectors.every(sel => {
    const props = cov.get(rule.ctx + '\u0000' + sel);
    if (!props) return false;
    const e = props.get(decl.prop);
    if (!e) return false;
    if (decl.important && !e.important) return false;
    return true;
  });
}

// Offset of the first byte of each 0-based line.
function lineStarts(src) {
  const st = [0];
  let i = -1;
  while ((i = src.indexOf('\n', i + 1)) !== -1) st.push(i + 1);
  return st;
}

function lineOf(st, off) {
  let lo = 0, hi = st.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st[mid] <= off) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Maximal subset of `candidates` whose removal deletes exactly whole
// source lines: on every line a candidate touches, all non-whitespace must
// fall inside a candidate's text range, and the line's last byte must as
// well (any leftover byte would rewrite the line, and
// `git diff --minimal --numstat` counts a modified line as an insertion).
// Line coverage is monotone in the candidate set, so peeling off the
// unsafe nodes to a fixpoint yields exactly the maximal safe set.
function maximalSafeSet(src, st, candidates) {
  const current = new Set(candidates);
  const ranges = new Map();
  for (const nd of current) ranges.set(nd, [nd.source.start.offset, nd.source.end.offset]);
  for (;;) {
    const byLine = new Map();
    for (const nd of current) {
      const [s, e] = ranges.get(nd);
      for (let L = lineOf(st, s); L <= lineOf(st, e - 1); L++) {
        if (!byLine.has(L)) byLine.set(L, []);
        byLine.get(L).push(nd);
      }
    }
    const unsafe = new Set();
    for (const [L, nodes] of byLine) {
      const ls = st[L];
      const le = L + 1 < st.length ? st[L + 1] - 1 : src.length;
      const ivs = nodes
        .map(nd => {
          const [s, e] = ranges.get(nd);
          return [Math.max(s, ls), Math.min(e, le)];
        })
        .filter(iv => iv[1] > iv[0])
        .sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const iv of ivs) {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
      }
      let ok = le > ls && merged.length > 0;
      if (ok) {
        let pos = ls;
        for (const [s, e] of merged) {
          if (s > pos && src.slice(pos, s).trim() !== '') { ok = false; break; }
          if (e > pos) pos = e;
        }
        if (ok && pos < le && src.slice(pos, le).trim() !== '') ok = false;
        if (ok && merged[merged.length - 1][1] !== le) ok = false;
      }
      if (!ok) for (const nd of nodes) unsafe.add(nd);
    }
    if (unsafe.size === 0) return current;
    for (const nd of unsafe) current.delete(nd);
  }
}

// Per-sheet removal plan: which nodes are provably dead and which of those
// are line-safe to remove.
function planSheet(sheet, cov) {
  const { root, src, st } = sheet;

  // At-rules that had children at parse time, recorded before any removal,
  // so at-rules left with no children can be identified later. Statement
  // at-rules (@charset and the like) never qualify and are never touched.
  const hadChildren = new Set();
  root.walkAtRules(at => {
    if (at.nodes && at.nodes.length) hadChildren.add(at);
  });

  const wholeDead = [];   // every declaration in the rule is dead
  const partialDead = []; // some (not all) declarations in the rule are dead
  const detail = { dead: 0, deadLines: 0, partial: 0, partialLines: 0, unique: 0, uniqueLines: 0 };
  const isStyles = sheet.href === STYLES_CSS;

  for (const r of sheet.rules) {
    if (r.declNodes.length === 0) continue; // empty rules: skip, never dead
    if (r.selectors.length === 0) { // no selector to compare: never provably dead
      if (isStyles) { detail.unique++; detail.uniqueLines += r.endLine - r.startLine + 1; }
      continue;
    }
    const dead = r.declNodes.filter(d => declCovered(cov, r, d));
    const all = dead.length === r.declNodes.length;
    if (all) wholeDead.push(r);
    else if (dead.length > 0) partialDead.push({ rule: r, decls: dead });
    if (isStyles) {
      const lines = r.endLine - r.startLine + 1;
      if (all) { detail.dead++; detail.deadLines += lines; }
      else if (r.selectors.some(sel => cov.has(r.ctx + '\u0000' + sel))) {
        detail.partial++; detail.partialLines += lines;
      } else {
        detail.unique++; detail.uniqueLines += lines;
      }
    }
  }

  // A whole-dead rule goes in as a block; a partially-dead rule
  // contributes only its dead declarations (the rule keeps its survivors,
  // so it can never collapse). A block and its declarations are never both
  // candidates: removing the block would orphan its declaration nodes.
  let candidates = [];
  for (const r of wholeDead) candidates.push(r.node);
  for (const p of partialDead) candidates.push(...p.decls);
  let safe = maximalSafeSet(src, st, candidates);

  // Fallback: a whole-dead rule whose lines are shared (block not safe)
  // still loses its declarations if their lines are clean; the empty
  // shell (`.foo {\n}`) is left, because deleting it would rewrite a
  // shared line.
  if (wholeDead.some(r => !safe.has(r.node))) {
    const c2 = [];
    for (const r of wholeDead) {
      if (safe.has(r.node)) c2.push(r.node);
      else c2.push(...r.declNodes);
    }
    for (const p of partialDead) c2.push(...p.decls);
    safe = maximalSafeSet(src, st, c2);
  }

  let detectedDecls = 0, blockDeclsRemoved = 0, removedBlocks = 0, removedDecls = 0;
  for (const r of wholeDead) {
    detectedDecls += r.declNodes.length;
    if (safe.has(r.node)) blockDeclsRemoved += r.declNodes.length;
  }
  for (const p of partialDead) detectedDecls += p.decls.length;
  for (const nd of safe) {
    if (nd.type === 'rule') removedBlocks++;
    else removedDecls++;
  }
  // Counted once: declarations removed as part of a block are not also
  // counted as individual declarations.
  const skippedDecls = detectedDecls - removedDecls - blockDeclsRemoved;

  return { safe, removedBlocks, removedDecls, skippedDecls, detail, hadChildren };
}

// Remove the planned nodes, then drop at-rules left with no children,
// cascading so a wrapper at-rule emptied by the removal of its nested
// at-rule goes too. Each cascade round only removes line-safe at-rules.
// Returns the at-rules that were removed.
function executePlan(sheet, plan) {
  for (const nd of plan.safe) nd.remove();
  const atRemoved = [];
  for (;;) {
    const emptied = [];
    sheet.root.walkAtRules(at => {
      if (plan.hadChildren.has(at) && (!at.nodes || at.nodes.length === 0)) emptied.push(at);
    });
    if (emptied.length === 0) break;
    const safe = maximalSafeSet(sheet.src, sheet.st, emptied);
    if (safe.size === 0) break;
    for (const at of safe) { at.remove(); atRemoved.push(at); }
  }
  return atRemoved;
}

function main() {
  const apply = process.argv.slice(2).includes('--apply');
  const sheets = sheetOrder();

  const parsed = sheets.map((href, idx) => {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, href), 'utf8');
    let root;
    try {
      root = postcss.parse(src, { from: href });
    } catch (err) {
      console.error(`ERROR: ${href} failed to parse: ${err.message}`);
      process.exit(1);
    }
    return { href, idx, src, root, st: lineStarts(src), rules: collectRules(root, idx) };
  });

  // Coverage from later-loading sheets: covs[i] holds every rule in
  // sheets i+1..n.
  const covs = parsed.map((sheet, i) => {
    const cov = new Map();
    for (let j = i + 1; j < parsed.length; j++) addRulesToCoverage(cov, parsed[j].rules);
    return cov;
  });

  const plans = parsed.map((sheet, i) => planSheet(sheet, covs[i]));

  if (apply) {
    // Round-trip assertion before any write: the untouched file must
    // stringify back byte-identically, or the rewrite would reformat rules
    // we did not delete. Abort before changing anything.
    for (let i = 0; i < parsed.length; i++) {
      if (plans[i].safe.size === 0) continue;
      if (parsed[i].root.toResult().css !== parsed[i].src) {
        console.error(`ERROR: postcss round-trip of ${parsed[i].href} is not byte-identical; refusing to rewrite. No file was modified.`);
        process.exit(1);
      }
    }
  }

  // Execute in memory (the dry run stops here without writing) and report.
  const totals = { blocks: 0, decls: 0, lines: 0, skipped: 0, files: 0 };
  const width = Math.max(...parsed.map(s => s.href.length));
  console.log(`Load order: ${sheets.length} stylesheets from public/index.html (skipping /-served sheets)`);
  console.log('');
  for (let i = 0; i < parsed.length; i++) {
    const sheet = parsed[i];
    const plan = plans[i];
    executePlan(sheet, plan);
    sheet.next = sheet.root.toResult().css;
    const lines = removedLineCount(sheet.src, sheet.next);
    totals.blocks += plan.removedBlocks;
    totals.decls += plan.removedDecls;
    totals.lines += lines;
    totals.skipped += plan.skippedDecls;
    if (plan.safe.size > 0) totals.files++;
    console.log(`  ${sheet.href.padEnd(width)}  blocks=${plan.removedBlocks}  decls=${plan.removedDecls}  lines=${lines}`);
  }
  console.log('');
  console.log(`  ${'TOTAL'.padEnd(width)}  blocks=${totals.blocks}  decls=${totals.decls}  lines=${totals.lines}`);
  if (totals.skipped > 0) {
    console.log(`(skipped ${totals.skipped} dead declaration(s) whose source line also holds live content; removing them would rewrite the line)`);
  }
  const stylesIdx = parsed.findIndex(s => s.href === STYLES_CSS);
  if (stylesIdx !== -1) {
    const d = plans[stylesIdx].detail;
    console.log(`\n${STYLES_CSS} detail: DEAD blocks=${d.dead} lines=${d.deadLines}; PARTIAL blocks=${d.partial} lines=${d.partialLines}; UNIQUE blocks=${d.unique} lines=${d.uniqueLines}`);
  }

  if (!apply) {
    console.log(`\nDry run: nothing written. Re-run with --apply to remove ${totals.blocks} block(s) and ${totals.decls} declaration(s) (${totals.lines} lines).`);
    return;
  }

  for (let i = 0; i < parsed.length; i++) {
    const sheet = parsed[i];
    if (plans[i].safe.size === 0) continue;
    fs.writeFileSync(path.join(PUBLIC_DIR, sheet.href), sheet.next);
  }
  console.log(`\nApplied: removed ${totals.blocks} block(s) and ${totals.decls} declaration(s) (${totals.lines} lines) from ${totals.files} file(s).`);
}

main();
