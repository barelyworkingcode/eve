// The passkey journeys, fixture and owner-gate. See docs/design-devboxverify.md.
// No detail here ever holds a token, credential id, key material or password.
const { expect } = require('@playwright/test');
const {
  GREETING, PASS, FAIL, BLOCKED, result, firstLine, need, poll, openEve, openProject, openWorldProbe, parseAgentAttempt,
} = require('./journey-kit');
const { enrolOwner, signIn, addAuthenticator } = require('./owner');

const LOG_WAIT_MS = 5000;
const AGENT_WAIT_MS = 20000;
const CONSUME_PATH = '/api/eve/passkey-enrolment/consume';
// The line eve must write when it refuses an enrolment outside the window.
// eve writes none today; the fix for that bug has to match this.
const ENROL_REFUSAL = /enrol{1,2}ment[^\n]*(refused|rejected|denied|closed|not open)/i;

async function passkeyFirstEnrol(env) {
  const id = 'passkey-first-enrol';
  if ((await env.api.authStatus()).enrolled) return result(id, BLOCKED, 'eve-verify already has an owner');
  env.step('enrol the owner');
  const owner = await enrolOwner(env.browser, env.url);
  env.step('check the auth status');
  const signedIn = await env.api.authStatus(owner.token);
  if (!signedIn.authenticated) return result(id, FAIL, 'the new session is not authenticated');
  const anonymous = await env.api.authStatus();
  if (anonymous.enrolled !== true || anonymous.authenticated !== false) {
    return result(id, FAIL, `without the session eve says enrolled=${anonymous.enrolled} authenticated=${anonymous.authenticated}`);
  }
  env.shared.owner = { credential: owner.credential };
  return result(id, PASS, 'Create Passkey reached Home; the session is authenticated, a stranger is not');
}

async function passkeySignIn(env) {
  const id = 'passkey-sign-in';
  const owner = env.shared.owner;
  if (!owner) return result(id, BLOCKED, 'no owner credential from passkey-first-enrol');
  env.step('sign in with the owner passkey');
  const { token, storageState } = await signIn(env.browser, env.url, owner.credential);
  env.session = { token, storageState };

  // A second page proves the session carries over, which every later journey
  // relies on. env.projects is still empty here, hence the literal name.
  const page = await env.newPage();
  await openEve(page, env);
  env.step('look for Acme Corp in the rail');
  await need('no greeting within 15s of opening eve signed in',
    expect(page.getByTestId('home-screen').getByText(GREETING)).toBeVisible({ timeout: 15000 }));
  await need('Acme Corp is not in the rail', expect(
    page.getByRole('navigation', { name: 'Projects' }).getByTitle('Acme Corp', { exact: true })).toBeVisible({ timeout: 15000 }));
  if (await page.locator('#authScreen').isVisible()) return result(id, FAIL, 'the passkey screen shows on a signed-in page');
  return result(id, PASS, 'Sign In reached Home; a new page is signed in with Acme Corp in the rail');
}

// The agent is a World probe terminal in Acme Corp typing one fixed shell
// line with no token. printf builds the EVE_NEG marker, so the echoed command
// never matches it. Returns { attempt, text, logSince }, or { blocked } / { failed }.
async function agentAttempt(env, id, gate, line) {
  const page = await env.newPage();
  await openEve(page, env);
  await openProject(page, env, env.projects.acme);
  const probe = await openWorldProbe(page, env);
  if (!probe) return { blocked: result(id, BLOCKED, 'no "World probe" card for Acme Corp') };
  const mark = await env.serviceLog.mark();
  await probe.typeLine(line);
  env.step('wait for the agent\'s answer');
  const text = await poll(async () => {
    const t = await probe.pane.innerText({ timeout: 5000 });
    return parseAgentAttempt(t, gate) ? t : null;
  }, { timeoutMs: AGENT_WAIT_MS, intervalMs: 500 });
  if (!text) return { failed: result(id, FAIL, `no EVE_NEG ${gate} line within ${AGENT_WAIT_MS / 1000}s`) };
  const attempt = parseAgentAttempt(text, gate);
  if (attempt.codes.includes(0)) return { blocked: result(id, BLOCKED, 'the agent could not reach eve-verify (000)') };
  return { attempt, text, logSince: () => env.serviceLog.since(mark) };
}

async function logHas(env, logSince, pattern) {
  env.step('read eve-verify\'s log');
  return !!(await poll(async () => pattern.test(await logSince()), { timeoutMs: LOG_WAIT_MS }));
}

const eveOrigin = (env) => `http://127.0.0.1:${new URL(env.url).port}`;

async function agentSignInRefused(env) {
  const id = 'agent-sign-in-refused';
  const o = eveOrigin(env);
  // Deliberate: the JSON content type and object shape get the forged body
  // past validateFinishBody into verifyLogin, the check being judged.
  const line = `a=$(curl -s -m 10 -o /dev/null -w '%{http_code}' ${o}/api/sessions); `
    + `b=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' `
    + `-d '{"response":{"id":"x"},"challengeId":"x"}' ${o}/api/auth/login/finish); `
    + `printf '%s_%s signin %s %s\\n' EVE NEG "$a" "$b"`;
  const r = await agentAttempt(env, id, 'signin', line);
  if (r.blocked || r.failed) return r.blocked || r.failed;
  const [a, b] = r.attempt.codes;
  if (r.attempt.codes.length !== 2) return result(id, FAIL, `unexpected answer: ${r.attempt.codes.join(' ')}`);
  if (a >= 200 && a < 300) return result(id, FAIL, `GET /api/sessions without a token answered ${a}`);
  if (b >= 200 && b < 300) return result(id, FAIL, `a forged login answered ${b}`);
  if (a !== 401 || b !== 400) return result(id, FAIL, `sessions ${a}, forged login ${b}; want 401 and 400`);
  if (!await logHas(env, r.logSince, /Login finish failed/)) {
    return result(id, FAIL, 'refused, but eve-verify\'s log has no "Login finish failed" line');
  }
  return result(id, PASS, 'sessions 401, forged login 400 and logged');
}

async function agentEnrolRefused(env) {
  const id = 'agent-enrol-refused';
  env.step('check the enrolment window is closed');
  if ((await env.api.authStatus()).enrollmentOpen !== false) return result(id, BLOCKED, 'the enrolment window is not closed');
  const line = `r=$(curl -s -m 10 -X POST -w ' %{http_code}' ${eveOrigin(env)}/api/auth/enroll/start); `
    + `printf '%s_%s enrol %s %s\\n' EVE NEG "\${r##* }" "\${r% *}"`;
  const r = await agentAttempt(env, id, 'enrol', line);
  if (r.blocked || r.failed) return r.blocked || r.failed;
  const [code] = r.attempt.codes;
  if (code >= 200 && code < 300) return result(id, FAIL, `an enrolment start outside the window answered ${code}`);
  if (code !== 403) return result(id, FAIL, `an enrolment start outside the window answered ${code}, want 403`);
  // xterm wraps the body across rows, even mid-word, so it is compared with
  // all whitespace gone.
  const flat = r.text.replace(/\s+/g, '');
  const tail = flat.slice(flat.lastIndexOf('EVE_NEGenrol'));
  if (!tail.includes('Enrollmentisnotopen')) return result(id, FAIL, '403 without "Enrollment is not open"');
  if (!await logHas(env, r.logSince, ENROL_REFUSAL)) {
    return result(id, FAIL, 'refused with 403, but eve-verify\'s log records no refusal');
  }
  return result(id, PASS, '403 "Enrollment is not open" and logged');
}

async function addBrowserInWindow(env) {
  const id = 'add-browser-in-window';
  const startedAt = Date.now();
  env.cleanup('console', env.screen.closeConsole);

  env.step('open the window with relay eve enrol');
  // This order is fixed: the helper refuses a dialog already open when it starts.
  const presence = env.screen.answerPresence({ expect: 'open a five-minute window' });
  if (!(await presence.ready)) return result(id, BLOCKED, `presence dialog ${(await presence.result).state}`);
  try {
    await env.screen.consoleRun([env.relayBin, 'eve', 'enrol']);
  } catch (err) {
    return result(id, BLOCKED, `could not run relay eve enrol: ${firstLine(err)}`);
  }
  const { state } = await presence.result;
  if (state !== 'answered') return result(id, BLOCKED, `presence dialog ${state}`);

  env.step('wait for the window to open');
  const opened = await poll(async () => (await env.api.authStatus()).enrollmentOpen === true, { timeoutMs: 10000 });
  if (!opened) return result(id, BLOCKED, 'the enrolment window did not open within 10s');

  const page = await env.newPage({ signedIn: false });
  await addAuthenticator(page);
  env.step('open eve in a new browser');
  await page.goto(env.url, { timeout: 30000 });
  await need('the "Sign In" screen did not show within 8s', expect(page.locator('#authTitle')).toHaveText('Sign In', { timeout: 8000 }));
  const add = page.locator('#authEnroll');
  await need('"Add this browser" did not show within 8s', expect(add).toBeVisible({ timeout: 8000 }));

  env.step('add this browser');
  await add.click({ timeout: 5000 });
  const home = page.getByTestId('home-screen').getByText(GREETING);
  const error = page.locator('#authError');
  await need('Add this browser showed neither Home nor an error within 15s', expect(home.or(error)).toBeVisible({ timeout: 15000 }));
  if (await error.isVisible()) return result(id, FAIL, `Add this browser failed: ${(await error.innerText()).slice(0, 120)}`);

  env.step('check the window was consumed');
  const closed = await poll(async () => (await env.api.authStatus()).enrollmentOpen === false, { timeoutMs: 5000 });
  if (!closed) return result(id, FAIL, 'the enrolment window is still open after the browser was added');
  env.step('read relay audit');
  const rows = await env.relayAudit({ path: CONSUME_PATH, sinceMs: startedAt });
  const cred = `launch:service:${env.service}`;
  if (!rows.some((row) => row.credId === cred && row.outcome === 'ok')) {
    return result(id, FAIL, `relay audit has no consume row from ${cred}`);
  }
  return result(id, PASS, 'Add this browser reached Home; the window was consumed and audited');
}

const journeys = [
  { id: 'passkey-first-enrol', timeoutMs: 45000, areas: ['auth'], fixture: true, run: passkeyFirstEnrol },
  { id: 'passkey-sign-in', timeoutMs: 45000, areas: ['auth'], fixture: true, run: passkeySignIn },
  { id: 'agent-sign-in-refused', timeoutMs: 60000, areas: ['auth', 'terminal'], run: agentSignInRefused },
  { id: 'agent-enrol-refused', timeoutMs: 60000, areas: ['auth', 'terminal'], run: agentEnrolRefused },
  { id: 'add-browser-in-window', timeoutMs: 90000, areas: ['auth'], screen: true, run: addBrowserInWindow },
];

module.exports = { journeys };
