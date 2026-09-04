// Separate from the top-level playwright.config.js (testDir ./test/e2e) so
// `npx playwright test` for the e2e suite never picks this up, and vice
// versa. Run with the npm scripts test:visual:baseline / test:visual.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    headless: true,
    trace: 'off',
    screenshot: 'off', // we take our own explicit full-page screenshots
  },
});
