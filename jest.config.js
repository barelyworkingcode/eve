module.exports = {
  testMatch: ['<rootDir>/test/unit/**/*.test.js'],
  testEnvironment: 'node',
  // Works around a Jest 30 + Node 26 bug where useRealTimers() leaves
  // setTimeout/clearTimeout undefined. See test/setup.js.
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  // Without this, coverage is computed only over files a test require()s, so
  // an untested file is invisible rather than counted as 0% — silently
  // inflating the headline number. `public/**` (browser JS, real-DOM) is
  // intentionally out of scope here.
  collectCoverageFrom: [
    '*.js',
    'routes/**/*.js',
    'mcp/**/*.js',
    '!jest.config.js'
  ]
};
