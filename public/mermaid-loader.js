/**
 * Lazy loader for mermaid. The UMD bundle is ~3.2 MB and only needed when a
 * message contains a mermaid code block, so it is imported on demand instead
 * of blocking every page load. Same shape as voice-orb-3d.js's three.js
 * loader: a module-level promise so the module loads exactly once, no matter
 * how many messages render concurrently.
 *
 * Uses mermaid.esm.min.mjs, not the package's `module` entry
 * (mermaid.core.mjs): the core build leaves bare specifiers (d3, ts-dedent,
 * ...) that a browser can't resolve without a bundler. The esm.min build is
 * self-contained and code-splits into dist/chunks/mermaid.esm.min/.
 */

let _mermaidPromise = null;

function loadMermaid() {
  if (!_mermaidPromise) {
    _mermaidPromise = import('/mermaid/mermaid.esm.min.mjs')
      .then((mod) => {
        // Moved from app.js's initApp(): must run before the first
        // mermaid.run(), exactly once.
        mod.default.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
        });
        return mod.default;
      })
      .catch((err) => {
        // A failed load (offline, 404) must not poison later messages:
        // drop the cached rejection so the next diagram can retry.
        _mermaidPromise = null;
        throw err;
      });
  }
  return _mermaidPromise;
}

window.loadMermaid = loadMermaid;
