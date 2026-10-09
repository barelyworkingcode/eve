# S5a · Project workbench

Slice S5a of Epic #34 (T5). Intent: `design/homework/index.html`, mockup 09. Builds on S1 ([design-today-s1.md](design-today-s1.md)) and S2 ([design-today-s2.md](design-today-s2.md)).

## User story

As the owner, I would like one page per project with its threads, agents and tasks, every live terminal listed with its last line, and a way to ask about what I'm looking at, so I can see my agents and ask about their work without hunting.

## Acceptance criteria

**S5a-A1 · Project page.**
- One main-area tab per project, `#project/<id>`. Opening it again focuses the existing tab. It is not persisted, like `diff`.
- Doors: the panel header button `panel-project-page`, the deep link, and on compact the bottom bar's Threads (A5).
- It shows:
  - a header: the name, then where it lives ("this Mac", or the host chip with its status) and the path;
  - New thread (`project-new-thread-<id>`), which opens the existing launcher;
  - the sections Agents, Threads and Tasks, each with its count;
  - Files and Changes rows that open the sidebar panel on that tab, Changes with its count.
- An unknown id gives "Project not found." (`_hashRouteError`). S1-A4 applies unchanged: a mode switch never closes this tab.

**S5a-A2 · Panel trimmed.**
- The panel's tabs are Files and Changes. A stored `eve-active-tab` of `sessions` or `tasks` opens Files.
- Threads keep everything they had in the panel: folders, rename, move, delete, swipe, long-press. Tasks keep New Task, Run Now, Edit and open last run. All of it now lives on the page.
- A task run is never listed as a thread (S1-A6).

**S5a-A3 · Agent board.**
- Two places show it:
  - a Today part `agents` (order 55, both modes) for terminals in in-mode projects and terminals in no project;
  - the page's Agents section, for that project's terminals only.
- A row shows project (Today only), template label, state ("open", or "exited <code>"), and last line. Task-run terminals are excluded.
- Tapping a row attaches: it switches to the tab if one exists, else calls `openTaskTerminal`. Nothing opens by itself (S1-A2 unchanged).
- Before the first `terminal_list` the board shows loading. With relay down it shows "Can't reach relay" (S1-A3c). Empty reads "No agents running".
- Last line: the last line of output that is not empty and not only box-drawing, with escape sequences removed, at most 120 characters.
  - Source: the xterm buffer when this browser holds the terminal, else the tail of `GET /api/terminals/:id/log`.
  - Fetched when a row first appears and on `TERMINAL_LIST`, at most once per terminal per 15 s, for at most 20 rows. Never polled.
  - A 404 shows no line.

**S5a-A4 · Ask about this.** "Ask about this" appears on a file in the tree's context menu (not folders), in the diff pane toolbar (`diff-ask`), and on the search dialog's results (`search-dialog-ask`).
- It shows Today (on compact, the root), focuses Ask, and shows a removable chip (`today-ask-attachment`).
- For this ask, Ask's project is the item's project, overriding the mode default and the pick. The remembered pick is unchanged.
- Return creates one thread there and sends the typed text with the item as a text attachment. Removing the chip restores the normal rule.
- A second item replaces the first. The chip survives Today events until it is sent or removed.
- Not offered for host projects (Ask cannot start there), nor for a binary or too-large diff.
- An item over 256 KB gets no chip and the line "That's too large to attach (over 256 KB)."
- Content by kind:
  - file: its text;
  - diff: a unified diff of that file in the pane's scope, 3 lines of context;
  - search: the shown matches, at most 200, as `path:line: text`.

**S5a-A5 · Threads door.** On compact, the bottom bar's Threads opens the page of the active project, else of the first in-mode project. With none, it opens the sheet.

## What I'd notice

The panel has only Files and Changes, plus a Project page button. Today lists my terminals with their last line, and a tap opens one. "Ask about this" on a file, diff or search results takes me to Ask with it attached.

## Interfaces

No wire change. `user_input.files[]` already carries text: `{ name, content, type: 'text', mediaType: 'text/plain' }`.

```js
// panes/project-pane.js
panes.registerType({ type: 'project', create({ projectId }) → { id: `project:${projectId}`, type: 'project', projectId, label },
  view: () => 'project', hash: (tab) => `#project/${encodeURIComponent(tab.projectId)}` });   // no persist
panes.registerView({ view: 'project', elementId: 'projectPane', splittable: false, show(ref, ctx) });
// project-page.js:   class ProjectPage { constructor(container); show(projectId); render(); }
// agent-board.js:    class AgentBoard { constructor({ container, testidPrefix, showProject, filter }); mount(el); render(); destroy(); }
// core/terminal-text.js (pure): TerminalText.lastLine(raw, max = 120) → string
// core/unified-diff.js (pure):  UnifiedDiff.format(path, original, modified, lineChanges, context = 3) → string  // Monaco ILineChange[]
// today/ask-about.js: AskAbout.start(container, { projectId, attachment: { kind: 'file'|'diff'|'search', name, label, content } })
//   sets state.askAbout, calls tabManager.showToday(), emits EVT.ASK_ABOUT ('ask:about')
// app.sendUserText(sessionId, text, files = [])      // state.pendingAsk gains `files`
// api.getFileText(projectId, path)                    // existing eve route GET /api/files/:projectId/*
// terminalManager.lastLineOf(id) → string | null      // xterm buffer, open terminals only
```

Test ids:
- page: `project-page-<id>` (`data-state`), `project-new-thread-<id>`;
- page sections: `project-threads-count`, `project-thread-<sessionId>`, `project-folder-<id>-<name>`, `project-agent-<terminalId>`, `project-task-<taskId>`, `project-task-new-<id>`, `project-files-<id>`, `project-changes-<id>`;
- panel and Today: `panel-project-page`, `today-part-agents`, `today-agent-<terminalId>` (`.agent-row__last` holds the last line);
- Ask about this: `today-ask-attachment`, `today-ask-attachment-remove`, `diff-ask`, `search-dialog-ask`.

The `sidebar-session-*`, `sidebar-terminal-*` and `sidebar-task-*` ids are retired with the rows they named.

## Tasks and ownership

Order: T1 → T2 → (T3 ∥ T4) → T5 → T6.

| Task | Files | Budget |
|---|---|---|
| T1 Contract, red specs (test writer) | this doc; `test/e2e/goals/workbench-{page,agents,ask-about}.spec.js`, `test/unit/{terminal-text,unified-diff,ask-about}.test.js`; the flips below | ~800 |
| T2 Page | new `project-page.js`, `panes/project-pane.js`, `apple/project-page.css`; `sidebar/project-panel.js` (thread and task code moves out), `index.html` (owner: `#projectPane`, tags), `app.js` (owner: register, `#project/` route, nav-threads), `apple/touch.css` (owner) | 7 files, ~650 (~350 moved) |
| T3 Board | new `agent-board.js`, `core/terminal-text.js`, `today/parts/agents-part.js`, `apple/agents.css`. Allowed edits: `home-screen.js` (1 line), `project-page.js` (Agents mount, ≤15), `terminal-manager.js` (`lastLineOf`, ≤15), `index.html` and `touch.css` (its tags and selectors only) | ~330 |
| T4 Ask about | new `today/ask-about.js`, `core/unified-diff.js`; `today/parts/ask-part.js`, `core/constants.js`, `core/api-client.js`, `sidebar/file-tree-node.js`, `diff-viewer.js`, `dialogs/search-dialog.js`, `apple/home.css`. Allowed edits: `message-dispatcher.js` (≤5), `app.js` `sendUserText` (≤6), `index.html` and `touch.css` (its tags and selectors only) | 12 files, ~380 |
| T5 Journeys (test writer) | `devboxverify/{journeys,journey-kit}.js`, `devboxverify/README.md`, `test/unit/devboxverify.test.js`, `test/visual/__baseline__` (devbox) | ~200 + images |
| T6 Docs | `docs/FEATURES.md` (G3, G4, G5, G6, G10 rows; the `projects`, `terminal` and `home` code globs), `docs/baseline.md`, As built | ~80 |

Budget zero:
- the five CRLF files, `public/tab-manager.js` included: `openPane` is generic, so the page needs no edit there;
- `ws/`, `routes/`, relay and relayScheduler.

Going past a budget is a stop-and-ask.

## Relay and the fake

No new relay call. The last line uses `GET /api/terminals/:id/log`, which is already faked (`TERMINAL-LOG-BYTES`, 404 for an unknown id) and pinned. Files come from eve's own `/api/files`.

## Red-first specs

| Spec | Criterion |
|---|---|
| The panel shows Files and Changes only; a stored `sessions` tab opens Files; `panel-project-page` opens `#project/alpha`; opening it twice gives one tab; `#project/nope` says "Project not found." | A1, A2 |
| Page Threads lists alpha's threads only, with the count and no task run; a click opens the thread with no `create_session`; folder menu and delete work | A2 |
| Page Tasks: create, list, reload, Run Now, Edit, open last run (g5 behaviours on the new door) | A2 |
| Fake `terminal_list` with two terminals in alpha, one in beta and one in an out-of-mode project: Today lists the three in-mode ones, the page lists alpha's; no tab and no `#terminal` at any point; a tap attaches; listed then joined never activates | A3 |
| Last line shows `TERMINAL-LOG-BYTES`; a log 404 shows none; a stopped terminal says "exited 1"; relay down says "Can't reach relay" | A3 |
| File "Ask about this": Today, Ask focused, chip with the path; Return sends one `create_session` in the file's project, and `user_input.files[0]` has the content; removing the chip restores the default project; no menu item on a host project; a >256 KB file gives the line and no chip | A4 |
| `diff-ask`: the attachment holds `--- a/`, `+++ b/` and an `@@` hunk | A4 |
| `search-dialog-ask`: the dialog closes; the chip reads "N results for …"; the content lines are `path:line: text` | A4 |
| 390 wide: `nav-threads` pushes the active project's page | A5 |
| Unit `lastLine`: CSI, OSC, `\r` overwrite, box-drawing-only lines, a zsh prompt, truncation | A3 |
| Unit `UnifiedDiff.format`: add, delete, change, a hunk at the start of the file, an empty original | A4 |

### Specs that change on purpose

None is weakened: only the door changes, and the assertions move with it.

| Spec | Change | Criterion |
|---|---|---|
| `app.spec` :19; `unit/changes-panel` :793 | the panel's tab list becomes Files and Changes | A2 |
| `g3-reopen-thread` 42–46, `g2-g8-chat` 41, `today-truth` 28, `layout-touch` 22–26, `layout-overflow` 31, `layout-nav` 96 | Sessions tab → `panel-project-page` → `project-thread-*`; the count is read from `project-threads-count` | A2 |
| `g5-tasks` (all) | Tasks tab → page Tasks, `project-task-*` | A2 |
| `g4-terminal` 71, `today-front-door` 40–44 | the Sessions panel row → the `today-agent-*` row (and the page row); "no tab before the click" stays | A3 |
| `layout-nav` 41 | `nav-threads` → the project page | A5 |
| visual baselines | the panel tabs change; the owner re-baselines on macOS | A2 |

## devboxverify

Journeys that flip, each stated in the PR:
- `open-existing-thread`: the door "Sessions tab" becomes "Project page". The other two doors and the no-new-session check are unchanged.
- `terminal-on-request`: after a reload, Today's agent board lists the probe with a non-empty last line and no pane. The page's Agents section lists it too. A tap on the Today row opens it, then EVE_OK and EVE_AGAIN as now.
- `task-created-listed`: Tasks tab → page Tasks; `#panelContent` → `project-page-<id>`.

New, `ask-about-file` (areas home, chat, files; needs project:acme; 90 s):
1. Write a scratch file with a nonce code word.
2. Tree context menu → Ask about this.
3. Today is shown, Ask is focused, and the chip names the file.
4. Ask for the code word and press Return.
5. Verdict: exactly one new Acme session, the user bubble lists the attachment, and the reply is non-empty. Whether the reply contains the nonce is reported, not judged, like chat-reply's "said 4".

The nightly gains about 60 s.

## Risks

- Logs can be about 1 MB per terminal. The cap of 20 rows and 15 s bounds this; a relay `tail` parameter would be a relay issue.
- The last line of a TUI (Claude Code) may be status-bar noise. Box-drawing-only lines are skipped. Readability needs a devbox look.
- Monaco `getLineChanges()` is null until the diff is computed. `diff-ask` stays disabled until `onDidUpdateDiff`.
- Moving about 350 lines out of `project-panel.js`: a move, not a rewrite.
- Script order: `core/terminal-text.js` and `core/unified-diff.js` load after `core/constants.js`; `agent-board.js` and `project-page.js` after `sidebar/*`; `today/ask-about.js` and `agents-part.js` with the other `today/*` scripts. Restart eve after the `index.html` edit.

## Decisions

1. The rail click is unchanged and the page opens from the panel button. Making the rail open the page would also flip `today-phone`, the `openProject` and `openLauncher` journey helpers, and S1-A8.
2. Tasks stay "Tasks" until S5b.
3. The board shows in both modes, filtered by mode as S1-A4 requires.
4. Search's AI summary stays.
5. Compact: Today → page → thread → Back lands on Today (S2's stack is at most one deep).

## Open questions

1. Under the merge rule "`main`'s harness against the head", three journeys go red by design. As in S1, the PR rewrites them and the evidence line names each flip. Whether merge-check accepts that is a gate question (What needs me 2).
2. One-tap starts (Claude Code, pi, Shell) and approvals inside agent rows (mockup 09) are not in this scope: a later slice, or never?
3. Merging the search AI summary into "Ask about these results" (the design's table) needs owner intent.

## Not verifiable unattended

The look of the last line on real TUIs, and a real iPad or iPhone.

## Out of scope

Routines (S5b), Threads as a space, ⌘N, Ask about a selection, the commit flow.

## Size

**L.** About 20 files, ~1,350 product lines (~350 of them moved), ~1,000 spec and journey lines. Cut line: A1 and A2 first, then A3, then A4 and A5.

## As built

- `api.getFileText(projectId, path, maxBytes)` rejects before reading the body when `Content-Length` exceeds `maxBytes`, so an oversize file is never downloaded.
- A binary file gets the line "That isn't a text file." and no chip.
- `UnifiedDiff.format` drops the trailing empty line Monaco reports at the end of a model.
- The board's exit code comes from `terminal_exit` and is kept. A terminal already stopped when first listed shows "exited" with no code.
- Beyond 20 rows the board shows "+N more"; only the first 20 fetch a last line.
- The page's Changes count shows only when the panel's active project is the page's.
- Rows added to the test ids: `project-new-folder-<id>` and `project-tasks-count`.
- `project-panel.js` lost about 535 lines, moved to `project-page.js`.

## Amendments

- `docs/design-workbench.md` was completed after the first commit truncated it at its first code fence.
- `test/unit/diff-viewer.test.js`: the fake Monaco gained `getLineChanges` and `onDidUpdateDiff` (for `diff-ask`). No assertion changed.
- `test/unit/changes-panel.test.js`: the tab list flipped to Files and Changes, as listed under "Specs that change on purpose".

## Amended by eve#195

The agent board gains states and groups. The design is the contract in eve#195; this section records what changes here.

- **Groups.** Rows sit in three groups, in this order, and a group with no rows shows no header. Each header shows a count of its full group.
  - Needs you: `asking`, `errored`, `stalled`.
  - Working: `running`, `idle`, `starting`.
  - Done: `ended`.
- **Rows.** A row is a terminal or a session, with one state dot. A terminal's state comes from its process: open is `running`; exit 0 or no code is `ended`; any other code is `errored`. A session's state comes from relay's `session_state` frames and the `attention` field on `GET /api/sessions`. Rows sort by label, then id, so they do not jump when a state changes inside a group. The 20-row cap fills Needs you first.
- **Done rule.** Done holds the sessions that reached `ended` in this page life. relay's list carries no `attention` for dead sessions, so after a reload an old thread cannot be told from a finished agent. A resumed session returns to Working on its `starting` frame.
- **Sessions are shown only once listed.** A `session_state` frame for an id that `GET /api/sessions` or `session_created` has not named never makes a row. Such a frame asks for one debounced list refresh. This keeps hidden `__search:` sessions and failed launches from other devices off the board, because a frame carries no name and no project.
- **Phone badge.** The bottom bar's Today button shows the Needs-you count, using Today's mode filter, and hides at 0. Today is the compact root and holds the agents part; Threads opens one project's page and Projects opens a sheet with no board. The button's accessible name stays "Today".
- **Motion.** Only `running` and `asking` animate. Reduced motion turns all of it off.

## Amended by eve#196

A headless Claude session under Needs you gets a Drop in action under its row, on Today and on the project page.

- **Rule.** `AgentBoard.showsDropIn` is the one place: a session row whose model is `haiku`, `sonnet` or `opus` (relay's own Claude rule), that relay lists as headless, and that sits in Needs you or has a drop-in in flight.
- **Wire.** `POST /api/sessions/:id/drop-in` with `{cols:80, rows:24}` through `proxy()`. On 201 the board hands relay's `terminal` to `TerminalManager.openDropIn`, which does what the WS create path does: `onTerminalCreated`, then `join_terminal`. A refusal shows relay's `message` as a toast. There is no client timeout.
- **Closing.** Closing the tab uses the existing `terminal_close`; relay hands the conversation back.
- **Markup.** A row with the action sits in `.agent-row-wrap` beside its own button; other rows are unchanged.

## Amended by eve#274

The board becomes the shared component for a third mount, the Chief of Staff rail and its phone sheet. Today and the project page keep their calls and defaults; the new groups and colours reach them without an edit to their parts.

- **Groups.** Four, in this order; an empty group shows no header.
  - Needs you: `asking`, `errored`, `stalled`.
  - Working: `running`, `starting`.
  - Idle: `idle` (it was inside Working).
  - Done: `ended`.
- **Colours.** One meaning each. Red (`--danger`): `asking` (blinks), `errored`, and `stalled` (a 2px ring on a transparent fill). Amber (`--warning`): `running` (ring pulse) and `starting` (it was grey). Green (`--success`): `idle`. Grey (`--text-muted`): `ended`. The phone badge on Today turns `--danger`. Reduced motion stops every animation.
- **State words.** `AgentBoard.STATE_WORDS` maps a state to its plain words (for example `asking` to "Waiting on you"). `AgentBoard.ago(sinceIso, nowMs)` gives '' for an invalid time, then `now`, `4m`, `2h`, `3d`.
- **Rows.** A row gains `since`, the ISO time of the session's last state change ('' for a terminal).
- **Options.** All default to the old behaviour.
  - `maxRows` (default 20): `Infinity` means no cap and no "+N more".
  - `layout` (default `board`): `rail` is three lines. Line 1 has the dot, label and age (`{p}-agent-age-{id}`, sessions only). Line 2 has `{p}-agent-meta-{id}`, "project · words" (terminals keep `open` / `exited N`). Line 3 is `{p}-agent-line-{id}` with `data-kind` and `data-source`: a terminal's live last line in mono; for a session, an alert note under Needs you, or a summary note under Idle and Done (prose for `model`, mono for `pending` and `template`). Working sessions have no line 3. Agent text goes in with `textContent`.
  - `collapseDone` (default off): the Done header is a toggle button (`{p}-agents-group-done-toggle`, `aria-expanded`) and the list stays out of the DOM until opened. The state is per board instance.
  - `note(sessionId)`: the line-3 source.
  - `onCounts({needs, working, idle, done})`: called on each render, with zeros when empty and `null` when relay is unreachable or the list is loading.
  - `onOpen(row)`: called after a row tap or Drop in.
- **Rail headers.** In the rail layout each group header has `tabindex="-1"` and the test id `{p}-agents-group-{key}-head`, so "N need you" can scroll to it and focus it.
- **Touch.** Rail rows and the Done toggle are at least 44px high under `(pointer: coarse)`.
