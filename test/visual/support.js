/**
 * Shared constants + helpers for the visual-regression harness.
 *
 * server.js reads public/index.html into memory once at startup. The `eve`
 * fixture spawns a fresh server per test so it always serves current disk
 * contents; pointing this harness at an already-running instance started
 * before an index.html edit screenshots stale markup against fresh JS/CSS.
 */
const path = require('path');

// `layout` is the S2 layout the width falls in (docs/design-today-s2.md).
// Touch viewports set hasTouch only, never isMobile (it moves the layout
// viewport to 980px).
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800, layout: 'wide' },
  { name: 'mobile', width: 390, height: 844, hasTouch: true, layout: 'compact' },
  { name: 'ipad', width: 834, height: 1194, hasTouch: true, layout: 'regular' },
];

const THEMES = ['dark', 'light'];

const BASELINE_DIR = path.join(__dirname, '__baseline__');
const CURRENT_DIR = path.join(__dirname, '__current__');
const DIFF_DIR = path.join(__dirname, '__diff__');

// Applied after each navigation so a screenshot depends only on final layout,
// never on where a CSS clock happened to be when the shutter fired.
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
 * Opens the sidebar when it is not pinned. Regular (ipad) has a slide-over
 * opened by either hamburger, picked by which screen is active; it sits over
 * #welcomeOpenSidebar once open, so its own open state is checked first.
 * Compact (mobile) opens the sheet from the bottom bar's Projects, which shows
 * only on Today, so a pushed view goes Back first.
 */
async function openSidebarIfNarrow(page, viewport) {
  if (viewport.layout === 'wide') return;
  const isOpen = await page.locator('#sidebar').evaluate((el) => el.classList.contains('open'));
  if (isOpen) return;
  if (viewport.layout === 'compact') {
    if (await page.getByTestId('nav-back').isVisible()) await page.getByTestId('nav-back').click();
    await page.getByTestId('nav-projects').click();
    return;
  }
  const welcomeHidden = await page.locator('#welcomeScreen').evaluate((el) => el.classList.contains('hidden'));
  const btn = welcomeHidden ? page.getByTestId('sidebar-open') : page.getByTestId('welcome-sidebar-open');
  await btn.click();
}

// Upper bound for the settle loop; a frame that still changes after this is a
// real instability, not a slow boot.
const SETTLE_TIMEOUT_MS = 10000;

/**
 * Waits until the app has finished booting: <html data-ready="1">, no Today
 * part still loading, and no rendered skeleton or file-tree loading row.
 */
async function waitForSettledApp(page) {
  await page.waitForFunction(() => {
    if (document.documentElement.dataset.ready !== '1') return false;
    if (document.querySelector('[data-testid^="today-part-"][data-state="loading"]')) return false;
    const busy = document.querySelectorAll('.today__skeleton, .file-tree__loading, .file-tree-loading');
    return ![...busy].some((el) => el.getClientRects().length > 0);
  }, undefined, { timeout: SETTLE_TIMEOUT_MS });
}

/**
 * Forces a full re-raster by resizing the viewport 1px and back.
 * Deliberate: Chromium leaves a stale row of the focus ring unpainted after a
 * blur, and a visibility toggle would blur the focused Ask textarea. A 1px
 * change never crosses the 600/1024 layout breakpoints.
 */
async function repaintAll(page) {
  const raf2 = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const { width, height } = page.viewportSize();
  await page.setViewportSize({ width: width + 1, height });
  await raf2();
  await page.setViewportSize({ width, height });
  await raf2();
}

/**
 * Captures until two consecutive PNG buffers are byte-equal, bounded by a
 * deadline. Returns { buffer, captures }.
 */
async function settledScreenshot(page, { timeoutMs = SETTLE_TIMEOUT_MS, name = 'screenshot' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let captures = 0;
  for (;;) {
    const buffer = await page.screenshot({ fullPage: true, animations: 'disabled' });
    captures += 1;
    if (previous && previous.equals(buffer)) return { buffer, captures };
    previous = buffer;
    if (Date.now() >= deadline) {
      throw new Error(`${name}: frame did not settle within ${timeoutMs}ms after ${captures} captures`);
    }
  }
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
  openSidebarIfNarrow,
  blurActiveElement,
  SETTLE_TIMEOUT_MS,
  waitForSettledApp,
  repaintAll,
  settledScreenshot,
};
