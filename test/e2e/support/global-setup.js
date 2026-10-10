'use strict';

// Runs once per `playwright test`: builds the pinned fakes, hands their paths
// to the workers through the environment, and takes the machine-wide browser
// lock so this suite and devbox world never overlap. `--list` skips global
// setup, so the coverage check never builds or locks.

const { buildFakes } = require('./build-fakes');
const { acquire } = require('../../../scripts/browser-lock');

module.exports = async function globalSetup() {
  const fakes = await buildFakes();
  process.env.EVE_E2E_FAKERELAY = fakes.fakerelay;
  process.env.EVE_E2E_RELAYSCHEDULER = fakes.relayscheduler;

  // CI runners are not shared, so there is nothing to serialise against.
  let release = null;
  if (!process.env.CI) release = await acquire({ command: 'playwright test (eve e2e)' });

  return async () => {
    if (release) await release();
  };
};
