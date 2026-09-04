// Not hermetic in the unit sense (spawns processes, binds ports) — stays out
// of the pre-commit unit gate. Run with `npm run test:integration`.
module.exports = {
  testMatch: ['<rootDir>/test/integration/**/*.test.js'],
  testEnvironment: 'node',
  testTimeout: 30000,
  // Each test spins up its own eve + fake relay; parallel workers would
  // multiply spawned node processes for little gain.
  maxWorkers: 1,
};
