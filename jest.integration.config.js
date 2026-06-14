// Integration tests boot the real `node server.js` as a child process against
// the fake relay (test/integration/harness.js). They are NOT hermetic in the
// unit sense (they spawn processes and bind ports), so they live under a
// separate config and stay OUT of the pre-commit unit gate. Run with
// `npm run test:integration`.
module.exports = {
  testMatch: ['<rootDir>/test/integration/**/*.test.js'],
  testEnvironment: 'node',
  testTimeout: 30000,
  // Run serially: each test spins up its own eve + fake relay; parallel workers
  // would multiply spawned node processes for little gain.
  maxWorkers: 1,
};
