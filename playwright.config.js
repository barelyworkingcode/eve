// Same harness as the integration tests: a real spawned eve + fake relay,
// loopback (trusted -> no passkey). Each test gets its own eve, fake relay,
// OS-assigned ports and temp data dir via the `eve` fixture, so workers share
// no state and tests run in parallel across files. The count is bounded by CPU
// (8 workers on 8 CPUs timed out specs that pass at 4); override with --workers=N.
const { defineConfig, devices } = require('@playwright/test');
const { chromiumLaunchOptions } = require('./test/helpers/chromium-path');

module.exports = defineConfig({
  testDir: './test/e2e',
  // Voice tests need the live daemons and are slow; run via `npm run test:voice`.
  testIgnore: /voice\.spec\.js$/,
  fullyParallel: false,
  workers: 4,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    headless: true,
    launchOptions: chromiumLaunchOptions(),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
