// Loopback is trusted, so the app loads straight into the workspace with no passkey.
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
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

// `load` can fire before auth status resolves, and only then does initApp()
// build client.state, wsClient and the dialogs.
async function gotoEve(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => !!window.client?.state && !!window.client?.wsClient);
}

const test = hermeticTest.extend({
  // Extra env for the spawned eve. Specs that need the real speech daemons
  // (voice.spec.js) point TTS_PORT/STT_PORT at them; everything else keeps
  // the harness's free, daemon-less ports.
  eveEnv: [{}, { option: true }],
  eve: async ({ eveEnv }, use) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-proj-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello E2E', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'console.log("e2e");', 'utf8');

    const eve = await startEve({
      projects: [{ id: 'p1', name: 'E2E Project', path: projectDir }],
      env: eveEnv,
    });
    try {
      await use({ ...eve, projectDir });
    } finally {
      await eve.stop();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },

  page: async ({ page, eve }, use) => {
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

module.exports = { test, hermeticTest, gotoEve, expect: base.expect };
