# S2 · Today on iPad and iPhone

Slice S2 of Epic #34 (#127), on S1 ([design-today-s1.md](design-today-s1.md)). Intent: `design/homework/index.html`, "By device".

## User story

As the owner, I would like eve to fit the iPad or phone I am holding, so I can use it there without pinching or mis-tapping.

## Acceptance criteria

**S2-A1 · Three layouts** by layout-viewport width.
- *Wide* (≥ 1024): rail, panel and tab bar as now.
- *Regular* (600–1023): the sidebar is a slide-over, closed at load and after any navigation. The main area spans the full width. Today and the chat reading column are at most 720px, centred.
- *Compact* (< 600): bottom bar on Today, push navigation, no tab bar.

**S2-A2 · Thumb-sized.** Under `(pointer: coarse)`, every visible interactive control's border box is at least 44×44 at every width. The only exemption is links inside message prose (WCAG 2.5.8 inline).

**S2-A3 · Back.** On compact, Today → thread → Back (in-app or browser) shows Today, with no hash in the URL. The thread's tab is not closed.

**S2-A4 · Wordmark.** The Home | Work control is the wordmark at every size. On wide it sits at the top of the sidebar panel (S1's slot); on regular and compact, at the top of Today. It is one element moved between two slots. Test ids `mode-switch`, `mode-home` and `mode-work` are kept.

**S2-A5 · Front door.** Opening eve after this device has been away 60 minutes or more shows Today with Ask focused (fine pointers only, #129) and restores no tabs. Otherwise tabs restore as in S1. A deep link still wins.

**S2-A6 · No horizontal scroll** at 320–1366 on Today, chat and the file viewer (image viewer, text file in the editor), with a fine or coarse pointer.

## What I'd notice

On iPad portrait, no pinned sidebar and Today in one column. On the phone, a bottom bar, no tabs, and Back. Thumb-sized targets. After a long break, Today.

## Breakpoint model

- **CSS uses media queries, two exact strings.**
  - `(max-width: 1023.98px)` covers regular and compact; `(max-width: 599.98px)` covers compact.
  - Each of the 28 `@media (max-width: 768px)` blocks (in 18 files) is re-keyed in place. Sidebar and shell blocks go to the first string. Phone blocks (sheets, tab strip, editor column, toasts, rail strip) go to the second. A mixed block is split.
  - The 380px and 540px refinements stay. A unit guard allows no other width query.
  - Why not `html[data-layout]` selectors: media queries apply before scripts, keep specificity, and match the repo.
- **Pointer uses `@media (pointer: coarse)` only.** In Playwright, `hasTouch: true` alone makes this repo's Chromium match `(pointer: coarse)` and `(hover: none)` (checked). Never use `isMobile`: it moves the layout viewport to 980px.
- **`<html>` attributes carry JS state.**
  - `data-layout="wide|regular|compact"` is a mirror for JS and tests; CSS must not style it.
  - `data-nav="root|pushed"`: CSS may use it inside the compact query.

### `public/core/layout.js`

```js
// class Layout on window; app.js: container.register('layout', new Layout({ bus }))
Layout.QUERIES = { notWide: '(max-width: 1023.98px)', compact: '(max-width: 599.98px)', coarse: '(pointer: coarse)' };
Layout.classify(width)        // pure: >= 1024 'wide', >= 600 'regular', else 'compact'
layout.init()                 // after app.js captures _initialHash; sets attrs; listens to matchMedia, popstate
layout.name                   // 'wide' | 'regular' | 'compact', live
layout.coarse                 // boolean, live
layout.depth                  // 0 Today, 1 pushed view
layout.navigate(url, tabId)   // url null = Today; the only writer of tab history
layout.back()                 // in-app Back
```

New events in `core/constants.js`:
- `EVT.LAYOUT_CHANGED` (`'layout:changed'`, `{ name, previous, coarse }`), emitted on change after init.
- `EVT.NAV_CHANGED` (`'nav:changed'`, `{ depth, tabId, source: 'app'|'history' }`).

### Stack and history (A3)

- The compact stack is `[Today, active view]`, depth at most 1. Tabs stay in `TabManager`; navigation never closes one.
- `TabManager._updateHash` calls `layout.navigate`:
  - Compact, depth 0, a view: push `{ eveNav: 1, tabId }` with the tab's hash.
  - Depth 1, a view: replace.
  - Depth 1, Today: call `history.back()` if this document pushed the entry; otherwise replace with `{ eveNav: 0 }`.
  - Wide and regular: exactly today's replace, no new entries.
- `popstate` to depth 0 calls `tabManager.showToday({ fromHistory: true })` and strips the entry's hash. `popstate` to depth 1 re-activates `state.tabId` if that tab exists, else shows Today.
- Every `history.replaceState(null, …)` in `app.js` must pass `history.state` instead of `null`, or it erases the marker.

## Component changes

| Part | Wide | Regular | Compact |
|---|---|---|---|
| Sidebar | unchanged | slide-over `min(380px, 85vw)` over `#sidebarScrim` (tap closes); opened by `welcome-sidebar-open`, `sidebar-open` | today's full-screen sheet, opened from the bottom bar |
| Tab bar | shown | shown | hidden, kept in DOM |
| Bottom bar | – | – | depth 0 only |
| Back, title | – | – | depth 1; hamburgers hidden |
| Wordmark slot | sidebar | Today | Today |

- **Bottom bar:** `nav#bottomBar.bottom-bar` (test id `bottom-bar`, `aria-label="Navigation"`) with three buttons:
  - `nav-today`
  - `nav-threads`: opens the sheet on the active project's Sessions tab, or the first in-mode project's if none is active.
  - `nav-projects`: opens the sheet.
  - No Capture slot (that is S6).
- **Pushed header:** `button#navBack.nav-back` (`nav-back`, `aria-label="Back"`) and `span#navTitle` (`nav-title`, the active tab's label), placed first in `.chat-header`.
- **Wordmark markup:** `#modeSwitch.wordmark` (`role="radiogroup"`) contains `button.wordmark__word` Home, `span.wordmark__bar` "|" (`aria-hidden`) and `button.wordmark__word` Work. The buttons use `role="radio"`, `aria-checked` and `.wordmark__word--active`.
- **Wordmark slots:** `[data-wordmark-slot="sidebar"]` at the top of `#sidebarPanel`, and `[data-wordmark-slot="today"]` first in `#welcomeScreen`. `ModeSwitch` moves the element on `LAYOUT_CHANGED`.
- **Slide-over closing:** it closes on `NAV_CHANGED` and on the existing close events. `closeSidebarOnMobile` reads `layout.name !== 'wide'` instead of `innerWidth <= 768`.
- **Keybar:** CSS only; `IS_TOUCH` still gates it.
- **Full-width views:** editor, terminal, diff and image viewer use the full width.

**44px, one mechanism.**
- A new `public/apple/touch.css`, loaded after the other apple sheets, holds one `@media (pointer: coarse)` block.
- It sets a generic `min-width`/`min-height: 44px` on the control list, then per-component fixes in the same file.
- Size the real box, with no pseudo-element hit slop, so the sweep measures what a finger hits.
- `min-height` beats a fixed `height`, so no `!important` is needed.

### Front door (A5)

```js
// public/core/front-door.js, pure
FrontDoor.KEY = 'eve-last-active'; FrontDoor.AWAY_MS = 3600000;
FrontDoor.isAway(raw, now)   // missing, unparseable, or now - Number(raw) >= AWAY_MS
FrontDoor.read(storage); FrontDoor.stamp(storage, now)
```

- **Decide once,** in the `app.js` constructor, before any stamp.
  - If away, remove `eve-open-sessions` and `eve-open-files` before the first `onWebSocketReady`, so the existing restore finds nothing.
  - Session meta, recents and terminals (S1 rules) are untouched.
  - A deep link routes as now. Reconnects never apply the rule.
- **Stamp** (epoch ms):
  - right after the decision;
  - on `pointerdown`/`keydown` (capture, passive), at most once per 60 s;
  - always on `visibilitychange` to hidden and on `pagehide`.
- **Away** means no stamp for 60 minutes from any eve page on this device (localStorage is shared). Exactly 60:00 counts as away; a missing key counts as away.
- **Resume:** on `visibilitychange` to visible, if away, show Today (on compact, back to the root), focus Ask on fine pointers only (#129; a coarse pointer leaves the keyboard down) and keep the tabs. Then stamp.

## Tasks and ownership

Order: T2 → (T3 ∥ T4) → T5 → (T6a ∥ T6b) → T7. T3 (CSS) and T4 (DOM, JS) share only the names above.

| Task | Files | Budget |
|---|---|---|
| T2 Core | new `core/layout.js`, `core/front-door.js`, `apple/touch.css` (header); `core/constants.js`; `index.html` (two scripts after `core/constants.js`, one stylesheet after `apple/auth.css`); `app.js` (construct, register, init) | 6 files, ~250 lines |
| T3 CSS | `styles.css`, `apple/*.css` | 19 files, ~450 |
| T4 Chrome | `index.html` (DOM), `sidebar/mode-switch.js`, `sidebar/project-panel.js` (open on a tab), `tab-manager.js` (CRLF: `_updateHash`, `showToday`), `app.js` (bottom bar, Back, popstate, scrim, replaceState) | 5 files, ~200 |
| T5 Front door | `app.js` | ~40 |
| T6a Specs (test writer) | `test/e2e/layout-{breakpoints,touch,nav,overflow,front-door}.spec.js`, `test/e2e/layout-helpers.js`, `test/unit/{layout,front-door,css-breakpoints}.test.js`, the flips below | ~700 |
| T6b Visual, journeys (test writer) | `test/visual/{support,capture.spec}.js`, `__baseline__/`, `devboxverify/{journey-kit,journeys,main}.js`, `devboxverify/README.md`, `docs/design-devboxverify.md`, `test/unit/devboxverify.test.js` | ~300 + images |
| T7 Docs | `docs/FEATURES.md` (rows; journeys on home and shell; `touch.css` in shell), `docs/baseline.md`, `CLAUDE.md` (`eve-last-active`), this doc's As built | ~100 |

Going past a budget is a stop-and-ask. `terminal-keybar.js`, `home-screen.js` and `today/` have a budget of zero.

**Amendments to the issue's file list:** `core/front-door.js`, `core/constants.js`, `devboxverify/main.js` (three lines), `docs/design-devboxverify.md` (one line), `test/unit/devboxverify.test.js`.

## Specs

Viewports: 320×568, 390×844, 768×1024, 834×1194, 1024×768 and 1366×1024, with `hasTouch: true` set through `test.use`. No new Playwright project.

| | Spec |
|---|---|
| A1 | `data-layout` per width. Wide: rail in viewport. Regular: rail out of viewport at load; the menu opens it over the scrim, the scrim closes it; `#homeContent` ≤ 720, centred; `.main` = viewport width. Compact: bottom bar; no tab bar in a thread. Resizing 1024→1023 and 600→599 flips `data-layout`, one `LAYOUT_CHANGED` each. Unit: `classify` at 599, 600, 1023, 1024. |
| A2 | Sweep, per width: Today, sidebar (Files, Sessions), a chat with a reply, an expanded terminal keybar. Zero offenders. |
| A3 | 390 and 320: Continue row → thread → `nav-back` → Today, no hash, `tabs.length` unchanged; again → `goBack()` → Today; `goForward()` → thread; Threads → sheet → row → Back → Today. Wide: a tab switch adds no history entry. |
| A4 | Per width: one `mode-switch`, in the right slot, text `Home|Work`; `mode-home` flips `aria-checked`. |
| A5 | Stamp −61 min plus a stored thread: Today, Ask focused, no tab, both keys gone. −59 min: thread restores. No stamp: Today. −61 min with `#session/<id>`: thread opens. Resume after `clock.fastForward` 61 min and `visibilitychange`: Today, tab kept. Unit `isAway`: missing, garbage, 59:59, 60:00. |
| A6 | Per width, fine and coarse: Today, chat, `README.md` in the editor, an image in the viewer. Overflow empty. |
| Guard | Unit: the only width queries in `public/**/*.css` are the two strings, 380 and 540. |

**Sweep.**
- Candidates:
  - `button, a[href], input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])`;
  - interactive ARIA roles;
  - every element with computed `cursor: pointer` whose parent's cursor differs (sidebar rows are click-bound divs).
- Keep only candidates that pass `checkVisibility({ opacityProperty: true, visibilityProperty: true })`, are in the viewport, sit outside `inert`/`aria-hidden`, and are not `.message-content a`.
- Fail any whose width or height is below 43.99.

**Overflow.**
- `documentElement.scrollWidth <= innerWidth`.
- No visible element's right edge goes past `innerWidth + 1`, except inside `pre`, `.monaco-editor`, `.xterm`, `.terminal-keybar__keys`, `.tab-bar` or `.sidebar-rail__projects`.
- The second check is needed because `body` is `overflow: hidden` on narrow screens, so `scrollWidth` alone misses clipped content.

**Specs that change on purpose.**
- `schedules-and-connection`, `chat-defaults` (two specs) and `tab-panes` (legacy restore) seed tabs with no stamp, which now counts as away (A5). They also seed `eve-last-active` = now. The legacy JSON stays byte-identical.
- `test/visual`: `mobile` gains `hasTouch`, a new `ipad` 834×1194 touch viewport is added, and compact opens the sheet with `nav-projects`. Re-baselined on the devbox (macOS).
- All other specs (1280×720, fine pointer) pass unedited.

**Break-and-restore:** make `navigate` replace instead of push on compact. A3 and `today-phone` go red. Restore from a backup copy.

## devboxverify

- `env.newPage({ signedIn, device })`: `main.js` spreads `device` over the 1280×800 default.
- `journey-kit.js` exports `DEVICES.ipadPortrait` (834×1194) and `DEVICES.phone` (390×844), both with `hasTouch`, plus its own sweep and overflow probes.

**`today-ipad-portrait`** (areas home, shell; 45 s):
1. Greeting visible.
2. Acme's rail item is not in the viewport.
3. `.main` is at least 833 wide; `#homeContent` is at most 720 and centred within 2px.
4. The wordmark in Today reads `Home|Work`.
5. Overflow and sweep are empty.
6. The menu opens the slide-over: Acme in viewport, sweep empty.
7. The scrim closes it.

**`today-phone`** (areas home, shell, chat; needs project:acme; 75 s):
1. Greeting visible; bottom bar with Today, Threads, Projects; no tab bar.
2. Sweep and overflow empty.
3. Projects → Acme → launcher → Start Chat (no message, no model call).
4. Thread shown, bottom bar hidden, Back shown, hash `#session/…`.
5. Sweep and overflow empty.
6. Back → greeting, no hash.
7. Continue row → thread; `goBack()` → greeting.

The harness merge rules apply. Expect about +40 s on the 480 s nightly budget. Restart eve-verify after the `index.html` change.

## Risks

- `tab-manager.js` is CRLF. Patch it in place and run `grep -c $'\r'` before and after.
- Script order: both new scripts load after `core/constants.js`. `Layout` exists before `TabManager`, which reaches it through `container.has('layout')`, so bare unit instances still work.
- Globals: `IS_TOUCH` is fixed at load while `layout.coarse` is live, and `#sidebar.open` survives resizes.
- Read the front-door stamp before writing it.

## Decisions

Taken by the coordinator on the planner's recommendations, logged in #127.

1. After an away open, the stored tabs are cleared (otherwise the next reload brings them back).
2. Resuming a still-open page after 60 minutes counts as opening eve.
3. Back sits in the pushed header, which hides the bottom bar there (keeps today's soft-keyboard behaviour).
4. The 720px cap covers Today and chat only.
5. Split panes stay unchanged on regular and compact.

## Not verifiable unattended on the devbox

Chromium emulation proves widths, coarse sizing and history. Real WebKit devices are needed for safe areas, the soft keyboard, Split View, iPad trackpad pointer reporting and Safari page resume. That means the owner's devices or the iOS Simulator.

## Out of scope

Capture, the Threads space, a read-only compact editor, the diff-mode default (768px, `diff-viewer.js`), ⌘K on touch.

## Size

**L.** About 30 files, ~950 product lines, ~1,000 spec and harness lines. Cut line: A1, A2 and A6 first; then A3, A4 and A5.

## As built

- `nav-threads` opens the sessions tab through `ProjectPanel.openTab`.
- `navigate(url)` takes the hash string or a path; `null` means Today.
- `NAV_CHANGED` `source` is `'history'` for popstate-driven changes and `'app'` for everything else.
- `touch.css` repeats the sidebar 44px rules at wide, because a touch device can be wide (iPad landscape) while the 44px rules for the sidebar rows and panel controls sit in the narrow-width blocks; it beats those single-class `min-height` rules with `:root` plus an element list, no `!important`.
- The scrim shows through `html:has(#sidebar.open)`, so no JS toggles it.
- Bottom bar labels are text only.
- The 29th `768px` block, in `auth.css`, was re-keyed too.

## Amendments

Beyond the issue's file list, logged here:
- `docs/test.md` (one line: the new visual viewport)
- `public/auth.css` (its `768px` block)
