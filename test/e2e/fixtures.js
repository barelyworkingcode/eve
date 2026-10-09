// Loopback is trusted, so the app loads straight into the workspace with no passkey.
const base = require('@playwright/test');
const path = require('path');
const { startEve } = require('../integration/harness');

// Specs with their own eve fixture extend this rather than base.test, so they
// get the device-free AudioContext too (see hermetic-audio.js).
const hermeticTest = base.test.extend({
  context: async ({ context }, use) => {
    await context.addInitScript({ path: path.join(__dirname, 'hermetic-audio.js') });
    await use(context);
  },
});

// `load` can fire before auth status resolves and well before the first boot
// has loaded projects and sessions. app.js sets data-ready on <html> once the
// first socket is ready, projects and sessions are loaded (or failed), the
// tab restore was requested, the initial hash was handled. Models, joins, file reads and tasks are not
// part of it: wait on those by their own signal.
const waitForReady = (page) => page.waitForFunction(() => document.documentElement.dataset.ready === '1');

async function gotoEve(page, url) {
  await page.goto(url);
  await waitForReady(page);
}

async function reloadEve(page) {
  await page.reload();
  await waitForReady(page);
}

const test = hermeticTest.extend({
  // Extra env for the spawned eve. Specs that need the real speech daemons
  // (voice.spec.js) point TTS_PORT/STT_PORT at them; everything else keeps
  // the harness's free, daemon-less ports.
  eveEnv: [{}, { option: true }],
  eve: async ({ eveEnv }, use) => {
    // A neutral path that exists nowhere: eve reaches the project's files only
    // through the fake relay, which holds this tree in memory (`eve.relay.files`).
    const projectDir = '/work/e2e';

    const eve = await startEve({
      projects: [{ id: 'p1', name: 'E2E Project', path: projectDir }],
      files: { p1: { 'README.md': '# Hello E2E', 'src/index.js': 'console.log("e2e");' } },
      env: eveEnv,
    });
    try {
      await use({ ...eve, projectDir });
    } finally {
      await eve.stop();
    }
  },

  page: async ({ page, eve }, use) => {
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

module.exports = { test, hermeticTest, gotoEve, reloadEve, expect: base.expect };
