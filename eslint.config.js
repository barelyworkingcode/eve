'use strict';

// Scoped to test/e2e on purpose; nothing runs it until the new suite's harness
// adds the static-guard rules here.
const playwright = require('eslint-plugin-playwright');

module.exports = [
  {
    files: ['test/e2e/**/*.{js,mjs,cjs}'],
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
  { files: ['test/e2e/**/*.mjs'], languageOptions: { sourceType: 'module' } },
];
