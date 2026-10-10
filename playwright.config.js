'use strict';

const { defineConfig, devices } = require('@playwright/test');

// One project, Chromium: the virtual authenticator is CDP, and real Safari and
// the iOS app stay with devbox world. Phone and tablet are profiles a spec opts
// into. `retries: 0` on purpose: a retry would hide a flake; the trace is kept.
module.exports = defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.js',
  fullyParallel: true,
  workers: process.env.CI ? 4 : '50%',
  retries: 0,
  forbidOnly: !!process.env.CI,
  // Bounds, not waits.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalSetup: './test/e2e/support/global-setup.js',
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
    permissions: ['microphone'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [{ name: 'chromium' }],
});
