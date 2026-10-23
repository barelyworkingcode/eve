// The history-resume journey (G2.58): a Claude terminal started from the Launcher, renamed with /rename and closed,
// is listed on the Resume tab under its own title with the badge "Terminal"; one tap on Resume opens a terminal tab
// on the same conversation, whose scrollback holds the earlier prompt. See README.md.
// Waits: the tab and pane by locator; the History rows by locator after each reopen of the Launcher. Claude's first
// prompt, its reply and /rename have no signal, so they are bounded reads of the terminal's text, as outside-adopt reads
// its transcript. Cleanup closes the terminals this journey opened and never touches tmux.
const { expect } = require('@playwright/test');
const { PASS, FAIL, BLOCKED, result, need, poll, openEve, openProject, openLauncher, waitForModels, acmeIds, addedIds } = require('./journey-kit');

const TITLE = 'History journey';
const READY_WITHIN_MS = 60000; // Claude's start-up, the MCP servers and the trust prompt
const REPLY_WITHIN_MS = 120000;
const RENAME_WITHIN_MS = 60000; // TUI output with no signal: the rename counts once relay's row carries the title
const ROW_WITHIN_MS = 90000; // relay re-reads transcripts on a scan
const TAB_WITHIN_MS = 30000;
const SCROLLBACK_WITHIN_MS = 60000;

// The pane's visible rows plus the whole scrollback buffer, whitespace removed: xterm wraps rows even mid-word.
async function paneText(page) {
  const visible = await page.locator('#terminal').innerText({ timeout: 2000 }).catch(() => '');
  const buffered = await page.evaluate(() => {
    const b = window.client?.terminalManager?.activeTerm?.()?.buffer?.active;
    if (!b) return '';
    let out = '';
    for (let i = 0; i < b.length; i++) out += (b.getLine(i)?.translateToString(true) || '') + '\n';
    return out;
  }).catch(() => '');
  // flat is the buffer when xterm has one (it holds the visible rows too), else the visible rows: never both, so a
  // string shown once counts once.
  return { visible: visible.replace(/\s+/g, ''), flat: (buffered || visible).replace(/\s+/g, '') };
}

// The newest session_history frame this page received, rows as relay sent them (a live terminal's row included).
function historyFrames(page) {
  const seen = { rows: [], frames: 0 };
  const take = (m) => {
    if (m && m.type === 'session_history' && Array.isArray(m.rows)) { seen.rows = m.rows; seen.frames += 1; }
  };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    let f;
    try { f = JSON.parse(payload); } catch { return; }
    if (f && f.type === '__batch' && Array.isArray(f.msgs)) f.msgs.forEach(take);
    else take(f);
  }));
  return seen;
}

// What relay's rows showed, for a failure detail. Titles are untrusted text: cut and quoted.
const describeRows = (rows) => (rows.length
  ? rows.map((r) => `{title:${JSON.stringify(String(r.title ?? null).slice(0, 60))}, titleSource:${JSON.stringify(r.titleSource ?? null)}, state:${r.state}, resume:${r.resume}${r.resumeReason ? `/${r.resumeReason}` : ''}, transcript:${r.transcript}}`).join(' ')
  : 'no rows');

async function screenTail(page) {
  const text = await page.locator('#terminal').innerText({ timeout: 2000 }).catch(() => '');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-12);
  return lines.length ? lines.join(' | ').slice(0, 800) : 'empty';
}

const occurrences = (text, needle) => text.split(needle).length - 1;

// Answers Claude's folder-trust prompt when it shows. A stack's world clone is a folder Claude has not been told to
// trust; the prompt's cursor starts on "No, exit", so the cursor moves to "Yes, I trust" before it confirms.
function trustAnswerer(page) {
  let confirmed = false;
  return async (visible) => {
    if (confirmed || !visible.includes('Yes,Itrustthisfolder')) return;
    if (visible.includes('❯Yes,Itrustthisfolder')) { confirmed = true; await page.keyboard.press('Enter'); }
    else if (visible.includes('❯No,exit')) await page.keyboard.press('ArrowDown');
  };
}

// Types a line into Claude's input box and submits it. Claude's box reads text that arrives with its Enter in one burst
// as a paste, and then Enter is a newline: so the Enter is sent only after the typed text shows in the box, and once
// more if the box still holds the line after it. Both waits are bounded reads of the screen; the box has no signal.
async function typeLine(page, text) {
  await page.locator('#terminal .xterm-screen').filter({ visible: true }).last().click({ timeout: 5000 });
  await page.keyboard.type(text);
  const flat = text.replace(/\s+/g, '');
  const inBox = async () => (await paneText(page)).visible.includes(`\u276F${flat}`);
  const typed = await poll(async () => ((await inBox()) ? true : null), { timeoutMs: 10000, intervalMs: 200 });
  if (!typed) throw new Error(`the typed line never showed in Claude's input box within 10s (screen: ${await screenTail(page)})`);
  await page.keyboard.press('Enter');
  const sent = await poll(async () => ((await inBox()) ? null : true), { timeoutMs: 10000, intervalMs: 200 });
  if (!sent) await page.keyboard.press('Enter');
}

async function activeTab(page, why) {
  await need(`${why}: no active tab and terminal pane within ${TAB_WITHIN_MS / 1000}s`, Promise.all([
    expect(page.locator('.tab.active')).toBeVisible({ timeout: TAB_WITHIN_MS }),
    expect(page.locator('#terminal')).toBeVisible({ timeout: TAB_WITHIN_MS }),
  ]));
}

// Opens the Launcher on its Resume tab and waits for the History rows or the "unavailable" line.
// Returns { dialog, text } with the dialog's text once one of them shows.
async function openResumeTab(page, env) {
  const dialog = await openLauncher(page, env);
  await dialog.getByRole('button', { name: 'Resume', exact: true }).click({ timeout: 5000 });
  await need('the Resume tab shows neither History rows nor "History unavailable" within 20s', expect(
    dialog.getByRole('heading', { name: 'History' }).or(dialog.getByText('History unavailable')),
  ).toBeVisible({ timeout: 20000 }));
  return dialog;
}

async function historyResume(env) {
  const id = 'history-resume';
  const acme = env.world.projects.acme;
  const marker = `verify-${env.nonce}-history`;

  const page = await env.newPage();
  const seen = historyFrames(page);
  await openEve(page, env);
  await waitForModels(page, env);
  const terminalsBefore = await acmeIds(env, 'terminals');
  // Registered before the first terminal exists: whatever this journey opened is closed, even on a failure path.
  env.cleanup(`close the ${acme.name} terminals the history journey opened`, async () => {
    let failure = null;
    for (const tid of addedIds(terminalsBefore, await acmeIds(env, 'terminals'))) {
      await env.api.closeTerminal(tid).catch((err) => { failure = failure || err; });
    }
    if (failure) throw failure;
  });

  await openProject(page, env, acme);
  env.step('start the Claude terminal');
  const launcher = await openLauncher(page, env);
  await need('terminal templates never loaded', expect(launcher.getByText('Loading terminal templates…')).toHaveCount(0, { timeout: 15000 }));
  const claude = launcher.getByRole('button', { name: /^Claude/ }).first();
  const offered = await claude.isVisible().catch(() => false);
  if (!offered) return result(id, BLOCKED, `the Launcher offers no Claude terminal in ${acme.name}`);
  await claude.click({ timeout: 5000 });
  await activeTab(page, 'Claude terminal');

  env.step('wait for the Claude prompt');
  const trust = trustAnswerer(page);
  const ready = await poll(async () => {
    const { visible } = await paneText(page);
    await trust(visible);
    return visible.includes('forshortcuts') || visible.includes('❯') ? true : null;
  }, { timeoutMs: READY_WITHIN_MS, intervalMs: 500 });
  if (!ready) return result(id, BLOCKED, `the Claude terminal showed no prompt within ${READY_WITHIN_MS / 1000}s (model start-up has no signal)`);

  env.step('send the prompt');
  await typeLine(page, `Reply with exactly ${marker} and nothing else.`);
  // The prompt itself carries the marker: the reply is a marker left once every copy of the prompt is taken out.
  const promptFlat = `Replywithexactly${marker}andnothingelse.`;
  const replied = await poll(async () => ((await paneText(page)).flat.split(promptFlat).join('').includes(marker) ? true : null), { timeoutMs: REPLY_WITHIN_MS, intervalMs: 1000 });
  if (!replied) return result(id, BLOCKED, `claude did not reply ${marker} within ${REPLY_WITHIN_MS / 1000}s (model output; screen: ${await screenTail(page)})`);

  env.step('rename the conversation');
  await typeLine(page, `/rename ${TITLE}`);
  // The rename counts once relay's own row carries the title while the terminal is still open: the Resume tab asks
  // relay each time it opens, and the frame lists a live terminal's row too. The screen is a second witness only.
  env.step('wait for relay to show the title');
  const flatTitle = TITLE.replace(/\s+/g, '');
  const renamed = await poll(async () => {
    const d = await openResumeTab(page, env);
    await d.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 5000 });
    return seen.rows.some((r) => r.title === TITLE) ? true : null;
  }, { timeoutMs: RENAME_WITHIN_MS, intervalMs: 2000 });
  if (!renamed) {
    const onScreen = occurrences((await paneText(page)).flat, flatTitle);
    return result(id, FAIL, `relay's history rows never showed the title "${TITLE}" within ${RENAME_WITHIN_MS / 1000}s of /rename, with the terminal still open `
      + `(the title is on screen ${onScreen} time${onScreen === 1 ? '' : 's'}; rows: ${describeRows(seen.rows)}; screen: ${await screenTail(page)})`);
  }

  env.step('close the tab');
  const opened = addedIds(terminalsBefore, await acmeIds(env, 'terminals'));
  if (opened.length !== 1) return result(id, FAIL, `${opened.length} new ${acme.name} terminals after the launch, expected 1`);
  await page.locator('.tab.active .tab-close').click({ timeout: 5000 });
  await need('the terminal never left relay\'s list after the tab closed', expect.poll(
    async () => (await acmeIds(env, 'terminals')).includes(opened[0]), { timeout: 30000 }).toBe(false));

  env.step('look for the row on the Resume tab');
  let dialog;
  let text = '';
  const listed = await poll(async () => {
    dialog = await openResumeTab(page, env);
    text = await dialog.innerText();
    if (text.includes(TITLE)) return true;
    await dialog.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 5000 });
    return null;
  }, { timeoutMs: ROW_WITHIN_MS, intervalMs: 3000 });
  if (!listed) {
    return result(id, FAIL, text.includes('History unavailable')
      ? 'the Resume tab says "History unavailable"'
      : `no History row titled "${TITLE}" within ${ROW_WITHIN_MS / 1000}s of closing the terminal (rows: ${describeRows(seen.rows)}; dialog: ${JSON.stringify(text.slice(0, 300))})`);
  }
  const from = text.indexOf(TITLE);
  const next = text.indexOf('Resume ', from + TITLE.length);
  const rowText = text.slice(from, next < 0 ? undefined : next + 80);
  const problems = [];
  if (!/\bago\b|\bnow\b/.test(rowText)) problems.push(`the row shows no age (${JSON.stringify(rowText.slice(0, 80))})`);
  if (!rowText.includes('Terminal')) problems.push(`the row has no "Terminal" badge (${JSON.stringify(rowText.slice(0, 80))})`);

  env.step('tap Resume');
  await dialog.getByRole('button', { name: `Resume ${TITLE}`, exact: true }).click({ timeout: 5000 });
  await activeTab(page, 'resumed terminal');
  await need('the Launcher stayed open after Resume', expect(dialog).toBeHidden({ timeout: TAB_WITHIN_MS }));

  env.step('wait for the earlier prompt in the scrollback');
  const trustAgain = trustAnswerer(page);
  const carried = await poll(async () => {
    const { visible, flat } = await paneText(page);
    await trustAgain(visible);
    return flat.includes(marker) ? true : null;
  }, { timeoutMs: SCROLLBACK_WITHIN_MS, intervalMs: 500 });
  if (!carried) problems.push(`the resumed terminal's scrollback has no "${marker}" within ${SCROLLBACK_WITHIN_MS / 1000}s of Resume`);
  if (addedIds(terminalsBefore, await acmeIds(env, 'terminals')).length !== 1) problems.push('Resume did not leave exactly one new terminal in relay\'s list');

  if (problems.length) return result(id, FAIL, problems.join('; '));
  return result(id, PASS, `after /rename and closing the terminal, the Resume tab listed "${TITLE}" with its age and badge "Terminal"; `
    + 'Resume opened a terminal tab whose scrollback holds the earlier prompt');
}

module.exports = {
  journeys: {
    historyResume: { id: 'history-resume', claude: true, timeoutMs: 360000, areas: ['chat', 'terminal'], needs: ['project:acme'], run: historyResume },
  },
};
