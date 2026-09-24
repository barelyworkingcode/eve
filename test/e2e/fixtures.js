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

const test = hermeticTest.extend({
  eve: async ({}, use) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-proj-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello E2E', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'console.log("e2e");', 'utf8');

    // Overrides the harness's default pinned TTS_PORT/STT_PORT (see
    // harness.js) — chat-input-row and voice-buttons assert against the real
    // speech daemons this box runs.
    const eve = await startEve({
      projects: [{ id: 'p1', name: 'E2E Project', path: projectDir }],
      env: { TTS_PORT: process.env.TTS_PORT || '9997', STT_PORT: process.env.STT_PORT || '9998' },
    });
    try {
      await use({ ...eve, projectDir });
    } finally {
      await eve.stop();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },

  page: async ({ page, eve }, use) => {
    await page.goto(eve.baseUrl);
    await use(page);
  },
});

module.exports = { test, hermeticTest, expect: base.expect };
