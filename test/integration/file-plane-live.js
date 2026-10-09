#!/usr/bin/env node
/**
 * Runs the file-plane conformance table against a real relay: one jest spec,
 * test/integration/file-plane-live.spec-live.js, which no jest config collects.
 * Console project only; host projects wait on relay#275.
 *
 * How it reaches the routes. Every file route is execute-class and lives on
 * relay's frontend socket only. Eve's own access is a launch identity, which a
 * test process cannot hold. The legitimate door is a control-plane credential
 * (docs/tokens.md in relay), minted at the console, where a presence prompt asks
 * the person there to approve it:
 *
 *   relay credential mint --name eve-files-live --class read --class configure --class execute --ttl 1h
 *   EVE_RELAY_FRONTEND_SOCKET=<relay config dir>/frontend.sock \
 *     EVE_RELAY_FILES_TOKEN=<printed token> node test/integration/file-plane-live.js
 *
 * The spec registers its own project over POST /api/projects on a temp folder
 * (relay raises a presence prompt for that too, so run it with someone at the
 * console), and removes the project afterwards. Revoke the credential with
 * `relay credential revoke --id <id>`. Nothing in relay's config or gates is
 * changed. `delete` moves the test files into the Trash.
 *
 * Exit code is jest's: non-zero on any failure, including missing environment.
 */
const path = require('path');
const { runCLI } = require('jest');

const root = path.resolve(__dirname, '..', '..');
const base = require(path.join(root, 'jest.integration.config.js'));

runCLI(
  {
    config: JSON.stringify({
      ...base,
      rootDir: root,
      testMatch: ['<rootDir>/test/integration/file-plane-live.spec-live.js'],
      testTimeout: 180000,
    }),
    runInBand: true,
    _: [],
    $0: 'file-plane-live',
  },
  [root],
).then(({ results }) => {
  process.exit(results.success && results.numTotalTests > 0 ? 0 : 1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
