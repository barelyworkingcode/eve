// Loopback is trusted, so the app loads straight into the workspace with no passkey.
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../integration/harness');

const test = base.test.extend({
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

// Kept separate from the default fixture: the default `eve` is also what
// test/visual/capture.spec.js screenshots, and the extra modules/ row here
// would fail every one of its baselines for a reason unrelated to
// tab-manager.js. Used only by test/e2e/tab-panes.spec.js.
const testWithModule = base.test.extend({
  eve: async ({}, use) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-proj-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello E2E', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'console.log("e2e");', 'utf8');
    fs.mkdirSync(path.join(projectDir, 'modules', 'demo-module'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'modules', 'demo-module', 'module.json'),
      JSON.stringify({ displayName: 'Demo Module', entry: 'index.html' }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(projectDir, 'modules', 'demo-module', 'index.html'),
      '<!doctype html><html><body>demo module</body></html>',
      'utf8'
    );

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

module.exports = { test, expect: base.expect, testWithModule };
