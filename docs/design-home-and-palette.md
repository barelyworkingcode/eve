# Design: Home screen, command palette, session identity

Why the UI is shaped the way it is after the "orientation" pass. Code carries
the present tense; this file carries the reasoning.

## The problem being solved

Eve was functional but disoriented you. Three symptoms shared one cause:

- The front door said "Open the sidebar" while the sidebar was already open.
- Five sessions in a project rendered as five identical rows
  (`host/omlx/Chat · Chat`), because relayLLM's session list carries only
  `{id, projectId, name, folder, directory, model, active}` — no timestamps,
  no message text, and `name` defaults to `"<Project> - <model>"`.
- Projects with similar names collapsed to the same rail initial ("H" ×5).

The cause: Eve rendered exactly what the server sent and nothing it had
learned itself. Everything below is Eve remembering what it already saw.

## SessionRecents (`public/core/session-recents.js`)

A browser-local memory keyed by session id: `{ title, lastOpenedAt }`.

- `touch()` on every `TabManager.openSession`.
- `setTitle()` from the first user turn — either the `history` that arrives
  with `session_joined`, or the first `user_message` on a fresh session.
- Pruned to 80 entries by recency; removed with the session.

It is deliberately **not** `eve-open-sessions` (open tabs, pruned on close)
or `eve-session-meta` (deleted on tab dispose). Both are tab-lifecycle state;
recency has to outlive the tab or "Continue where you left off" is empty the
moment you close something.

**Naming rule** (`sessionDisplayName` in `ui-utils.js`, the only place it
lives): a user-chosen name always wins. The auto name loses to the remembered
first ask. Lists strip the `"<Project> - "` prefix; tabs keep it, because the
tab bar is where project context lives and an e2e characterisation test pins
that.

**Server side**: `relayLLM/session.go#ListSessions` (branch
`feat/session-list-metadata`) adds `createdAt`, `messageCount`,
`lastMessageAt` and a first-user-turn `preview` to every list entry. Eve
treats them as fallbacks: the remembered local title beats `preview`, and the
local last-opened time beats `lastMessageAt`/`createdAt`, because what *you*
did on this device is the better recency signal. The two compose: the server
covers sessions this browser never opened; the client memory makes titles
appear the instant you send a first message, before any list refresh.

## Home screen (`public/home-screen.js`, `apple/home.css`)

Replaces the welcome text behind `#welcomeScreen` (the element and its
`hidden` toggling are unchanged; `tab-panes.spec.js` pins them).

Structure, top to bottom, and why:

1. **Greeting + summary line** — "1 session running · 8 projects · date".
   The first thing a returning user wants to know is whether anything is
   still going.
2. **Start tiles** — Chat, the first two terminal templates, Voice. Each opens
   the Shell Launcher with an `intent` (`web-chat` / `voice-chat` /
   `terminal:<id>`) so a tile is one click to the form, not two. Tiles are
   derived from `state.terminalTemplates`, the same source the launcher uses,
   so they never disagree with it.
3. **Continue** — up to six sessions, recents first, then anything live.
   Rows show project monogram, title, `project · model`, live dot, and the
   compact last-opened time.
4. **Project chips** — every visible project with its live count; click
   activates it in the sidebar. The "active" chip follows
   `projectTree.activeProjectId`, not `_resolveActiveProjectId()`, which falls
   back to `projects[0]` and would disagree with the sidebar.

First run (no projects) collapses to a single "Create a project" card.

Re-renders on session/project/template events via one rAF-coalesced
`scheduleRender()`; `showWelcomeScreen()` also renders so the screen is fresh
whenever it comes back.

## Command palette (`public/dialogs/command-palette.js`, `apple/palette.css`)

⌘K / Ctrl+K anywhere, including inside the chat textarea. Groups in fixed
order: Actions, Sessions, Projects, Open tabs, Recent files. Empty query shows
four actions and six sessions (recents first, then live); a query fuzzy-ranks
everything (subsequence match, word-start and contiguity bonuses, prefix
bonus). Built on `DialogBase` so escape/backdrop behave like every other
dialog; the panel is restyled as a top-anchored sheet.

Project activation goes through `app.projectTree.setActive(id)` (not a bare
`PROJECT_ACTIVATED` emit) because that method is what also moves the explorer
panel. File opening mirrors `search-dialog.js`: `EVT.FILE_CONTENT` with
`requestLoad: true`.

## Project colour and monograms

`StateStore.projectColor(id)` assigns hues by **alphabetical rank with a
golden-angle step** (`projectColorAtRank`), cached and invalidated on any
project mutation. Hashing the name was tried first and put "Hermes Files" and
"Hermes Files v3" 8° apart — the exact collision the change was meant to fix.
Rank order guarantees neighbours in the rail are far apart on the wheel; the
cost is that inserting a project alphabetically before others shifts their
hue, which is acceptable for a rail you scan by colour *and* monogram.

Monograms are two letters (initials of the first two words, or the first two
letters of a single word) for the same reason: one letter collapses siblings.

The rail repaints on session events (rAF-coalesced) so the per-project live
dot is truthful; previously it only repainted on project changes.

## Chat reading column (`apple/chat.css`)

- Messages sit in a centred column with an 820px measure; the composer shares
  it. Bubbles pinned to opposite edges of a 1400px window read as two people
  shouting across a room.
- The assistant speaks as flush prose (the page is its surface); the user's
  turns stay as bubbles so the two voices remain distinct at a glance. The
  assistant bubble colour token (`--message-assistant`) is still consumed by
  tool and thinking cards, so the Colors settings tab keeps meaning.
- Collapsed thinking/tool disclosures hug their label; opened, they take the
  full measure.
- A caret blinks at the end of streaming text (keyed on the transient
  `data-raw-text` attribute the renderer sets only while streaming).
- Entrance animation and the caret respect `prefers-reduced-motion`.

## Terminal re-join on first connect (bug fixed on the way)

`onWebSocketReady` runs `resubscribeAfterReconnect()` after the async
project/session loads and, until this pass, `markTerminalsForRejoin()` marked
*every* open terminal — including one created during that load window, which
is already a viewer on the new socket. That sent a spurious
`terminal_reconnect` on a first connect (`terminal-reconnect.spec.js` caught
it once the Home screen's load-time rendering widened the window). The fix
snapshots terminal ids before the loads and marks only those; the upstream
relay-reconnect path (`relay_status`) still marks all.

## Tests and gates

- `test/unit/session-recents.test.js` — recents store, titles, pruning,
  monograms, rank colours, compact time, naming rule.
- `test/unit/command-palette.test.js` — matcher, ranking, prefix stripping,
  empty-query ordering.
- Visual baselines (`test/visual/__baseline__`) were re-captured: the welcome,
  chat and sidebar screenshots all changed on purpose.
