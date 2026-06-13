module.exports = {
  testMatch: ['<rootDir>/test/unit/**/*.test.js'],
  testEnvironment: 'node',
  // Restores real timer globals after every test — works around a Jest 30 +
  // Node 26 bug where useRealTimers() leaves setTimeout/clearTimeout undefined.
  // See test/setup.js.
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],
  // Without this, coverage is computed ONLY over files a test happens to
  // require() — so a file with zero tests is invisible rather than counted as
  // 0%, which silently inflates the headline number. Enumerate the server-side
  // surface explicitly so untested modules (ws-handler, relay-client, server,
  // routes, …) show up honestly. `public/**` (browser JS, run in the real DOM,
  // not under jest's node env) is intentionally out of scope here.
  collectCoverageFrom: [
    '*.js',
    'routes/**/*.js',
    'mcp/**/*.js',
    '!jest.config.js'
  ]
};
