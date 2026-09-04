/**
 * Shared constants + helpers for the visual-regression harness.
 *
 * IMPORTANT — index.html is cached: `server.js` reads public/index.html into
 * memory ONCE at process startup (see CLAUDE.md, "Local server restart"). The
 * `eve` fixture (test/e2e/fixtures.js -> test/integration/harness.js) spawns a
 * brand-new `node server.js` child per test, so it always serves the current
 * index.html on disk — no manual restart needed to run this harness. But if
 * you point this harness at an already-running eve instance instead of the
 * fixture (e.g. the pid mentioned in the task, started before an index.html
 * edit), you MUST restart that instance first or you'll be screenshotting
 * stale markup against fresh JS/CSS.
 */
const path = require('path');

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile', width: 390, height: 844 },
];

const THEMES = ['dark', 'light'];

const BASELINE_DIR = path.join(__dirname, '__baseline__');
const CURRENT_DIR = path.join(__dirname, '__current__');
const DIFF_DIR = path.join(__dirname, '__diff__');

// Forces every animation/transition to its end state instantly, and hides
// caret/cursor blink. Applied after each navigation so results depend only on
// final layout, never on where a CSS clock happened to be when we clicked
// the shutter. A screenshot harness that reports false diffs from animation
// timing is worse than no harness — this is the load-bearing line of defense.
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
  }
  input, textarea, [contenteditable] { caret-color: transparent !important; }
  .monaco-editor .cursors-layer .cursor { visibility: hidden !important; }
  .monaco-editor .blinking-cursor { visibility: hidden !important; }
  /* Monaco's automaticLayout does a ResizeObserver-driven re-measure after
   * mount; on a single-line file its vertical scrollbar sits right at the
   * "needed or not" threshold, and rendered on or off between two otherwise
   * pixel-identical runs of the same page (observed on mobile/light — 1
   * line of content should never need one regardless). visibility, not
   * display, so it can't perturb the width Monaco already laid out around.
   */
  .monaco-editor .scrollbar.vertical,
  .monaco-editor .scrollbar.horizontal { visibility: hidden !important; }
  /* Same threshold effect, different element: the overview-ruler canvas
   * (search/error markers strip, right edge) redraws via a ResizeObserver
   * callback whose exact backing-store width can round to a 1px sliver on
   * or off between runs even with zero decorations to draw. */
  .monaco-editor .decorationsOverviewRuler { visibility: hidden !important; }

  /* Genuinely nondeterministic, and irrelevant to the CSS this harness exists
   * to protect: this environment has no local Kokoro/Whisper daemon, so voice
   * init reports failure. Any resulting toast or system message is timing
   * dependent, not markup dependent — hide it rather than let it flip the
   * chat surface's diff between 0% and not.
   */
  .toast-container { display: none !important; }
  [data-testid="message-system"] { display: none !important; }
`;

// A plausible Kokoro voice list, shaped like tts-native-backend.js's
// KOKORO_VOICES fallback constant.
const STUB_TTS_VOICES = [
  { id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'F' },
  { id: 'am_adam', name: 'Adam', lang: 'American English', gender: 'M' },
];

/**
 * Pin the voice-daemon probes so a capture does not depend on whether the
 * Kokoro/Whisper daemons happen to be running on the host.
 *
 * Both are eve's own endpoints (server.js -> tts-service.js / stt-service.js,
 * NOT the fake relay). TTSManager.init() and STTManager.checkAvailability()
 * call them at app boot, and their answers are load-bearing for the rendered
 * page: `/api/stt/status` decides whether the mic button is visible at all.
 * Left unstubbed, the same commit screenshots differently depending on daemon
 * state — which is exactly what happened: a baseline captured while the
 * daemons were down showed no mic button, and every later run flagged a
 * false regression once they came back up.
 *
 * Stubbed to the daemons-up answer, because that is the normal state.
 * The daemons-down path is covered by test/e2e/voice.spec.js, which asserts
 * the mic button hides when /api/stt/status reports unavailable.
 */
async function stubVoiceDaemons(context) {
  await context.route('**/api/tts/voices', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(STUB_TTS_VOICES),
  }));
  await context.route('**/api/stt/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ available: true }),
  }));
}

/**
 * Seeds localStorage with an explicit theme before any app script runs, so
 * both the pre-paint inline bootstrap in index.html AND SettingsManager
 * resolve to the same mode. `palettes: {}` is intentional — SettingsManager's
 * loader treats any object with a `palettes` key (even empty) as "current
 * shape" and fills in both palettes from THEME_PRESETS defaults, which keeps
 * this test file from having to duplicate eve's palette color constants.
 */
async function seedTheme(context, theme) {
  await context.addInitScript((mode) => {
    localStorage.setItem('eve-settings', JSON.stringify({ themeMode: mode, palettes: {} }));
  }, theme);
}

/**
 * The whole `.sidebar` (project rail + explorer panel) goes off-canvas under
 * 768px width (styles.css `.sidebar { transform: translateX(-100%) }`) as a
 * fixed, full-screen overlay when open. Both hamburgers always open (never
 * toggle), but #welcomeOpenSidebar lives *under* that overlay once it's open
 * and no tab has been opened yet (welcomeScreen is still the active screen) —
 * clicking it then hits the sidebar's own content instead (Playwright reports
 * "isVisible" true for an occluded-but-undisplayed element, so that check
 * alone isn't enough). Check the sidebar's own open state first, and only
 * pick a hamburger — by which screen is actually active — if it's closed.
 */
async function openSidebarIfMobile(page, viewport) {
  if (viewport.name !== 'mobile') return;
  const isOpen = await page.locator('#sidebar').evaluate((el) => el.classList.contains('open'));
  if (isOpen) return;
  const welcomeHidden = await page.locator('#welcomeScreen').evaluate((el) => el.classList.contains('hidden'));
  const btn = welcomeHidden ? page.getByTestId('sidebar-open') : page.getByTestId('welcome-sidebar-open');
  await btn.click();
}

async function blurActiveElement(page) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
}

module.exports = {
  VIEWPORTS,
  THEMES,
  BASELINE_DIR,
  CURRENT_DIR,
  DIFF_DIR,
  FREEZE_CSS,
  seedTheme,
  stubVoiceDaemons,
  openSidebarIfMobile,
  blurActiveElement,
};
