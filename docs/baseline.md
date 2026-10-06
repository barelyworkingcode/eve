# Cloud baseline: goals to specs

What the Linux tiers prove about eve before the Home|Work epic (#34) changes it,
and what they cannot. The specs drive the real eve in Chromium against the relay
fake (`test/integration/fake-relay.js`), so a green run says "eve does this
against a relay that answers as relay's source says". It does not say "relay
does this": the real relay, the devbox journeys (`devboxverify/`) and the
pixel baselines stay the real-app gate.

Every spec asserts what a person sees today. A slice that changes a behaviour on
purpose rewrites the matching assertion in the same PR and says so.

## Goals

Goal numbers are `docs/FEATURES.md`. Specs are under `test/e2e/`; `goals/` is
the goal-level set, the rest predate it.

| Goal | Proved in the cloud by | Not provable here |
|---|---|---|
| G1 Get in, see my work | `goals/g1-landing`, `goals/home-screen`, `app` | passkey sign-in off the trusted network (real WebAuthn) |
| G2 Ask and get an answer | `goals/g2-g8-chat` (reply, list, error row, resume), `chat`, `chat-input-row`, `chat-form-and-permissions` (Stop, send gating) | model quality, real streaming |
| G3 Pick up where I left off | `goals/g3-reopen-thread` (Sessions list, Continue, ⌘K, running marks), `schedules-and-connection` (deep link) | history from a real transcript |
| G4 Shell on my project | `goals/g4-terminal` (only when asked, runs a command, survives reload), `terminal-reconnect`, `goals/home-screen` (template tiles) | a real PTY, sandboxing |
| G5 Hand off a task | `goals/g5-tasks` (create, run, fail, edit, delete), `goals/routines-page`, `goals/routines-make`, `goals/routines-today`, `goals/routines-audit` (the audit route is served by the fake from relay's pinned shape), `task-dialog-models`, `schedules-and-connection` (wire shapes) | real scheduling, relayScheduler behaviour beyond its pinned API |
| G6 Check what agents did | `goals/g5-tasks` (last run opens as its thread), `changes-panel` (Changes, diff), `goals/agent-attention` (state dots, groups, phone badge), `goals/agent-drop-in` (Drop in on a stuck headless Claude agent) | a real agent's edits |
| G7 Read and edit files | `goals/g7-files` (tree, open, save, outside change, Reload, node_modules quiet), `tab-panes` | |
| G8 Agents under my control | `goals/g2-g8-chat` (prompt, Allow, Deny, Allow All, queue), `chat-form-and-permissions` (plan mode) | relay's owner gate |
| G9 Hands-free | `chat-defaults` (voice deep link), `voice-buttons` | speech (`test:voice`, live daemons) |
| G10 Find something | `goals/g10-find` (⌘K, project search, no matches) | |
| G11 Share files and images | `chat-input-row` (attach visibility) | **gap**: paste/drop upload and generated-image rendering have no spec |
| G12 Set up a project | `goals/g12-projects` (create, refuse, edit, delete), `template-blank-model`, `chat-defaults` (template editor) | relay-owned settings (per-tool MCP scoping, tokens) |
| G13 Project on another machine | integration `host-projects` | **gap**: no browser spec for host chips and status |
| G14 Arrange my workspace | `tab-panes` | |
| G15 Phone | | native app, Safari, touch; devbox only |
| G16 Add or remove a browser | `passkey-enrolment` (button), integration `eve-passkey-enrolment` | the ceremony itself (a CDP virtual authenticator could cover it; not attempted) |

## What changed to make this possible

- The fake answers as relay and relayScheduler do, pinned to their source
  (`relay-source-pins.test.js`; see `docs/test.md`): project `mode` and
  `default_for`, the default-project route, tasks (CRUD, run, history, the
  `/ws/tasks` events), terminals that echo and run `echo`, joined-viewer
  delivery, refusals and close codes.
- `test/e2e/goals/fixture.js` gives a spec two projects with files and lets it
  seed sessions, tasks, terminals and templates on the fake before the page opens.

Screenshots of the states these specs drive are in [baseline/](baseline/) (desktop, Chromium, the fake relay).

## Known behaviour recorded, not fixed

Found while writing the specs. Each is pinned as it stands, or as an expected
failure (`test.fail`) that goes red the moment it is fixed.

- ~~**Home project chips are inert**~~ fixed by S1 (A8): the chip calls
  `ProjectTree.setActive`; the `test.fail` marker is gone.
- ~~**Relay down at load looks like a new install**~~ fixed by S1 (A3c): each
  part that needs relay says so with a Retry; first-run is offered only when
  projects loaded and there are none.
- ~~**"Running" means the provider process is alive**~~ fixed by S1 (A3):
  running is a turn in progress or an executing task run, derived from frames
  (`core/session-activity.js`); `live` shows nothing.
- ~~**eve drops `mode` and `default_for`**~~ fixed by S1 (A7): carried as `mode`
  and `defaultFor`.
- **S2 (#127) flips on purpose.** A device with no `eve-last-active` stamp
  counts as away and opens Today with no tabs, so the specs that restore tabs
  from storage (`schedules-and-connection`, two in `chat-defaults`, the legacy
  restore in `tab-panes`) now seed `eve-last-active` = now; their stored tab
  JSON is unchanged. The visual baselines gain an `ipad` viewport (834×1194,
  touch) and a touch phone, and compact opens the sheet through `nav-projects`.
  Behaviours pinned as they stand: on compact, Today → thread → Back shows
  Today with no hash and keeps the tab open; the slide-over closes on any
  navigation; resuming a page after 60 minutes returns to Today.
- **S5a (#131) flips on purpose.** The panel's tabs are Files and Changes, so
  the specs that read the Sessions or Tasks tab now go through
  `panel-project-page` and the page's `project-thread-*`, `project-task-*` and
  `project-threads-count` (`g3-reopen-thread`, `g5-tasks`, `g2-g8-chat`,
  `today-truth`, `layout-touch`, `layout-overflow`, `layout-nav`, `app`;
  `unit/changes-panel`'s tab list). `nav-threads` on compact opens the project
  page; Today -> page -> thread -> Back still lands on Today. The terminal specs
  (`g4-terminal`, `today-front-door`) reach a held terminal through the
  `today-agent-*` row; "no tab before the click" is unchanged. New:
  `goals/workbench-page`, `workbench-agents`, `workbench-ask-about`; unit
  `terminal-text`, `unified-diff`, `ask-about`. The `sidebar-session-*`,
  `sidebar-terminal-*` and `sidebar-task-*` ids are retired. Journeys that flip:
  `open-existing-thread` (door becomes Project page), `terminal-on-request`
  (the board lists the probe), `task-created-listed` (page Tasks); `ask-about-file`
  is new. Visual baselines for the panel tabs are re-taken by the owner on macOS.
  Behaviours pinned as they stand: the page's Changes count shows only while the
  panel's active project is the page's; the board shows "+N more" beyond 20 rows
  and fetches a last line only for the first 20; a terminal already stopped when
  listed says "exited" with no code.
- **The ⌘K palette is a snapshot** of what is loaded when it opens.
- **Deleting a project asks twice**: a native `confirm()`, then the modal that
  says what is lost (`goals/g12-projects`).

## Detection check

Before the refactor relies on the goal specs, each of the breakages below was
applied on its own to eve's product code, the unit suite and `test/e2e/goals`
were run, and the file was restored. A breakage nothing caught was a gap: a
spec was added or tightened, and the breakage re-run until red. No existing
assertion was loosened.

38 breakages across Home, palette, sessions, tasks, files, permissions,
projects and the terminal, plus two re-aimed re-runs (B19b, B20c). First pass: 26
caught by a goal spec, 4 by the unit suite only (B16, B32, B33, B38) and 8 by
nothing. Of those 8, five were real gaps (B08, B09, B15, B30, B34), one more
surfaced on re-run (B11b), and B11, B19 and B20 were mis-aimed or equivalent
(below). Every real gap is now caught.

| # | Breakage | File | Caught by (first pass) | Gap closed by |
|---|---|---|---|---|
| B01 | Morning ends at 09:00 instead of 12:00 | `public/home-screen.js` | `home-screen` (1 red) |  |
| B02 | Continue list shows 5 rows, not 6 | `public/home-screen.js` | `home-screen` (1 red) |  |
| B03 | Continue list orders oldest server activity first | `public/home-screen.js` | `g3-reopen-thread`, `home-screen` (2 red) |  |
| B04 | Home lists task-run sessions as threads | `public/home-screen.js` | `g5-tasks`, `home-screen` (2 red) |  |
| B05 | Running count counts dormant sessions | `public/home-screen.js` | `g3-reopen-thread` (2 red) |  |
| B06 | Project chip never shows the running dot | `public/home-screen.js` | `g3-reopen-thread` (1 red) |  |
| B07 | Session row never shows the running dot | `public/home-screen.js` | `g3-reopen-thread` (1 red) |  |
| B08 | Home summary always pluralises "projects" | `public/home-screen.js` | **none** | `g12-projects` Delete Project: summary matches `/\b1 project · /` (a substring "1 project" also matched "1 projects") |
| B09 | Palette ranks the worst match first | `public/dialogs/command-palette.js` | **none** | `g10-find` "typing ranks the best match first" (new) |
| B10 | Palette has no Sessions group when typing | `public/dialogs/command-palette.js` | `g3-reopen-thread` (1 red) |  |
| B11 | Palette lists task-run sessions with an empty query | `public/dialogs/command-palette.js` | **none** | equivalent: `_collectSessions` and the empty-query list both drop runs, so one filter alone changes nothing. B11b (the typed-query path) is caught by `g10-find` "typing the run's name…" (new) |
| B12 | Reopening a thread sends no join_session | `public/app.js` | `g3-reopen-thread`, `g5-tasks` (4 red) |  |
| B13 | session_joined history is discarded | `public/message-dispatcher.js` | `g12-projects`, `g3-reopen-thread`, `g5-tasks` (5 red) |  |
| B14 | A project's Sessions list shows only live threads | `public/core/state-store.js` | `g3-reopen-thread` (1 red) |  |
| B15 | Sidebar Sessions list includes task runs | `public/sidebar/project-panel.js` | **none** | `g5-tasks` "the project's Sessions list does not include the run behind a task" (new) |
| B16 | GET /api/sessions stops hiding __search: sessions | `routes/index.js` | unit: `routes-index.test.js` |  |
| B17 | Task create payload drops projectId | `public/dialogs/task-dialog.js` | `g5-tasks` (2 red) |  |
| B18 | Task create payload drops the prompt | `public/dialogs/task-dialog.js` | `g5-tasks` (2 red) |  |
| B19 | Task Run Now does not call the API | `public/task-manager.js` | **none** | wrong target: the sidebar calls the API in `project-panel.js`, not `task-manager.js`. Re-run as B19b: caught by `g5-tasks` |
| B20 | task_completed does not update lastStatus | `public/message-dispatcher.js` | **none** | equivalent: `task_completed` reloads the task list, which overwrites `lastStatus`. Ignoring the whole event (B20c) is caught by `g5-tasks` |
| B21 | Task delete skips the confirmation | `public/dialogs/task-dialog.js` | `g5-tasks` (1 red) |  |
| B22 | Task created disabled regardless of the checkbox | `public/dialogs/task-dialog.js` | `g5-tasks` (1 red) |  |
| B24 | Watcher drops every file-system event | `file-watcher.js` | `g7-files` (3 red) |  |
| B25 | node_modules no longer ignored by the watcher | `file-watcher.js` | `g7-files` (1 red) |  |
| B28 | Allow sends approved:false | `public/modal-manager.js` | `g2-g8-chat` (1 red) |  |
| B29 | Allow All is not remembered for the session | `public/modal-manager.js` | `g2-g8-chat` (1 red) |  |
| B30 | Queued permission requests are served newest first | `public/modal-manager.js` | **none** | `g2-g8-chat` "several waiting requests are asked in the order they arrived" (new) |
| B31 | A queued permission is never shown after the first is answered | `public/modal-manager.js` | `g2-g8-chat` (1 red) |  |
| B32 | project-normalize drops permissionPolicy | `project-normalize.js` | unit: `project-normalize.test.js` |  |
| B33 | project-normalize drops chatTemplates | `project-normalize.js` | unit: `project-normalize.test.js` |  |
| B34 | Project dialog omits allowed_models from the save | `public/dialogs/project-dialog.js` | **none** | `g12-projects` "saving an edit sends the project's allowed models back, unchanged" (new) |
| B35 | Project dialog sends an empty path | `public/dialogs/project-dialog.js` | `g12-projects` (2 red) |  |
| B36 | Deleting a project leaves its tasks | `public/app.js` | `g12-projects` (1 red) |  |
| B37 | Terminal input not base64-encoded | `public/terminal-manager.js` | `g4-terminal` (2 red) |  |
| B38 | Reconnect never marks terminals for re-join | `public/terminal-manager.js` | unit: `terminal-rejoin.test.js` |  |
| B23 | Editor save sends the wrong message type | `public/file-editor.js` | `g7-files` (1 red) |  |
| B26 | Dirty editor never shows the external-change banner | `public/file-editor.js` | `g7-files` (1 red) |  |
| B27 | Clean editor ignores an outside change | `public/file-editor.js` | `g7-files` (1 red) |  |
| B19b | Sidebar Run Now does not call the API | `public/sidebar/project-panel.js` | `g5-tasks` (2 red) |  |
| B20c | task_completed events are ignored | `public/message-dispatcher.js` | `g5-tasks` (1 red) |  |
| B11b | Palette lists task-run sessions when typing | `public/dialogs/command-palette.js` | **none** (found on re-run of B11) | `g10-find` "typing the run's name does not offer it as a session either" (new) |

Notes:

- "Unit" rows (B16, B32, B33, B38) are caught by the unit tier, not by a browser
  spec; the browser specs do not reach a hidden `__search:` session, relay's
  dropped project fields, or the terminal re-join path on a relay reconnect.
  They stay covered by the unit tier.
- Two breakages were equivalent mutants, not gaps: B11 (a redundant second filter)
  and B20 (the task list reload after `task_completed` overwrites `lastStatus`).
- Reproduce: apply one edit, `npx playwright test test/e2e/goals --retries=0`,
  `npm test`, then `git checkout -- <file>`.

## Stability

The full e2e suite (127 tests, about 4.5 minutes) was run ten times in a row on Linux
with `--retries=0` before the detection check, and five more times after it
added specs. All fifteen runs were green. Three flakes were found along the way,
all in tests and all fixed rather than retried: the palette opened before sessions
had loaded (two specs), and an older terminal spec that did not unwrap eve's
`__batch` frames. Unit and integration tiers were green on the same head.

The detection check was repeated independently with fourteen fresh breakages
(greeting bands, Continue length, running count, `live` flag, Allow answering
deny, Run Now, tree refresh, terminal join, session list, palette projects,
external-change bar, project path, create-session error text, project count);
every one turned a spec red.

## S1 detection check (Today, Work mode, #122)

Same method as above, applied to the S1 code: each breakage on its own, then
`npm test` and the Today, Home, reopen-thread and terminal goal specs
(`today-*`, `home-screen`, `g3-reopen-thread`, `g4-terminal`), then the file
restored. The full e2e suite was green five runs in a row (172 tests, about 7
minutes each, `--retries=0`) before the check.

| # | Breakage | Caught by |
|---|---|---|
| D01 | Ask never takes focus | `today-front-door` |
| D02 | `terminal_list` opens terminals again | `terminal-rejoin` (unit), `today-front-door`, `g4-terminal` |
| D03 | `llm_event` does not start a turn | `session-activity` (unit), `today-truth` |
| D04 | A permission answer never clears waiting | `today-truth` |
| D05 | A live process counted as running | `today-truth`, `g3-reopen-thread` |
| D06 | Mode filter shows every project | `mode` (unit), `today-mode` |
| D07 | Palette ignores mode for projects | `today-mode` |
| D08 | Mode not persisted | `mode` (unit), `today-mode` |
| D09 | Ask ignores the default project | `today-ask` |
| D10 | Shift+Return submits | `today-ask` |
| D11 | Ask drops the text on failure | `today-ask` |
| D12 | The host lets a part's throw escape | `today-parts` (unit) only; no e2e path makes a real part throw |
| D13 | A failed source still reads as ready | `today-parts`, `today-truth`, `home-screen` |
| D14 | Projects load awaits tasks again | `today-parts` ("slow tasks do not delay projects or sessions") |
| D15 | A `timeout` run is not failed | `today-truth` |
| D16 | `defaultFor` dropped by normalize | `project-normalize` (unit), `today-ask` |
| D17 | Continue does not wait for tasks | `today-parts` |
| D18 | The chip only emits, does not activate | `home-screen` |
| D19 | The sidebar terminal click only switches tabs | `today-front-door`, `g4-terminal` |
| D20 | Source errors never say "Can't reach relay" | `today-truth`, `home-screen` |
| D21 | Mode change does not re-render the tree | `today-mode` |
| D22 | The Ask text never reaches the thread | `today-ask` |
| D23 | `session_joined` does not clear stale activity | `session-activity` (unit) only |
| D24 | Going offline does not reset activity | first pass: **none** (the automatic re-join cleared the state first); closed by holding the re-join in the `today-truth` disconnect spec, now caught |
