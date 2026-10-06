'use strict';

// Scoped to the e2e specs on purpose: scripts/lint-added-waits.js uses it as a
// CI gate that refuses a newly added fixed wait. No other rules belong here.
const playwright = require('eslint-plugin-playwright');

module.exports = [
  {
    files: ['test/e2e/**/*.js'],
    plugins: { playwright },
    // An added `eslint-disable` comment must not be able to switch the gate off.
    linterOptions: { noInlineConfig: true },
    rules: {
      'playwright/no-wait-for-timeout': 'error',
      // The plugin only names `page`-like receivers; this catches any receiver.
      'no-restricted-properties': ['error', {
        property: 'waitForTimeout',
        message: 'Wait on a signal (data-ready, an event, an expect), not a duration.',
      }],
    },
  },
];
