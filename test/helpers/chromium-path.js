'use strict';

// Playwright pins a browser revision per @playwright/test version. Hosts that
// ship their own Chromium (the Claude cloud image, distro packages) set
// EVE_CHROMIUM_PATH, or expose an unversioned `chromium` binary under
// PLAYWRIGHT_BROWSERS_PATH (Playwright's own installs are always versioned
// directories, so a file there is never ours to shadow).
const fs = require('fs');
const path = require('path');

function chromiumExecutable(env = process.env) {
  if (env.EVE_CHROMIUM_PATH) return env.EVE_CHROMIUM_PATH;
  if (env.PLAYWRIGHT_BROWSERS_PATH) {
    const candidate = path.join(env.PLAYWRIGHT_BROWSERS_PATH, 'chromium');
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch { /* absent: use Playwright's pinned browser */ }
  }
  return undefined;
}

function chromiumLaunchOptions(env = process.env) {
  const executablePath = chromiumExecutable(env);
  return executablePath ? { executablePath } : {};
}

module.exports = { chromiumExecutable, chromiumLaunchOptions };
