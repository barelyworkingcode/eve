'use strict';

// The one import a spec needs. Per test: its own fakerelay, eve, relayScheduler,
// fake TTS and STT, data directories and browser context. See docs/test.md.

const base = require('@playwright/test');
const { devices } = base;
const { Stack } = require('./stack');
const worlds = require('./worlds');

// `defaultBrowserType` can't be set inside a describe, and the one project is Chromium anyway.
function profile(name) {
  const copy = { ...devices[name] };
  delete copy.defaultBrowserType;
  return copy;
}
const profiles = { phone: profile('Pixel 7'), tablet: profile('Galaxy Tab S4') };

const AUTHENTICATOR_OPTIONS = {
  protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
  isUserVerified: true, automaticPresenceSimulation: true,
};

function passkeyFor(page, context) {
  let cdp = null;
  let authenticatorId = null;
  const need = () => {
    if (!cdp) throw new Error('passkey.enable() has not been called in this test');
    return cdp;
  };
  return {
    // Chromium's virtual authenticator: ctap2, internal, resident key, user verification.
    async enable() {
      cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const res = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR_OPTIONS });
      authenticatorId = res.authenticatorId;
    },
    // A fresh, empty authenticator with the same options (presence and verification back on).
    // Returns the old one's credentials, so a row can show a second browser is not the first.
    async replace() {
      const old = await this.credentials();
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      const res = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR_OPTIONS });
      authenticatorId = res.authenticatorId;
      return old;
    },
    async credentials() {
      const res = await need().send('WebAuthn.getCredentials', { authenticatorId });
      return res.credentials.map((c) => ({ credentialId: c.credentialId, rpId: c.rpId }));
    },
    // false: the next ceremony gets neither presence nor user verification.
    async setPresence(ok) {
      await need().send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: ok });
      await need().send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: ok });
    },
  };
}

const test = base.test.extend({
  world: [worlds.base(), { option: true }],
  network: ['trusted', { option: true }],
  scheduler: [true, { option: true }],

  // The running stack. Not for specs: they use eve, relay, passkey and voice.
  stack: async ({ world, network, scheduler }, use, testInfo) => {
    const stack = new Stack({
      fakerelay: process.env.EVE_E2E_FAKERELAY,
      relayscheduler: process.env.EVE_E2E_RELAYSCHEDULER,
      world, network, scheduler,
    });
    let setupError = null;
    try {
      if (!stack.bins.fakerelay || !stack.bins.relayscheduler) {
        throw new Error('EVE_E2E_FAKERELAY / EVE_E2E_RELAYSCHEDULER are not set; run through `npx playwright test` (global setup builds them)');
      }
      await stack.start();
      await use(stack);
    } catch (err) {
      setupError = err;
      throw err;
    } finally {
      try {
        await stack.stop();
        if (setupError || testInfo.status !== testInfo.expectedStatus) {
          for (const [name, file] of stack.logFiles()) await testInfo.attach(name, { path: file });
          if (stack.overrun) await testInfo.attach('teardown-overrun', { body: stack.overrun });
        }
      } finally {
        stack.remove();
      }
    }
  },

  eve: async ({ stack, page, context, network }, use) => {
    const ready = () => page.locator('html[data-ready="1"]').waitFor({ state: 'attached' });
    const toReady = async (action, opts) => {
      if (opts && opts.weakConnection) {
        // The first fetch of one core script fails; later loads (the person's Reload) succeed.
        await page.route((u) => u.pathname === '/app.js', (route) => route.abort('internetdisconnected'), { times: 1 });
        await action('domcontentloaded');
        return;
      }
      if (opts && 'preReady' in opts && !(typeof opts.preReady === 'string' && opts.preReady.trim())) {
        throw new Error('preReady needs a non-empty reason');
      }
      await action(opts && opts.preReady ? 'domcontentloaded' : 'load');
      if (!(opts && opts.preReady)) await ready();
    };
    await use({
      url: stack.url,
      // Resolves once the app is ready, the signal eve.open waits on. For a row that signs in after opening with preReady.
      ready,
      open: (urlPath = '/', opts) => toReady((waitUntil) => page.goto(stack.url + urlPath, { waitUntil }), opts),
      reload: (opts) => toReady((waitUntil) => page.reload({ waitUntil }), opts),
      // Clears this page's site data, as a person would. The token stays valid in eve and the
      // authenticator keeps its credentials. Returns with the Sign-in screen loading.
      async signOut() {
        if (network === 'trusted') throw new Error("signOut needs network: 'untrusted'");
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.reload({ waitUntil: 'domcontentloaded' });
      },
      setOffline: (offline) => context.setOffline(offline),
    });
  },

  relay: async ({ stack }, use) => {
    await use({
      dir: stack.relayDir,
      cli: (...argv) => stack.cli(...argv),
      json: (...argv) => stack.json(...argv),
      ctl: (...argv) => stack.ctl(...argv),
      mark: () => new Date().toISOString(),
      logs: (opts) => stack.logs(opts),
      waitForEvent: (event, opts) => stack.waitForEvent(event, opts),
    });
  },

  passkey: async ({ page, context }, use) => {
    await use(passkeyFor(page, context));
  },

  voice: async ({ stack }, use) => {
    await use(stack.voice);
  },
});

module.exports = { test, expect: base.expect, profiles };
