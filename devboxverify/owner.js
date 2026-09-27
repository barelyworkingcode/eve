'use strict';
// The sign-in fixture: the real passkey ceremonies, run by a CDP virtual
// authenticator in Chromium. Nothing here intercepts a request or seeds a
// session. The token and credential stay in memory: never logged, written to
// disk or put in an error message.
const { expect } = require('@playwright/test');
const { need } = require('./journey-kit');

const VIEWPORT = { width: 1280, height: 800 };
const SCREEN_MS = 20000;
const APP_MS = 15000;

async function addAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

// Only the session token is carried over, so a signed-in context starts as
// fresh as any other.
function sessionState(url, token) {
  return { cookies: [], origins: [{ origin: new URL(url).origin, localStorage: [{ name: 'eve_session', value: token }] }] };
}

async function authScreen(page, url, title) {
  await page.goto(url, { timeout: 30000 });
  await need(`the "${title}" screen did not show within ${SCREEN_MS / 1000}s`,
    expect(page.locator('#authTitle')).toHaveText(title, { timeout: SCREEN_MS }));
  await need('the passkey screen is not visible', expect(page.locator('#authScreen')).toBeVisible({ timeout: 5000 }));
}

// Signed in means the passkey screen is gone and the rail shows, not Home:
// terminals a previous journey or run left open take the pane until a sweep.
// Throws with the ceremony's error text when eve shows one.
async function awaitSignedIn(page, what) {
  const auth = page.locator('#authScreen');
  const rail = page.getByRole('navigation', { name: 'Projects' });
  const error = page.locator('#authError');
  await need(`${what} showed neither the app nor an error within ${APP_MS / 1000}s`,
    expect(async () => {
      if (await error.isVisible()) return;
      if (!(await auth.isVisible()) && await rail.isVisible()) return;
      throw new Error('still on the passkey screen');
    }).toPass({ timeout: APP_MS }));
  if (await error.isVisible()) throw new Error(`${what} failed: ${(await error.innerText()).slice(0, 120)}`);
  const token = await page.evaluate(() => localStorage.getItem('eve_session'));
  if (!token) throw new Error(`${what} reached the app but stored no session`);
  return token;
}

async function ceremony(page, what) {
  await page.locator('#authAction').click({ timeout: 5000 });
  return awaitSignedIn(page, what);
}

async function withPage(browser, fn) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  try {
    return await fn(await context.newPage());
  } finally {
    await context.close().catch(() => {});
  }
}

async function enrolOwner(browser, url) {
  return withPage(browser, async (page) => {
    const { cdp, authenticatorId } = await addAuthenticator(page);
    await authScreen(page, url, 'Set Up Passkey');
    const token = await ceremony(page, 'Create Passkey');
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    if (credentials.length !== 1) throw new Error(`the authenticator holds ${credentials.length} credentials after enrolment, want 1`);
    return { credential: credentials[0], token, storageState: sessionState(url, token) };
  });
}

async function signIn(browser, url, credential) {
  return withPage(browser, async (page) => {
    const { cdp, authenticatorId } = await addAuthenticator(page);
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential });
    await authScreen(page, url, 'Sign In');
    const token = await ceremony(page, 'Sign In');
    return { token, storageState: sessionState(url, token) };
  });
}

module.exports = { enrolOwner, signIn, addAuthenticator, awaitSignedIn, sessionState };
