// Shared helpers for the devbox journeys: waits, readiness gates, and the
// small readers the verdicts rest on. See docs/design-devboxverify.md.
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

async function worldIds(env, projects, kind) {
  const snap = await env.api.snapshot(projects);
  return snap[kind].filter((i) => i.world).map((i) => i.id);
}

const acmeIds = (env, kind) => worldIds(env, [env.world.projects.acme], kind);
// Deliberate: an explicit list, never the view's own keys, so a missing
// declaration blocks the journey instead of quietly narrowing the check.
const allWorldIds = (env, kind) => worldIds(env, ['acme', 'globex', 'home'].map((k) => env.world.projects[k]), kind);

const addedIds = (before, after) => after.filter((id) => !before.includes(id));

async function openLauncher(page, env) {
  env.step('open the session launcher');
  await page.getByTestId(`sidebar-new-session-${env.world.projects.acme.id}`).click({ timeout: 10000 });
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

// Opens a "World probe" terminal in Acme Corp from the launcher. Null when
// Acme Corp offers no such card; throws when the card opens no terminal.
async function openWorldProbe(page, env) {
  const acme = env.world.projects.acme;
  const before = await acmeIds(env, 'terminals');
  const dialog = await openLauncher(page, env);
  env.step('look for the World probe card');
  const card = dialog.getByRole('button', { name: /World probe/ });
  const loading = dialog.getByText('Loading terminal templates…');
  await need('terminal templates never loaded', expect(loading).toHaveCount(0, { timeout: 15000 }));
  if (await card.count() === 0) return null;
  await card.first().click({ timeout: 5000 });

  env.step('wait for the terminal');
  const mine = await poll(async () => {
    const added = addedIds(before, await acmeIds(env, 'terminals'));
    return added.length ? added : null;
  }, { timeoutMs: 20000, intervalMs: 1000 });
  if (!mine) throw new Error(`no ${acme.name} terminal within 20s of World probe`);
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
  openEve, waitForModels, openProject, worldIds, acmeIds, allWorldIds, addedIds, openLauncher, captureErrors,
  thread, threadError, replyAfter, openWorldProbe, parseAgentAttempt,
  DEVICES, smallTargets, overflowProblems, sweep, overflow,
};
