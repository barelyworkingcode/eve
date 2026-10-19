// The Chief of Staff delegation journey (G6.97, G6.98, G6.102 simple path): an instruction in
// words becomes one card, Approve makes eve send the keep-going text when the agent's turn ends,
// and Stop posts the digest. See README.md. Model wording is never judged: only structure.
// Everything live runs on claude-haiku-5-5 unless the stack names another. The helpers the
// other Chief of Staff journeys share live in journeys.js, which requires this file at its
// bottom, so they are fetched when a journey runs; journeys.js exports none of the small ones
// below, so they repeat theirs.
const { promisify } = require('util');
const { execFile } = require('child_process');
const { expect } = require('@playwright/test');
const {
  PASS, FAIL, BLOCKED, result, need, poll, openEve, acmeIds, addedIds, deleteSession,
} = require('./journey-kit');

const exec = promisify(execFile);

const COS_MODEL = 'haiku';
const COS_TURN_WITHIN_MS = 120000; // the person model's turn that writes the card
const AGENT_START_WITHIN_MS = 30000;
const SEND_WITHIN_MS = 120000; // the agent's turn, then eve's send
const DIGEST_WITHIN_MS = 30000; // eve posts the digest as Stop is handled; no model turn

const kit = () => require('./journeys');

// Eve's own Chief of Staff frames: the newest status and every post, in arrival order.
function frames(page) {
  const seen = { status: null, posts: [] };
  const take = (m) => {
    if (!m) return;
    if ((m.type === 'cos_snapshot' || m.type === 'cos_status') && m.status) seen.status = m.status;
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

// A listed Claude Haiku session in Acme Corp, made over eve's own socket so it can carry a name.
// The cleanup is registered before the wait, so it removes whatever the call added.
async function startAgent(env, name) {
  const project = env.world.projects.acme;
  const before = await acmeIds(env, 'sessions');
  env.cleanup(`delete the ${project.name} agent session`, async () => {
    for (const sid of addedIds(before, await acmeIds(env, 'sessions'))) await deleteSession(env, sid);
  });
  env.step('start the agent session');
  const conn = await env.api._connect();
  try {
    conn.send({ type: 'create_session', projectId: project.id, model: COS_MODEL, name, settings: { permissionMode: 'default' } });
    const added = await poll(async () => {
      const ids = addedIds(before, await acmeIds(env, 'sessions'));
      return ids.length ? ids : null;
    }, { timeoutMs: AGENT_START_WITHIN_MS, intervalMs: 1000 });
    return added && added.length === 1 ? { id: added[0] } : { count: added ? added.length : 0 };
  } finally {
    conn.close();
  }
}

// The `chief_of_staff.send` event lines `relay logs` holds for one session, newer than `sinceMs`.
async function sendEvents(env, sessionId, sinceMs) {
  const args = ['logs', '--event', 'chief_of_staff.send', '--json'];
  if (env.relayConfigDir) args.unshift('--config-dir', env.relayConfigDir);
  let stdout = '';
  try {
    ({ stdout } = await exec(env.relayBin, args, { timeout: 10000, maxBuffer: 32 << 20 }));
  } catch (err) {
    if (err && err.code === 1) return []; // relay logs exits 1 when nothing matched
    throw err;
  }
  const rows = [];
  for (const line of stdout.split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.event !== 'chief_of_staff.send' || o.session_id !== sessionId) continue;
    if (!(Date.parse(o.ts) >= sinceMs)) continue;
    rows.push({ status: o.status, origin: o.origin, reason: o.reason });
  }
  return rows;
}

const said = (post) => String(post.body || post.text || post.error || '').replace(/\s+/g, ' ').trim().slice(0, 160);

async function cosDelegation(env) {
  const id = 'cos-delegation';
  if (env.cosSetupProblem) return result(id, BLOCKED, env.cosSetupProblem);
  const label = `verify-${env.nonce} keep`;
  const made = await startAgent(env, label);
  if (!made.id) return result(id, FAIL, `${made.count || 'no'} new sessions within ${AGENT_START_WITHIN_MS / 1000}s of create_session, expected 1`);
  const sid = made.id;

  const page = await env.newPage();
  const seen = frames(page);
  await openEve(page, env);
  env.step('open Chief of Staff');
  await page.getByTestId('sidebar-chief-of-staff').click({ timeout: 10000 });
  await need('the Chief of Staff thread did not open', expect(page.getByTestId('cos-page')).toBeVisible({ timeout: 10000 }));

  const words = `I'm away. Keep ${label} going until it is ready to merge.`;
  const input = page.getByTestId('cos-input');
  await input.fill(words, { timeout: 5000 });
  const from = seen.posts.length;
  env.step('press Return');
  await input.press('Enter');
  const start = await kit().afterOwnPost(seen, from, words);

  env.step('wait for the card');
  const first = await poll(async () => seen.posts.slice(start).find((p) => ['delegation_card', 'reply', 'notice'].includes(p.kind)) || null,
    { timeoutMs: COS_TURN_WITHIN_MS, intervalMs: 250 });
  if (!first) return result(id, FAIL, `no post within ${COS_TURN_WITHIN_MS / 1000}s of Return`);
  if (first.kind !== 'delegation_card') return result(id, FAIL, `the Chief of Staff posted a ${first.kind} instead of a delegation card: "${said(first)}"`);

  const problems = [];
  const cards = seen.posts.slice(start).filter((p) => p.kind === 'delegation_card');
  if (cards.length !== 1) problems.push(`${cards.length} delegation cards arrived, want 1`);
  const rules = (first.card && first.card.rules) || [];
  const keep = rules.filter((r) => r.kind === 'continue');
  if (rules.length !== 1 || keep.length !== 1) problems.push(`the card holds ${rules.length} rule(s), ${keep.length} of them keep-going, want one keep-going rule`);
  else if (!(keep[0].sessions || []).some((s) => s.sessionId === sid)) problems.push(`the keep-going rule does not name session ${sid}`);
  const card = page.getByTestId(`cos-card-${first.id}`);
  await need('the card is not on the page', expect(card).toBeVisible({ timeout: 10000 }));
  if (!(await expect(card.getByRole('heading', { name: "Act for you while you're away" })).toBeVisible({ timeout: 5000 }).then(() => true, () => false))) {
    problems.push('the card has no heading "Act for you while you\'re away"');
  }
  if (problems.length) return result(id, FAIL, problems.join('; '));

  // From Approve on, a delegation is active until Stop; the finally ends it whatever the verdict.
  let stopped = false;
  const stop = page.getByTestId('cos-delegation-stop');
  try {
    env.step('tap Approve');
    const approvedAt = Date.now();
    await page.getByTestId(`cos-approve-${first.id}`).click({ timeout: 5000 });
    const bar = page.getByTestId('cos-delegation-bar-text');
    if (!(await expect(bar).toContainText('Acting for you until', { timeout: 15000 }).then(() => true, () => false))) {
      return result(id, FAIL, 'no bar "Acting for you until" within 15s of Approve');
    }

    // A fresh agent has no turn to end, so give it one from a page of its own. It stays open
    // to the end: relay may settle the session once no browser holds it.
    env.step('give the agent a turn');
    const asker = await env.newPage();
    env.cleanup('close the asking page', () => asker.close());
    await openEve(asker, env, `#session/${sid}`);
    const composer = asker.getByTestId('chat-input');
    await need('the composer never became usable', expect(composer).toBeEnabled({ timeout: 30000 }));
    await composer.fill(`Reply with the single word working. (verify ${env.nonce})`, { timeout: 5000 });
    await asker.getByTestId('chat-submit').click({ timeout: 5000 });

    env.step('wait for relay\'s send event');
    let rows = [];
    const sent = await poll(async () => {
      rows = await sendEvents(env, sid, approvedAt);
      return rows.length ? rows : null;
    }, { timeoutMs: SEND_WITHIN_MS, intervalMs: 1000 });
    if (!sent) {
      const waiting = seen.status && seen.status.delegation ? 'the bar was still showing' : 'the bar was gone';
      return result(id, FAIL, `relay logged no chief_of_staff.send for session ${sid} within ${SEND_WITHIN_MS / 1000}s of the agent's turn (${waiting})`);
    }
    if (sent.length !== 1 || sent[0].status !== 'ok') {
      problems.push(`relay logged ${sent.length} chief_of_staff.send line(s) for the session: ${sent.map((r) => `${r.status}${r.reason ? `/${r.reason}` : ''}`).join(', ')}, want one ok`);
    }
    // The sent post follows relay's acceptance; its chip says the send was for the owner.
    const post = await poll(async () => seen.posts.find((p) => p.kind === 'sent' && p.sessionId === sid && p.delegation) || null,
      { timeoutMs: 15000, intervalMs: 250 });
    if (!post) problems.push('no sent post with a delegation arrived for the session');
    else if (!(await expect(page.getByTestId(`cos-post-${post.id}`).getByTestId('cos-sent-chip')).toContainText('Sent for you', { timeout: 10000 }).then(() => true, () => false))) {
      problems.push('the sent post\'s chip does not read "Sent for you"');
    }

    env.step('tap Stop');
    await stop.click({ timeout: 5000 });
    stopped = true;
    env.step('wait for the digest');
    const digest = await poll(async () => seen.posts.find((p) => p.kind === 'delegation_digest') || null,
      { timeoutMs: DIGEST_WITHIN_MS, intervalMs: 250 });
    if (!digest) return result(id, FAIL, `no digest post within ${DIGEST_WITHIN_MS / 1000}s of Stop; ${problems.join('; ')}`.replace(/; $/, ''));
    const shown = page.getByTestId(`cos-post-${digest.id}`);
    if (!(await expect(shown.getByRole('heading', { name: 'While you were away' })).toBeVisible({ timeout: 10000 }).then(() => true, () => false))) {
      problems.push('the digest has no heading "While you were away"');
    }
    if (seen.posts.filter((p) => p.kind === 'delegation_digest').length !== 1) problems.push('more than one digest arrived');
    if (!(await expect(page.getByTestId('cos-delegation-bar-text')).toBeHidden({ timeout: 10000 }).then(() => true, () => false))) {
      problems.push('the bar is still shown after Stop');
    }
    if (problems.length) return result(id, FAIL, problems.join('; '));
    return result(id, PASS, `one card with one keep-going rule naming ${label}; after Approve the bar showed, relay logged an ok chief_of_staff.send `
      + `for the session and the post's chip read "Sent for you"; after Stop one digest "While you were away" arrived`);
  } finally {
    if (!stopped) await stop.click({ timeout: 3000 }).catch(() => {});
  }
}

module.exports = {
  journeys: {
    cosDelegation: {
      id: 'cos-delegation', claude: true, timeoutMs: 420000, areas: ['chief-of-staff'], needs: ['project:acme'], run: cosDelegation,
    },
  },
};
