'use strict';

const { spawn } = require('child_process');

const GH_TIMEOUT_MS = 60_000;

// Deliberately not shared with main.js: post.js must load without it.
function scrub(s, home) {
  return home ? String(s).split(home).join('~') : String(s);
}

function countStates(results) {
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOTRUN: 0 };
  for (const r of results) counts[r.state] += 1;
  return counts;
}

function statusState(results) {
  const counts = countStates(results);
  if (counts.FAIL > 0) return 'failure';
  if (counts.BLOCKED > 0) return 'error';
  return 'success';
}

function repairedCell(repaired) {
  if (!repaired || !repaired.length) return 'none';
  return repaired.map((r) => `${r.what}: ${r.detail}`.replace(/\s+/g, ' ').trim()).join('; ').replaceAll('|', '\\|');
}

// Fail closed: a status that claims a subset must be consistent with what ran.
function checkSelection(sel, notSelected) {
  if (!sel || typeof sel !== 'object') throw new Error('post: missing selection');
  if (sel.mode !== 'full' && sel.mode !== 'partial') throw new Error(`post: bad selection mode ${sel.mode}`);
  if (!Array.isArray(sel.ids) || !Number.isInteger(sel.total)) throw new Error('post: malformed selection');
  if (sel.mode === 'full' && sel.ids.length < sel.total) throw new Error(`post: full run selected ${sel.ids.length} of ${sel.total}`);
  if (sel.mode === 'partial' && sel.ids.length === sel.total) throw new Error(`post: partial run selected all ${sel.total}`);
  if (sel.mode === 'partial' && (!Array.isArray(notSelected) || notSelected.length !== sel.total - sel.ids.length)) {
    throw new Error('post: not-selected list does not match selection');
  }
}

const DESCRIPTION_MAX = 140;

function statusDescription(results, sel, home) {
  const c = countStates(results);
  const head = `${sel.mode} ${sel.ids.length}/${sel.total} pass=${c.PASS} fail=${c.FAIL} blocked=${c.BLOCKED} notrun=${c.NOTRUN}`;
  const tail = sel.mode === 'partial' ? ` areas ${sel.areas.join(',') || 'none'}` : ` why ${sel.why}`;
  return scrub(head + tail, home).slice(0, DESCRIPTION_MAX);
}

function cell(s) {
  return String(s).replace(/\s+/g, ' ').trim().replaceAll('|', '\\|');
}

function renderComment({ commit, toolCommit, runMs, worldSummary, repaired = [], home, results, selection, notSelected = [] }) {
  checkSelection(selection, notSelected);
  const sel = selection;
  const lines = [
    `### devbox/verify: ${statusState(results)}, ${sel.mode} ${sel.ids.length} of ${sel.total} journeys`,
    '',
    '| | |',
    '|---|---|',
    `| Eve commit | \`${commit}\` |`,
    `| Selection | ${cell(`${sel.mode}, ${sel.ids.length} of ${sel.total}, areas ${sel.areas.join(',') || 'none'}, why ${sel.why}`)} |`,
    ...(sel.mode === 'partial' ? [`| Not selected | ${notSelected.map((id) => `\`${id}\``).join(', ')} |`] : []),
    `| World verify | ${worldSummary} |`,
    `| Repaired | ${repairedCell(repaired)} |`,
    `| Tool commit | \`${toolCommit}\` |`,
    `| Run time | ${Math.round(runMs / 1000)} s |`,
    '',
    '| Journey | Result | Detail |',
    '|---|---|---|',
    ...results.map((r) => `| \`${r.id}\` | ${r.state} | ${String(r.detail).replace(/\s+/g, ' ').trim().replaceAll('|', '\\|')} |`),
  ];
  return scrub(lines.join('\n') + '\n', home);
}

function commentUrlFrom(ghStdout) {
  const lines = String(ghStdout).split('\n').map((l) => l.trim()).filter(Boolean);
  const url = lines.length ? lines[lines.length - 1] : '';
  if (!url.startsWith('https://')) throw new Error('gh pr comment printed no comment URL');
  return url;
}

function gh(args, { cwd, stdin = '' }) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd, stdio: ['pipe', 'pipe', 'inherit'], timeout: GH_TIMEOUT_MS });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', (err) => reject(new Error(`gh ${args[0]} ${args[1]} failed: ${err.message}`)));
    child.on('close', (code, signal) => {
      if (code === 0) return resolve(out.trim());
      reject(new Error(`gh ${args[0]} ${args[1]} failed: ${signal ? `killed by ${signal}` : `exit ${code}`}`));
    });
    child.stdin.end(stdin);
  });
}

async function prHead(pr, { cwd }) {
  const head = await gh(['pr', 'view', String(pr), '--json', 'headRefOid', '-q', '.headRefOid'], { cwd });
  if (!head) throw new Error(`PR ${pr} has no head commit`);
  return head;
}

// Comment first so the commit status can link to the comment.
async function post(ev, { cwd }) {
  checkSelection(ev.selection, ev.notSelected);
  const out = await gh(['pr', 'comment', String(ev.pr), '--body-file', '-'], { cwd, stdin: renderComment(ev) });
  const commentUrl = commentUrlFrom(out);
  const description = statusDescription(ev.results, ev.selection, ev.home);
  await gh([
    'api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${ev.commit}`,
    '-f', `state=${statusState(ev.results)}`,
    '-f', 'context=devbox/verify',
    '-f', `target_url=${commentUrl}`,
    '-f', `description=${description}`,
  ], { cwd });
  return commentUrl;
}

const FULL_CONTEXT = 'devbox/verify-full';
const SHA40 = /^[0-9a-f]{40}$/;

// Success needs every journey reported: a short or empty run is not a full run.
function fullState(results, total) {
  const c = countStates(results);
  if (total > 0 && results.length === total && c.FAIL === 0 && c.BLOCKED === 0) return 'success';
  return c.FAIL > 0 ? 'failure' : 'error';
}

function fullDescription(results, total) {
  const c = countStates(results);
  return `full ${results.length}/${total} pass=${c.PASS} fail=${c.FAIL} blocked=${c.BLOCKED} notrun=${c.NOTRUN}`.slice(0, DESCRIPTION_MAX);
}

function fullVerifyLine(slug, sha) {
  if (!SHA40.test(sha)) throw new Error(`full verify: not a 40-hex sha: ${sha}`);
  return `Full verify: ${slug}@${sha}`;
}

// Explicit slug and branch: the full run is graded against the repo's default branch, not the cwd's remote guess.
async function defaultBranchHead({ cwd, ghFn = gh }) {
  const repo = JSON.parse(await ghFn(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], { cwd }));
  const slug = repo.nameWithOwner;
  const branch = repo.defaultBranchRef && repo.defaultBranchRef.name;
  if (!slug || !branch) throw new Error('gh repo view named no repository or default branch');
  const head = await ghFn(['api', `repos/${slug}/commits/${branch}`, '-q', '.sha'], { cwd });
  if (!SHA40.test(head)) throw new Error(`GitHub returned no 40-hex head for ${slug} ${branch}`);
  return { slug, branch, head };
}

// Status first, awaited; the comment only follows a success status.
async function postFull({ slug, head, epic, results, total }, { cwd, ghFn = gh }) {
  const state = fullState(results, total);
  await ghFn([
    'api', '-X', 'POST', `repos/${slug}/statuses/${head}`,
    '-f', `state=${state}`,
    '-f', `context=${FULL_CONTEXT}`,
    '-f', `description=${fullDescription(results, total)}`,
  ], { cwd });
  if (state !== 'success') return { state, commented: false };
  await ghFn(['issue', 'comment', String(epic.number), '-R', epic.repo || slug, '--body-file', '-'],
    { cwd, stdin: fullVerifyLine(slug, head) + '\n' });
  return { state, commented: true };
}

module.exports = {
  statusState, renderComment, checkSelection, statusDescription, commentUrlFrom, gh, prHead, post,
  FULL_CONTEXT, fullState, fullDescription, fullVerifyLine, defaultBranchHead, postFull,
};
