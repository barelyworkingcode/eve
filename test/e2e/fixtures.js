/**
 * Playwright fixtures: each test gets a freshly spawned eve + fake relay (reusing
 * the integration harness) seeded with one project on a real temp dir, plus the
 * Playwright `page` already navigated to it. Loopback is trusted, so the app
 * loads straight into the workspace with no passkey.
 */
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../integration/harness');

const test = base.test.extend({
  // The spawned eve + fake relay, with a seeded project at a real temp dir.
  eve: async ({}, use) => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-e2e-proj-'));
    fs.mkdirSync(path.join(projectDir, 'src'));
    fs.writeFileSync(path.join(projectDir, 'README.md'), '# Hello E2E', 'utf8');
    fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'console.log("e2e");', 'utf8');

    const eve = await startEve({ projects: [{ id: 'p1', name: 'E2E Project', path: projectDir }] });
    try {
      await use({ ...eve, projectDir });
    } finally {
      await eve.stop();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  },

  // The page, pre-navigated to the running eve.
  page: async ({ page, eve }, use) => {
    await page.goto(eve.baseUrl);
    await use(page);
  },
});

// A second variant, identical to the one above except the project directory
// also has a real modules/<name>/module.json (§G.3 of the tab-manager-registry
// spec: "so module panes can be exercised"). Kept as its own `eve`/`page` pair
// rather than folded into the default fixture above: the extra `modules/`
// directory is a new row in the project's file tree, and the default `eve`
// fixture is also what test/visual/capture.spec.js screenshots — an extra row
// there would fail every one of its 24 baselines for a reason that has
// nothing to do with tab-manager.js. Used only by test/e2e/tab-panes.spec.js.
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

    const eve = await startEve({ projects: [{ id: 'p1', name: 'E2E Project', path: projectDir }] });
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
