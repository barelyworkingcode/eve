'use strict';

// Fakerelay worlds (schema 1, relay's docs/fakerelay.md "World spec") for specs
// to start from. Each call returns a fresh object, so a spec can edit its copy.
// Artifacts are public: neutral names only.

function base() {
  return {
    schema: 1,
    projects: [
      { id: 'p_acme', name: 'Acme', mode: 'work', files: { 'README.md': '# Acme\n' } },
    ],
    default_project: { work: 'p_acme' },
  };
}

module.exports = { base };
