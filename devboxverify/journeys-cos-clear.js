// The Chief of Staff /clear journey (G6.103 simple path): the owner types /clear and the thread
// starts afresh, the next answer remembers nothing. See README.md. Model wording is never
// judged: only structure (the marker, the session ids, the frames). The person model runs on
// whatever the stack names, Haiku in a stack run. The shared helpers live in journeys.js, which
// requires this file at its bottom, so they are fetched when a journey runs.
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const { expect } = require('@playwright/test');
const {
  PASS, FAIL, BLOCKED, result, need, poll, openEve,
} = require('./journey-kit');

const exec = promisify(execFile);

const COS_TURN_WITHIN_MS = 120000; // the person model's turn, as for the other Chief of Staff journeys
const CLEAR_WITHIN_MS = 30000; // eve sends the snapshot once the DELETEs and writes settle; no model turn
const STATE_FILE = 'chief-of-staff-state.json';
const ARCHIVE_FILE = 'chief-of-staff-archive.jsonl';

const kit = () => require('./journeys');

// Eve's Chief of Staff frames: every post in arrival order, and a count of snapshots.
function frames(page) {
  const seen = { posts: [], snapshots: 0 };
  const take = (m) => {
    if (!m) return;
    if (m.type === 'cos_snapshot') seen.snapshots += 1;
    if (m.type === 'cos_post' && m.post) seen.posts.push(m.post);
  };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    let frame;
    try { frame = JSON.parse(payload); } catch { return; }
    if (frame.type === '__batch' && Array.isArray(frame.msgs)) frame.msgs.forEach(take);
    else take(frame);
  }));
  return seen;
}

// Types one line to the Chief of Staff; returns where the new posts begin.
async function say(page, seen, text) {
  const input = page.getByTestId('cos-input');
  await input.fill(text, { timeout: 5000 });
  const from = seen.posts.length;
  await input.press('Enter');
  return kit().afterOwnPost(seen, from, text);
}

// The first reply or notice from `from` on; null at the turn bound.
const waitAnswer = (seen, from) => poll(async () => seen.posts.slice(from).find((p) => p.kind === 'reply' || p.kind === 'notice') || null,
  { timeoutMs: COS_TURN_WITHIN_MS, intervalMs: 250 });

async function readJson(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
}

// The session ids `relay logs --event session.delete` names.
async function deletedIds(env) {
  const args = ['logs', '--event', 'session.delete', '--json'];
  if (env.relayConfigDir) args.unshift('--config-dir', env.relayConfigDir);
  let stdout = '';
  try {
    ({ stdout } = await exec(env.relayBin, args, { timeout: 10000, maxBuffer: 32 << 20 }));
  } catch (err) {
    if (err && err.code === 1) return new Set(); // relay logs exits 1 when nothing matched
    throw err;
  }
  const ids = new Set();
  for (const line of stdout.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o && o.event === 'session.delete' && o.session_id) ids.add(o.session_id);
  }
  return ids;
}

const said = (post) => String(post.body || post.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);

async function cosClear(env) {
  const id = 'cos-clear';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  if (!env.dataDir) return result(id, BLOCKED, `no pinned data dir for ${env.service}`);
  const marker = `verify-${env.nonce}-word`;

  const page = await env.newPage();
  const seen = frames(page);
  await openEve(page, env);
  env.step('open Chief of Staff');
  await page.getByTestId('sidebar-chief-of-staff').click({ timeout: 10000 });
  await need('the Chief of Staff thread did not open', expect(page.getByTestId('cos-page')).toBeVisible({ timeout: 10000 }));

  env.step('ask it to remember a code word');
  const remember = `Remember this code word for later: ${marker}. Reply with OK.`;
  const start = await say(page, seen, remember);
  const first = await waitAnswer(seen, start);
  if (!first) return result(id, FAIL, `no reply within ${COS_TURN_WITHIN_MS / 1000}s of the first message`);
  if (first.kind !== 'reply') return result(id, FAIL, `the first answer was a ${first.kind}, not a reply: "${said(first)}"`);

  const statePath = path.join(env.dataDir, STATE_FILE);
  const before = await poll(async () => {
    const s = await readJson(statePath);
    return s && typeof s.personSessionId === 'string' ? s : null;
  }, { timeoutMs: 10000, intervalMs: 250 });
  if (!before) return result(id, FAIL, `${STATE_FILE} holds no personSessionId after the first reply`);
  const oldId = before.personSessionId;

  env.step('type /clear');
  const snapsBefore = seen.snapshots;
  const input = page.getByTestId('cos-input');
  await input.fill('/clear', { timeout: 5000 });
  await input.press('Enter');
  const cleared = await poll(async () => (seen.snapshots > snapsBefore ? true : null), { timeoutMs: CLEAR_WITHIN_MS, intervalMs: 100 });
  if (!cleared) return result(id, FAIL, `no cos_snapshot within ${CLEAR_WITHIN_MS / 1000}s of /clear`);

  const problems = [];
  const emptied = await expect(page.getByTestId('cos-empty')).toBeVisible({ timeout: 10000 }).then(() => true, () => false);
  if (!emptied) problems.push('the page does not show the empty-thread line after /clear');
  if (!(await deletedIds(env)).has(oldId)) problems.push(`relay logs hold no session.delete for the old person session ${oldId}`);
  const after = await readJson(statePath);
  if (after && after.personSessionId === oldId) problems.push(`${STATE_FILE} still names the old person session ${oldId}`);

  const archive = await fs.promises.readFile(path.join(env.dataDir, ARCHIVE_FILE), 'utf8').catch(() => '');
  const archived = archive.split('\n').some((line) => {
    try { const o = JSON.parse(line); return o && o.post && o.post.kind === 'person' && o.post.text === remember; } catch { return false; }
  });
  if (!archived) problems.push(`${ARCHIVE_FILE} holds no line for the first person post`);

  env.step('ask what it remembers');
  const recall = 'What code word did I ask you to remember? If you do not know, reply with exactly: none';
  const start2 = await say(page, seen, recall);
  const second = await waitAnswer(seen, start2);
  if (!second) return result(id, FAIL, `no reply within ${COS_TURN_WITHIN_MS / 1000}s of the second message; ${problems.join('; ')}`.replace(/; $/, ''));
  if (second.kind !== 'reply') problems.push(`the second answer was a ${second.kind}, not a reply: "${said(second)}"`);
  else if (String(second.body || '').includes(marker)) problems.push('the second reply holds the code word');

  const final = await poll(async () => {
    const s = await readJson(statePath);
    return s && s.personSessionId ? s : null;
  }, { timeoutMs: 10000, intervalMs: 250 });
  if (!final) problems.push(`${STATE_FILE} holds no personSessionId after the second reply`);
  else if (final.personSessionId === oldId) problems.push(`personSessionId is still the old ${oldId}`);

  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `after /clear one cos_snapshot arrived and the page showed the empty line; relay logged a session.delete for the old person session; `
    + `${ARCHIVE_FILE} held the first person post; the next reply lacked the code word and personSessionId changed`);
}

module.exports = {
  journeys: {
    cosClear: {
      id: 'cos-clear', timeoutMs: 300000, areas: ['chief-of-staff'], claude: true, needs: ['project:acme'], run: cosClear,
    },
  },
};
