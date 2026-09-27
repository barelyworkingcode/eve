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

function renderComment({ commit, toolCommit, worldSummary, home, results }) {
  const lines = [
    `### devbox/verify: ${statusState(results)}`,
    '',
    '| | |',
    '|---|---|',
    `| Eve commit | \`${commit}\` |`,
    `| World verify | ${worldSummary} |`,
    `| Tool commit | \`${toolCommit}\` |`,
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
  const out = await gh(['pr', 'comment', String(ev.pr), '--body-file', '-'], { cwd, stdin: renderComment(ev) });
  const commentUrl = commentUrlFrom(out);
  const c = countStates(ev.results);
  const description = `pass=${c.PASS} fail=${c.FAIL} blocked=${c.BLOCKED} notrun=${c.NOTRUN}`;
  await gh([
    'api', '-X', 'POST', `repos/{owner}/{repo}/statuses/${ev.commit}`,
    '-f', `state=${statusState(ev.results)}`,
    '-f', 'context=devbox/verify',
    '-f', `target_url=${commentUrl}`,
    '-f', `description=${description}`,
  ], { cwd });
  return commentUrl;
}

module.exports = { statusState, renderComment, commentUrlFrom, prHead, post };
