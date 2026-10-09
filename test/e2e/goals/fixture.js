// Goal specs drive the real Eve in Chromium against the relay fake, one spec per
// user goal in docs/FEATURES.md. Each asserts what a person sees today, so a
// change that alters a goal fails a spec named after it.
//
//   test.use({ world: { projects: [...], seed: (eve) => {...} } })
//
// `seed` runs against the fake relay (and its in-memory file plane, `relay.files`)
// before the page opens, so restored state is there on first load. The project
// folders are neutral paths that exist nowhere: eve reaches files only through
// the fake relay, which holds FILES for alpha and BETA_FILES for beta.
// A seed that needs something torn down afterwards (a real temp repo for git)
// returns { cleanup }.
const base = require('@playwright/test');
const { startEve } = require('../../integration/harness');
const { hermeticTest, gotoEve } = require('../fixtures');

const FILES = {
  'README.md': '# Alpha\n\nhello from alpha\n',
  'notes.txt': 'first line\n',
  'src/app.js': 'console.log("alpha");\n',
};

const BETA_FILES = { 'BETA.md': '# Beta\n' };

const test = hermeticTest.extend({
  world: [{}, { option: true }],
  eveEnv: [{}, { option: true }],
  eve: async ({ world, eveEnv }, use) => {
    const alpha = '/work/alpha';
    const beta = '/work/beta';
    // `world.projects` may be a function of the fixture folders, for specs whose
    // projects need real files (e.g. a project with a mode and a README).
    const defs = (typeof world.projects === 'function' ? world.projects({ alpha, beta }) : world.projects) || [
      { id: 'alpha', name: 'Alpha Project', path: alpha },
      { id: 'beta', name: 'Beta Project', path: beta },
    ];
    // The fake relay holds each fixture folder's files; a project is matched by its path.
    const files = {};
    for (const def of defs) {
      if (def.path === alpha) files[def.id] = FILES;
      else if (def.path === beta) files[def.id] = BETA_FILES;
    }
    const eve = await startEve({ projects: defs, hosts: world.hosts || [], files, models: world.models, env: eveEnv });
    const folders = { alpha, beta };
    let cleanup = null;
    try {
      const seeded = world.seed ? await world.seed({ ...eve, folders }) : null;
      cleanup = seeded && typeof seeded.cleanup === 'function' ? seeded.cleanup : null;
      await use({ ...eve, folders });
    } finally {
      await eve.stop();
      if (cleanup) await cleanup();
    }
  },
  page: async ({ page, eve }, use) => {
    await gotoEve(page, eve.baseUrl);
    await use(page);
  },
});

const MODELS = { models: [{ value: 'fake-model', label: 'Fake Model', provider: 'claude', supportsPermissions: true, supportsAttachments: true }], providerSettings: {} };

module.exports = { test, expect: base.expect, MODELS, FILES };
