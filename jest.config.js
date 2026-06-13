module.exports = {
  testMatch: ['<rootDir>/test/unit/**/*.test.js'],
  testEnvironment: 'node',
  // Restores real timer globals after every test — works around a Jest 30 +
  // Node 26 bug where useRealTimers() leaves setTimeout/clearTimeout undefined.
  // See test/setup.js.
  setupFilesAfterEnv: ['<rootDir>/test/setup.js']
};
