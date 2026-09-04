// Voice tests run against the real speech daemons and take ~3s per
// transcription, so they get their own config, kept out of the fast e2e
// suite (see testIgnore in ../../playwright.config.js).
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: /voice\.spec\.js$/,
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 45000 },
  reporter: [['list']],
  use: { headless: true, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
