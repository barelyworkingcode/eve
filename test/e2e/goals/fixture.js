// Goal specs drive the real Eve in Chromium against the relay fake, one spec per
// user goal in docs/FEATURES.md. Each asserts what a person sees today, so a
// change that alters a goal fails a spec named after it.
//
//   test.use({ world: { projects: [...], seed: (eve) => {...} } })
//
// `seed` runs against the fake relay (and the project folders) before the page
// opens, so restored state is there on first load.
const base = require('@playwright/test');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('../../integration/harness');
const { hermeticTest, gotoEve } = require('../fixtures');

const FILES = {
  'README.md': '# Alpha\n\nhello from alpha\n',
  'notes.txt': 'first line\n',
  'src/app.js': 'console.log("alpha");\n',
};

function makeFolder(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eve-goal-')));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

const test = hermeticTest.extend({
  world: [{}, { option: true }],
  eveEnv: [{}, { option: true }],
  eve: async ({ world, eveEnv }, use) => {
    const alpha = makeFolder(FILES);
    const beta = makeFolder({ 'BETA.md': '# Beta\n' });
    const defs = world.projects || [
      { id: 'alpha', name: 'Alpha Project', path: alpha },
      { id: 'beta', name: 'Beta Project', path: beta },
    ];
    const eve = await startEve({ projects: defs, hosts: world.hosts || [], models: world.models, env: eveEnv });
    const folders = { alpha, beta };
    try {
      if (world.seed) await world.seed({ ...eve, folders });
      await use({ ...eve, folders });
    } finally {
      await eve.stop();
      for (const dir of [alpha, beta]) fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  page: async ({ page, eve }, use) => {
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

const MODELS = { models: [{ value: 'fake-model', label: 'Fake Model', provider: 'claude', supportsPermissions: true, supportsAttachments: true }], providerSettings: {} };

module.exports = { test, expect: base.expect, MODELS, FILES };
