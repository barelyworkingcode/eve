// Shared helpers for the devbox journeys: waits, readiness gates, and the
// small readers the verdicts rest on. See docs/design-devboxverify.md.
const path = require('path');
const { expect } = require('@playwright/test');

const GREETING = /^(Good morning\.|Good afternoon\.|Good evening\.|Working late\.)$/;
const PASS = 'PASS';
const FAIL = 'FAIL';
const BLOCKED = 'BLOCKED';

const result = (id, state, detail) => ({ id, state, detail });
const firstLine = (err) => String(err?.message || err).split('\n')[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = (since) => Math.round((Date.now() - since) / 1000);
// Deliberate floor of 1 ms: Playwright reads a timeout of 0 as "no timeout".
const left = (deadline) => Math.max(1, deadline - Date.now());

// A failed wait throws with the step it belongs to, since expect's own first
// line ("expect(locator).toBeVisible() failed") names nothing.
async function need(what, promise) {
  try {
    return await promise;
  } catch (err) {
    throw new Error(`${what} (${firstLine(err)})`);
  }
}

async function poll(fn, { timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// D9: an exact match wins over a suffix match, because a box can offer the
// same model through several routes ("pi/…/Chat", "…/Chat") and only some of
// them are the chat kind Acme Corp may launch.
function pickModel(values, want) {
  return values.find((v) => v === want)
    || values.find((v) => v.endsWith(`/${want}`))
    || null;
}

async function optionValues(select) {
  return select.locator('option').evaluateAll((opts) => opts.map((o) => o.value).filter(Boolean));
}

// App readiness is setup, not a verdict: initApp() builds client.state and
// the socket only once the auth status resolves.
async function openEve(page, env, suffix = '', deadline = null) {
  env.step('open eve');
  await page.goto(env.url.replace(/\/?$/, '/') + suffix, { timeout: 30000 });
  await need('eve did not finish loading within 20s', page.waitForFunction(
    () => !!window.client?.state && !!window.client?.wsClient, null, { timeout: deadline ? left(deadline) : 20000 }));
}

// The launcher's model form reads the list once, when it opens.
async function waitForModels(page, env) {
  env.step('wait for the model list');
  await need('no models loaded within 20s', page.waitForFunction(
    () => (window.client?.state?.models?.length || 0) > 0, null, { timeout: 20000 }));
}

async function openProject(page, env, project) {
  env.step(`open ${project.name}`);
  const rail = page.getByRole('navigation', { name: 'Projects' });
  await need(`${project.name} is not in the rail`,
    rail.getByTitle(project.name, { exact: true }).click({ timeout: 15000 }));
  await need(`${project.name} panel did not open`,
    expect(page.locator('#panelTitle')).toHaveText(project.name, { timeout: 10000 }));
}

// The project's page from the panel's Project page button; returns the page.
async function openProjectPage(page, env, project) {
  await openProject(page, env, project);
  env.step(`open ${project.name}'s project page`);
  await page.getByTestId('panel-project-page').click({ timeout: 10000 });
  const projectPage = page.getByTestId(`project-page-${project.id}`);
  await need(`${project.name}'s project page did not open`,
    expect(projectPage.getByRole('heading', { name: 'Threads' })).toBeVisible({ timeout: 10000 }));
  return projectPage;
}

// Edit Project from the open project's panel menu; returns the dialog.
async function openEditProject(page, env, project) {
  env.step(`edit ${project.name}`);
  await page.getByTestId(`sidebar-project-more-${project.id}`).click({ timeout: 10000 });
  await page.locator('.file-tree__context-menu').getByRole('button', { name: 'Edit Project', exact: true }).click({ timeout: 5000 });
  const dialog = page.getByTestId('dialog-project-dialog');
  await need('Edit Project did not open', expect(dialog).toBeVisible({ timeout: 10000 }));
  return dialog;
}

// Edit Project → Templates → the template called `name`: its form when the
// list has it, else a new one from "+ Add Template" with the name typed.
async function openTemplate(page, env, project, name) {
  await openProject(page, env, project);
  const dialog = await openEditProject(page, env, project);
  env.step('open Templates');
  await dialog.locator('.dialog__tab[data-tab="templates"]').click({ timeout: 5000 });
  const add = dialog.getByRole('button', { name: '+ Add Template' });
  await need('the Templates tab did not open', expect(add).toBeVisible({ timeout: 5000 }));
  const row = dialog.locator('.project-dialog__template-item').filter({ has: page.getByText(name, { exact: true }) });
  const added = await row.count() === 0;
  env.step(`${added ? 'add' : 'edit'} template ${name}`);
  await (added ? add : row.first().getByTitle('Edit')).click({ timeout: 5000 });
  const form = dialog.locator('.project-dialog__template-form');
  await need('the template form did not open', expect(form).toBeVisible({ timeout: 5000 }));
  if (added) await form.locator('input[type="text"]').first().fill(name, { timeout: 5000 });
  return { dialog, form, added };
}

// Presses the form's preset button for `mode` unless it is pressed already;
// true when it was. Throws when the form has no such button.
async function pressPreset(form, mode) {
  const btn = form.getByTestId(`project-template-preset-${mode}`);
  const was = await need(`the template form has no ${mode} preset button`, btn.getAttribute('aria-pressed', { timeout: 5000 })) === 'true';
  if (!was) await btn.click({ timeout: 5000 });
  await need(`the ${mode} preset button is not pressed`, expect(btn).toHaveAttribute('aria-pressed', 'true', { timeout: 5000 }));
  return was;
}

async function worldIds(env, projects, kind) {
  const snap = await env.api.snapshot(projects);
  return snap[kind].filter((i) => i.world).map((i) => i.id);
}

const acmeIds = (env, kind) => worldIds(env, [env.world.projects.acme], kind);
// Deliberate: an explicit list, never the view's own keys, so a missing
// declaration blocks the journey instead of quietly narrowing the check.
const allWorldIds = (env, kind) => worldIds(env, ['acme', 'globex', 'home'].map((k) => env.world.projects[k]), kind);

const addedIds = (before, after) => after.filter((id) => !before.includes(id));

async function openLauncher(page, env, project = env.world.projects.acme) {
  env.step('open the session launcher');
  await page.getByTestId(`sidebar-new-session-${project.id}`).click({ timeout: 10000 });
  const dialog = page.getByTestId('dialog-shell-launcher-dialog');
  await need('the launcher did not open', expect(dialog).toBeVisible({ timeout: 10000 }));
  return dialog;
}

// Relay's refusals and session errors arrive as {type:'error'} frames. They
// only classify an outcome and fill the detail; the verdict stays visible.
function captureErrors(page) {
  const errors = [];
  const take = (m) => { if (m && m.type === 'error') errors.push(String(m.message || m.error || '')); };
  page.on('websocket', (ws) => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    let frame;
    try { frame = JSON.parse(payload); } catch { return; }
    if (frame.type === '__batch' && Array.isArray(frame.msgs)) frame.msgs.forEach(take);
    else take(frame);
  }));
  return errors;
}

// The thread as a reader sees it, top to bottom.
async function thread(page) {
  return page.getByTestId('messages-container').evaluate((root) =>
    [...root.children].filter((el) => el.offsetParent !== null).map((el) => ({
      who: el.dataset.testid || '',
      text: (el.querySelector('.message-content')?.innerText || '').trim(),
      error: el.classList.contains('error'),
    })), null, { timeout: 10000 });
}

const threadError = (messages) => messages.find((m) => m.who === 'message-system' && m.error)?.text || '';

function replyAfter(messages, marker) {
  const at = messages.findIndex((m) => m.who === 'message-user' && m.text.includes(marker));
  if (at < 0) return { asked: false, reply: '', error: '' };
  const later = messages.slice(at + 1);
  const reply = later.filter((m) => m.who === 'message-assistant' && m.text).map((m) => m.text).join('\n').trim();
  return { asked: true, reply, error: threadError(later) };
}

// Opens a "World probe" terminal in a project (Acme Corp by default) from the
// launcher. Null when the project offers no such card; throws when the card
// opens no terminal.
async function openWorldProbe(page, env, project = env.world.projects.acme) {
  const ids = () => worldIds(env, [project], 'terminals');
  const before = await ids();
  const dialog = await openLauncher(page, env, project);
  env.step('look for the World probe card');
  const card = dialog.getByRole('button', { name: /World probe/ });
  const loading = dialog.getByText('Loading terminal templates…');
  await need('terminal templates never loaded', expect(loading).toHaveCount(0, { timeout: 15000 }));
  if (await card.count() === 0) return null;
  await card.first().click({ timeout: 5000 });

  env.step('wait for the terminal');
  const mine = await poll(async () => {
    const added = addedIds(before, await ids());
    return added.length ? added : null;
  }, { timeoutMs: 20000, intervalMs: 1000 });
  if (!mine) throw new Error(`no ${project.name} terminal within 20s of World probe`);
  const pane = page.locator('#terminal');
  await need('no terminal pane shown', expect(pane).toBeVisible({ timeout: 15000 }));

  const typeLine = async (line) => {
    env.step('type the probe');
    const screen = pane.locator('.xterm-screen').filter({ visible: true }).last();
    await screen.click({ timeout: 5000 });
    await page.keyboard.type(line);
    await page.keyboard.press('Enter');
  };
  return { terminalId: mine[0], pane, typeLine };
}

// eve's own HTTP API with the run's owner token: setup, cleanup and wire
// checks only. Verdicts on what a person sees stay in the page.
async function eveJson(env, method, path, body) {
  const headers = { 'X-Session-Token': env.session.token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(env.url.replace(/\/+$/, '') + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
  return text ? JSON.parse(text) : null;
}

// `relay audit --event call_tool --json` lines for one project since a mark,
// oldest first: relay's own record of what the project's tools did.
function callToolRows(jsonl, { projectId, sinceMs }) {
  const rows = [];
  for (const line of String(jsonl).split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(o && o.ts);
    if (!o || o.event !== 'call_tool' || (o.actor && o.actor.project_id) !== projectId || !(ts >= sinceMs)) continue;
    // scopeViolation only when relay marked the row: macMCP's own scope refusal.
    rows.push({ ts, tool: o.tool || '', outcome: o.outcome || '', ...(o.scope_violation === true ? { scopeViolation: true } : {}) });
  }
  return rows.sort((a, b) => a.ts - b.ts);
}

// relay's refusal outcomes for a call_tool row.
const DENIED_OUTCOMES = ['denied', 'unauthorized', 'throttled'];
// S3a-A1: what a brief may do with Home's tools, and what it must never do.
const BRIEF_READS = ['mail_get_emails', 'mail_get_email', 'mail_search'];
const BRIEF_READ_SET = ['mail_get_email', 'mail_get_emails', 'mail_list_accounts', 'mail_list_mailboxes', 'mail_search'];
const BRIEF_REFUSED = ['mail_send', 'web_fetch'];

const tally = (rows) => [...new Set(rows.map((r) => `${r.tool} ${r.outcome}`))].join(', ');

// The brief run's call_tool rows judged against S3a-A1. Security findings
// come first: a row outside the read set, then a send or fetch that
// relay did not deny.
function briefRunVerdict(rows) {
  const ok = rows.filter((r) => r.outcome === 'ok');
  const outside = rows.filter((r) => !BRIEF_READ_SET.includes(r.tool) && !DENIED_OUTCOMES.includes(r.outcome));
  if (outside.length) return { state: FAIL, security: true, detail: `security: not denied outside the read set: ${tally(outside)}` };
  const attempts = rows.filter((r) => BRIEF_REFUSED.includes(r.tool));
  const through = attempts.filter((r) => !DENIED_OUTCOMES.includes(r.outcome));
  if (through.length) return { state: FAIL, security: true, detail: `security: not denied: ${tally(through)}` };
  const reads = ok.filter((r) => BRIEF_READS.includes(r.tool)).length;
  if (!reads) return { state: FAIL, detail: 'the brief read no mail' };
  return {
    state: PASS,
    detail: `${reads} mail reads; ok tools ${[...new Set(ok.map((r) => r.tool))].join(', ')}; `
      + `its own send/fetch attempts: ${attempts.length ? `${tally(attempts)}, all denied` : 'none'}`,
  };
}

// The World probe's rows for `tools`: every tool needs a row and every row a
// refusal. A missing row is BLOCKED, since nothing was seen to judge.
function probeVerdict(rows, tools) {
  const mine = rows.filter((r) => tools.includes(r.tool));
  const through = mine.filter((r) => !DENIED_OUTCOMES.includes(r.outcome));
  if (through.length) return { state: FAIL, detail: `security: the probe's ${tally(through)} was not denied` };
  const missing = tools.filter((t) => !mine.some((r) => r.tool === t));
  if (missing.length) return { state: BLOCKED, detail: `relay audit has no probe row for ${missing.join(', ')}` };
  return { state: PASS, detail: `the probe's ${tally(mine)}` };
}

// The last `EVE_NEG <gate> <ddd>... <rest>` line. The typed command line
// cannot match: it builds the marker with printf, so its echo never holds
// "EVE_NEG" itself.
function parseAgentAttempt(text, gate) {
  const escaped = String(gate).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = new RegExp(`(?:^|\\s)EVE_NEG\\s+${escaped}\\s+(\\d{3}(?:\\s+\\d{3})*)(?:\\s+(.*))?$`);
  let found = null;
  for (const raw of String(text).split('\n')) {
    const m = line.exec(raw.trimEnd());
    if (m) found = { codes: m[1].split(/\s+/).map(Number), rest: (m[2] || '').trim() };
  }
  return found;
}

// S4-A1: relay joins an MCP's text blocks with no separator and cuts the
// result at 8,192 bytes with "\n...(truncated)".
const RELAY_RESULT_MAX = 8192;
function relayJoin(blocks) {
  const bytes = Buffer.from(blocks.join(''), 'utf8');
  if (bytes.length <= RELAY_RESULT_MAX) return bytes.toString('utf8');
  return `${bytes.subarray(0, RELAY_RESULT_MAX).toString('utf8')}\n...(truncated)`;
}

// One result as the stub sends it: Python's compact json.dumps, whose
// ensure_ascii escapes every non-ASCII unit (it counts toward relay's cut).
const stubBlock = (r) => JSON.stringify(r).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// The sources a research answer must show: the stub's results joined as relay
// joins them, read by eve's own A1 parser (passed in, so this file needs no
// app code).
function stubSources(stub, Sources) {
  const turn = Sources.turn();
  turn.add(stub.tool, relayJoin(stub.results.map(stubBlock)));
  return turn.list().map((s) => ({ n: s.n, host: s.host, title: s.title.slice(0, 160), excerpt: s.excerpt }));
}

// First differing character of two strings: "at 12: ...around got... vs ...around want...".
function firstDifference(got, want, span = 40) {
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i++;
  const around = (s) => JSON.stringify(s.slice(Math.max(0, i - span), i + span));
  return `at ${i}: ${around(got)} vs ${around(want)}`;
}

// True when p is dir or inside it (both resolved).
function isUnder(p, dir) {
  if (typeof p !== 'string' || !p || typeof dir !== 'string' || !dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The sources row as shown, [{ testid, text }] in page order, against the
// expected sources: null when every card shows its host and number in order.
function sourcesRowProblem(cards, expected) {
  const want = expected.map((s) => `${s.n} ${s.host}`).join(', ');
  if (cards.length !== expected.length) return `the row shows ${cards.length} sources, expected ${expected.length} (${want})`;
  for (let i = 0; i < cards.length; i++) {
    const { testid, text } = cards[i];
    const s = expected[i];
    const rest = String(text).replace(s.host, ' ');
    if (testid !== `answer-source-${s.n}` || !String(text).includes(s.host) || !new RegExp(`(^|\\D)${s.n}(\\D|$)`).test(rest)) {
      return `card ${i + 1} is ${testid} showing "${String(text).replace(/\s+/g, ' ').trim()}", expected ${s.host} and ${s.n} (${want})`;
    }
  }
  return null;
}

// Per-journey devices for env.newPage({ device }). Deliberate: hasTouch only,
// never isMobile, which moves the layout viewport to 980px. hasTouch alone
// makes Chromium match (pointer: coarse). See docs/design-today-s2.md.
const DEVICES = {
  ipadPortrait: { viewport: { width: 834, height: 1194 }, hasTouch: true },
  phone: { viewport: { width: 390, height: 844 }, hasTouch: true },
};

const MIN_TARGET = 43.99;
const OVERFLOW_OK_INSIDE = 'pre, .monaco-editor, .xterm, .terminal-keybar__keys, .tab-bar, .sidebar-rail__projects';

// In-page collectors: facts only, judged below. Each runs inside the page,
// so it may use nothing from this file.
function collectTargets() {
  const sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), '
    + ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
      'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'treeitem'].map((r) => `[role="${r}"]`).join(', ');
  const found = new Set(document.querySelectorAll(sel));
  for (const el of document.querySelectorAll('body *')) {
    const parent = el.parentElement;
    if (getComputedStyle(el).cursor === 'pointer' && (!parent || getComputedStyle(parent).cursor !== 'pointer')) found.add(el);
  }
  const name = (el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : el.id ? `#${el.id}` : ''}`
    + ` "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}"`;
  return [...found].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      label: name(el), width: r.width, height: r.height,
      visible: el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      inViewport: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight,
      hidden: !!el.closest('[inert], [aria-hidden="true"]'),
      prose: el.matches('.message-content a'),
    };
  });
}

function collectOverflow(okInside) {
  const elements = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.right <= innerWidth) continue;
    elements.push({
      label: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/)[0]}` : ''}`,
      right: r.right,
      visible: r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      exempt: !!el.parentElement?.closest(okInside),
    });
  }
  return { scrollWidth: document.documentElement.scrollWidth, innerWidth, elements };
}

// Every visible control a finger can reach that is under 44x44; links in
// message prose are exempt (WCAG 2.5.8 inline).
function smallTargets(targets) {
  return targets.filter((t) => t.visible && t.inViewport && !t.hidden && !t.prose
    && (t.width < MIN_TARGET || t.height < MIN_TARGET));
}

// The page scrolls sideways, or a visible element ends past the right edge
// (body is overflow: hidden on narrow screens, so scrollWidth alone misses it).
function overflowProblems({ scrollWidth, innerWidth, elements }) {
  const problems = scrollWidth > innerWidth ? [`the page is ${scrollWidth}px wide in a ${innerWidth}px window`] : [];
  for (const e of elements) {
    if (e.visible && !e.exempt && e.right > innerWidth + 1) problems.push(`${e.label} ends at ${Math.round(e.right)}px`);
  }
  return problems;
}

async function sweep(page) {
  return smallTargets(await page.evaluate(collectTargets))
    .map((t) => `${t.label} ${Math.round(t.width)}x${Math.round(t.height)}`);
}

async function overflow(page) {
  return overflowProblems(await page.evaluate(collectOverflow, OVERFLOW_OK_INSIDE));
}

module.exports = {
  GREETING, PASS, FAIL, BLOCKED, result, firstLine, sleep, seconds, left, need, poll, pickModel, optionValues,
  openEve, waitForModels, openProject, openProjectPage, openEditProject, openTemplate, pressPreset, worldIds, acmeIds, allWorldIds, addedIds, openLauncher, captureErrors,
  thread, threadError, replyAfter, openWorldProbe, parseAgentAttempt, eveJson, callToolRows,
  DENIED_OUTCOMES, MIN_TARGET, BRIEF_REFUSED, briefRunVerdict, probeVerdict, DEVICES, smallTargets, overflowProblems, sweep, overflow,
  relayJoin, stubSources, sourcesRowProblem, firstDifference, isUnder,
};
