// Same harness as the integration tests: a real spawned eve + fake relay,
// loopback (trusted -> no passkey). Each test gets its own eve via the `eve`
// fixture, so keep it serial.
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  // Voice tests need the live daemons and are slow; run via `npm run test:voice`.
  testIgnore: /voice\.spec\.js$/,
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [['list']],
  use: {
    headless: true,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
