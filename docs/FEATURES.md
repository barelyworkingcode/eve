# eve feature map

What a person uses eve for, the features that serve each goal, and the devbox
journey that covers it. Journeys follow goals end to end, so priority is set
per goal, not per feature. G1–G7 and G16 are must-have; each has a journey.

Derived from the code (`routes/`, `ws/`, `public/`, `slash-command-handler.js`,
`mcp/`) and `docs/`. "Journey" means what a journey in
`devboxverify/journeys.js` or `devboxverify/journeys-auth.js` actually
asserts, not what its name suggests.
Per-journey locators and traps live in [devboxverify/README.md](../devboxverify/README.md#feature-map).

**Owner gate** marks a step that needs the owner's credential or presence:
a passkey ceremony, a presence-gated relay action, a tool-permission answer.
An agent inside the product must never complete it. The devbox verify
harness may, with the operator's test credentials. Each owner gate has a
positive journey (the harness passes it as the owner would) and a negative
journey (an in-product agent tries the same step and is refused and
audited). Never an API or flag that skips it. See [Owner gates](#owner-gates).

## Goals

| # | Goal | Intent | It worked when… | Areas | Priority | Journeys |
|---|---|---|---|---|---|---|
| G1 | Get in and see my work | Open eve and land where my projects are | Home greets me, my projects are in the rail and on Home, no passkey prompt on a trusted network; off it, my passkey signs me in and an agent can't get in | auth, home, projects | **must-have** | landing-view, world-projects-listed, passkey-sign-in, agent-sign-in-refused |
| G2 | Ask about my project and get an answer | Start a chat in a project and get a reply | My question shows, a reply streams in and settles, Stop works, errors show in the thread | chat | **must-have** | chat-reply (with Stop) |
| G3 | Pick up where I left off | Reopen a thread from yesterday or another device | The thread opens from Home, Project page or ⌘K with its history, and no new session is made | chat, home | **must-have** | open-existing-thread (Project page, Home Continue, ⌘K) |
| G4 | Work in a shell on my project | Open a terminal in the project and run things | A terminal opens only when asked, runs my command, and is still there after a reload | terminal | **must-have** | terminal-on-request (with reload) |
| G5 | Hand a task off and come back later | Give an agent a job, on demand or on a schedule | The task is saved, runs when told, and its last run is readable afterwards | tasks | **must-have** | task-created-listed (with Run Now and history), routine-from-thread |
| G6 | Check what my agents did | Come back and see what ran and what changed | A task's run is readable afterwards; the Changes tab lists edited files and the diff opens | tasks, git | **must-have** | task-created-listed (run and history), routine-touched, changes-diff |
| G7 | Read and edit project files | Browse, open, change and save a file | The tree lists the project, a file opens in the editor, Save persists it, an outside edit is flagged | files | **must-have** | file-edit-save |
| G8 | Let an agent act, under my control | Agents use tools only as the project's policy and my answers allow | Mode banner is right; a tool call in a gated mode raises the prompt; plan mode waits for Approve | chat, projects | should | none yet — answering the prompt is relay's owner gate; the prompt appearing is journey-checkable |
| G9 | Talk hands-free | Start a voice chat and converse | The voice view opens (incl. the `#/voice-chat` deep link), speech is transcribed, replies are spoken | voice | should | voice-deep-link (view opens, one session; no audio) |
| G10 | Find something in my project | Locate text or a thing I did before | Search returns matches and opens them; ⌘K finds sessions, projects, files | search, home | should | none yet — not written |
| G11 | Share files and images with the model | Give the model a file, see images it makes | Attached/pasted/dropped files reach the turn; images render and open fullscreen | chat, files | should | none yet — not written |
| G12 | Set up and tune a project | Create a project and set its templates, models and policy | A new project appears in the rail; template and policy edits take effect on the next launch | projects | should | project-mode-new (a `verify-<nonce>` project it creates and deletes), project-admin-in-relay |
| G13 | Work on a project on another machine | Use an SSH-host project like a local one | Host shows connected; files, terminals and Changes work against the host | hosts, files, terminal, git | should | none yet — needs an SSH host in the devbox world |
| G14 | Arrange my workspace | Tabs, splits, sidebar, theme and fonts the way I like | Tabs switch and close, a split docks and undocks, settings persist | shell, settings | later | none yet — pixel baselines and e2e cover layout |
| G15 | Use eve from my phone | The iOS app and mobile Safari | Sign-in via Safari fallback, keybar, swipe, Action Button deep link | auth, voice, terminal | later | none yet — native app needs a devbox pass, not Playwright |
| G16 | Let a new browser in, or remove one | Enrol a second device, revoke a lost one | The first passkey claims eve; another browser enrols only inside relay's window, never by an agent; a revoked passkey fails its next login | auth | **must-have** | passkey-first-enrol, add-browser-in-window, agent-enrol-refused; revoking: relay |

## Owner gates

| Gate | Protects | Enforced by | Positive journey | Negative journey | Audited in | Journeys owned by |
|---|---|---|---|---|---|---|
| Passkey sign-in | eve's UI, API and WS off the trusted network | eve `routes/auth.js` login, `routes/index.js` `requireAuth` | passkey-sign-in | agent-sign-in-refused | relay's eve-verify service log: `Login finish failed` | eve |
| Add a browser | a new credential on an owned eve | relay window (`eve.enrolment.open`) + eve `requireEnrollable` and consume | add-browser-in-window (screen) | agent-enrol-refused | relay's eve-verify service log (nothing recorded today, a known bug) + `relay audit` consume row | eve side: eve; opening the window: relay |
| Open the enrolment window | the window | relay presence gate | relay | relay | `relay audit` | relay |
| Revoke an eve passkey | a lost browser's access | relay `eve.passkey.revoke` + eve login-time `checkRevoked` | relay | relay | `relay audit` | relay; eve's revoked-passkey-refused is blocked: relay keeps one global eve passkey mirror, so a verify eve can't be revoked without disturbing the live eve |
| Answer a tool-permission prompt | a gated tool call | relay-sessions + relay sandbox | relay | relay | relay | relay |
| First enrolment (bootstrap, not an owner gate) | claiming an unowned eve | eve pre-enrolment gate | passkey-first-enrol | none; unit and integration tests cover the public-IP refusal | — | eve |

Plan approval is not a gate: Approve sends a user turn.

The negative journeys' in-product agent is a relay session: the World probe
terminal in Acme Corp typing a fixed `curl` line at eve-verify with
no token. Deterministic, no model.

## Features by goal

Columns: **Lives in** (UI surface / API / CLI / tray) · **How reached** ·
**Journey** · **Areas**.

### G1 · Get in and see my work

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Trusted-network bypass of the passkey screen | API: `trusted-network.js`, `GET /api/auth/status` | Open eve from loopback or a trusted subnet | none — unit and integration tests only; journeys run signed in | auth |
| Passkey sign-in | UI: `#authScreen`, `public/auth.js`; API: `/api/auth/login/*` | Open eve off the trusted network, Sign In | **owner gate**: passkey-sign-in (+), agent-sign-in-refused (−) | auth |
| Today: a host that lays out independent parts (summary, Ask, Needs you, Start, Continue, Running, Routines, Projects) for the current mode; a failing part shows one line with Retry, a slow one a skeleton | UI: `public/home-screen.js`, `public/today/**` (design: `docs/design-today-s1.md`) | Open eve with no tab open | landing-view (greeting, tiles); none yet for part failure/slowness — cloud specs `goals/today-parts` | home |
| Today Morning brief card: one tap sets up a daily 07:00 routine named `Morning brief` (local `chat` models only); then mail needing a reply, plus events, reminders and weather where Relay grants those tools, with Refresh and Open. Brief text is untrusted and shown as plain text; a hostile mail can't make it send or fetch (design: `docs/design-brief.md`) | UI: `public/today/parts/brief-part.js`, `public/today/brief.js`; API: `POST /api/tasks`, `POST /api/tasks/:taskId/run` | Today | brief-injection-refused (hostile mail: only reads succeed, `mail_send`/`web_fetch` denied); cloud specs `goals/today-brief` | home, tasks |
| Listen on the Morning brief card (`today-brief-listen`): with Refresh and Open shown, one tap speaks the brief as shown, in card order; reads Stop while speaking; hidden while refreshing, failed, unreadable, in setup or empty ([design-on-the-go.md](design-on-the-go.md)) | UI: `public/today/parts/brief-part.js`; WS `tts_speak` | Today → Morning brief → Listen | cloud specs `goals/today-brief`; test-machine pass for the audio | home, voice |
| Ask box: Return starts a thread in the mode's default project, no dialog; Return while eve is still starting queues the Ask ("Sending when eve is ready…") and sends it once ready | UI: `public/today/parts/ask-part.js`; WS `create_session`, `user_input` | Today, focused on open on fine pointers; never focused on touch, a tap focuses it (#129) | none yet — cloud specs `goals/today-ask` | home, chat |
| Needs you / Running: waiting, failed and running threads and routine runs, from frames eve receives; a failed routine shows its reason, and "Can't reach the scheduler." when relayScheduler is down | UI: `public/today/parts/needs-you-part.js`, `running-part.js`; `public/core/session-activity.js` | Today | none yet — cloud specs `goals/today-truth` | home |
| Home \| Work switch; lists show only projects whose mode includes it | UI: `public/sidebar/mode-switch.js`, `core/mode.js`, `StateStore.getModeProjects`; API: `mode`, `default_for` on `GET /api/projects` | Sidebar panel header | world-projects-listed (checks each mode shows only its projects); cloud specs `goals/today-mode`; real enforcement is relay's | home, projects |
| First-run "Create a project" | UI: `public/today/parts/projects-part.js` (`.home__first-run`) | Open eve with zero projects | none yet — world always has projects | home, projects |
| Project chips on Home | UI: `public/today/parts/projects-part.js`; API: `GET /api/projects` | Home | world-projects-listed | home, projects |
| Project rail | UI: `public/sidebar/activity-rail.js` | Left rail | world-projects-listed | projects |
| Project panel (Files / Changes; a stored `sessions` or `tasks` tab opens Files) and its Project page button | UI: `public/sidebar/project-panel.js` | Click a project in the rail | chat-reply etc. (as setup, not a verdict); cloud spec `goals/workbench-page` | projects |
| Project page: one main-area tab per project (`#project/<id>`, not persisted) with the header (name, where it lives, path), New thread (`project-new-thread-<id>`), Agents, Threads and Routines sections with counts (each routine reads as a sentence with its last result; an All routines link opens `#routines`), and Files and Changes rows that open the panel on that tab; an unknown id says "Project not found." | UI: `public/project-page.js`, `panes/project-pane.js`, `routine-history.js`, `core/routine-sentence.js`, `apple/project-page.css`; `app.js` `#project/` route | Panel header button `panel-project-page`, the deep link, compact bottom bar Threads | open-existing-thread, task-created-listed (their door); cloud spec `goals/workbench-page` | projects, home |
| `/<project-slug>/` URL scoping | API: `server.js` SPA route | Open `/<slug>/` | none yet — not written | home |
| Connection banner and reconnect | UI: `#connectionBanner`; `relay-client.js` upstream self-heal | Relay drops and returns | none yet — needs a controlled relay drop | shell, core |
| Bad-network reload banner | UI: inline in `public/index.html` | A script fails to load | none yet — later | shell |

### G2 · Ask about my project and get an answer

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Session launcher, Web Chat form | UI: `public/dialogs/shell-launcher-dialog.js` | Project panel New Session, Home Chat tile, ⌘K New session | chat-reply | chat |
| Model picker (filtered by `allowed_models`, which are set in Relay) | UI: launcher `launcher-model-select`; API: `GET /api/models` | Launcher Web Chat form | chat-reply (picks one); cloud spec `goals/g12-projects` (only allowed models) | chat, projects |
| Chat templates in the launcher | UI: launcher cards; project Templates tab | Launcher | none yet — World voice card used only by voice-deep-link | chat, projects |
| Per-provider chat defaults | UI: `ShellLauncherDialog#_launchSession` `applyChatDefaults` | Any web/voice launch | none yet — e2e `chat-defaults.spec.js` only | chat |
| Send a message (Enter / Shift+Enter) | UI: `public/features/chat-form.js`; WS `user_input` | Composer | chat-reply | chat |
| Streaming reply, Markdown, code, Mermaid | UI: `public/message-renderer.js` | Any reply | chat-reply (non-empty reply only) | chat |
| Stop generation | UI: `chat-stop`; WS `stop_generation` | Stop button while replying | chat-reply (clicks Stop mid-reply) | chat |
| Same chat open in two browsers | UI: `message-dispatcher.js` (`user_message` from another viewer) | Open one thread in a second browser, send from either | none yet — needs two browser contexts and a turn long enough to Send into; unit `message-dispatcher-stale-submit.test.js` only | chat |
| Research sources: a row of source cards above an answer that used `brave_web_search`; matching links become numbered chips; a chip or card opens title, excerpt and Open source (design: `docs/design-research.md`) | UI: `public/core/sources.js`, `public/citations.js`, hooked from `message-renderer.js` | Any reply whose turn searched the web | research-citations (needs the `Research` test project, setup R1); cloud spec `goals/research-citations` | chat |
| Pasted links as sources: pasting one http(s) URL into Ask or the chat input makes a removable chip (`today-ask-url-<n>`, `chat-url-<n>`; at most 5, a repeat is one chip, anything else pastes as text); Send adds a fixed "Sources to read" block to the message and the thread shows the chips, not the block; where Relay grants `web_fetch`, the page read comes back as a source card (design: `docs/design-research.md`) | UI: `public/url-chips.js`, `public/core/source-urls.js`, `today/parts/ask-part.js`, `app.js`; WS `user_input` `urls` | Paste a link into Today's Ask or the chat box | ask-pasted-url; chat-pasted-url-source (needs the `Research` test project, setups R1 and R1b); cloud spec `goals/pasted-url-chips` | home, chat |
| Thinking, tool-use and agent blocks | UI: `message-renderer.js` | Replies that use tools or think | none yet — model-dependent | chat |
| Interactive question options | UI: `message-renderer.js` | Model offers choices | none yet — model-dependent | chat |
| Errors shown in the thread | UI: `message-system.error` | A refused or failed turn | chat-reply (classifies FAIL/BLOCKED) | chat |
| Slash commands `/clear`, `/help` | Server: `slash-command-handler.js` | Type in composer | none yet — not written | chat |
| Provider slash commands (`/model`, `/compact`, …) | Forwarded to relayLLM | Type in composer | none yet — not written | chat |
| Input history ↑/↓ | UI: `public/input-history.js` | Arrow keys in composer | none yet — later | chat |
| Cost stat | UI: `#costStat` | Chat header | none yet — later | chat |
| Rename / move to folder / delete a thread (the page's Threads section) | UI: `public/project-page.js` context menu; WS `rename_session`, `set_session_folder`, `delete_session` | Right-click a thread on the project page | none yet — cloud spec `goals/workbench-page` | chat, projects |
| End session | WS `end_session` | Session menu / voice End | voice-deep-link (button visible only) | chat |

### G3 · Pick up where I left off

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Project page → Threads → open thread with history (the Sessions tab is retired) | UI: `public/project-page.js`; `app.joinSession`; `message-dispatcher.js` | Panel Project page button, click a thread; on compact, bottom bar Threads | open-existing-thread (Project page door) | chat, projects |
| Home "Continue" list | UI: `public/today/parts/continue-part.js`; `core/session-recents.js` | Home | open-existing-thread (Continue row) | home, chat |
| ⌘K jump to session / project / tab / recent file | UI: `public/dialogs/command-palette.js` | ⌘K | open-existing-thread (session by title) | home |
| Launcher Resume tab (running chats and terminals) | UI: `shell-launcher-dialog.js` | Launcher → Resume | none yet — not written | chat, terminal |
| Reopen tabs after reload (`eve-open-sessions`, `eve-open-files`) | UI: `tab-manager.js`, localStorage | Reload eve | none yet — README notes it as a trap | shell |
| Session labels from first turn | UI: `core/ui-utils.js` `sessionDisplayName`, `session-recents.js` | Anywhere a session is listed | none yet — not written | chat, home |

### G4 · Work in a shell on my project

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Terminal templates per project | API: `GET /api/terminal/templates?project=` | Launcher cards | terminal-on-request | terminal |
| Open a terminal and run a command; a terminal relay already holds is listed on the agent board and opens on a tap, never by itself | UI: `public/terminal-manager.js`, `agent-board.js`; WS `terminal_create`, `terminal_input`, `terminal_list` | Launcher card, Home tile, rail New Terminal, agent board row (`today-agent-<terminalId>`, `project-agent-<terminalId>`) | terminal-on-request (after a reload: nothing opens by itself, the board lists it, a tap opens it) | terminal, home |
| Agent board: every live terminal with project (Today only), template, state ("open" or "exited <code>") and last line (the last non-empty, non-box-drawing line, at most 120 characters; xterm buffer, else the tail of the terminal log, at most one fetch per terminal per 15 s, 20 rows then "+N more"); "Can't reach relay", "No agents running"; task-run terminals excluded | UI: `public/agent-board.js`, `today/parts/agents-part.js`, `core/terminal-text.js`; `terminal-manager.js` `lastLineOf`; API: `GET /api/terminals/:id/log` | Home (Today part `agents`, both modes), project page Agents section | terminal-on-request (board lists the probe with a last line); cloud spec `goals/workbench-agents` | terminal, home, projects |
| No terminal until asked | — | Open a project | terminal-on-request | terminal |
| Slash `/zsh`, `/bash`, `/claude`, `/rh` | Server: `slash-command-handler.js` | Type in composer | none yet — not written | terminal, chat |
| Terminal survives reload / reconnect | WS `terminal_reconnect`, `join_terminal` | Reload with a terminal open | terminal-on-request (reload) | terminal |
| Resize / fit | WS `terminal_resize` | Resize window | none yet — later | terminal |
| Copy / paste, web links | UI: xterm addons | Select, paste, click a link | none yet — later | terminal |
| Paste an image into a terminal | API: `POST /api/terminal/paste-image`; `terminal-paste.js` | Paste or drop an image on a terminal | none yet — not written | terminal |
| Terminal scrollback log | API: `GET /api/terminals/:id/log` | Reopen a terminal | none yet — not written | terminal |
| Close a terminal | WS `terminal_close` | Close its tab | none yet — sweep closes them | terminal |
| Mobile keybar | UI: `public/terminal-keybar.js` | Terminal on a phone | none yet — G15 | terminal |

### G5 · Hand a task off and come back later

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Create a routine (name, prompt, model, when; Type is behind Advanced) | UI: `public/dialogs/task-dialog.js`; API: `POST /api/tasks` | Project page → Routines → New (`project-task-new-<id>`) | task-created-listed (page Tasks door) | tasks, projects |
| Routine listed (`project-task-<taskId>`, count `project-tasks-count`) as a sentence (`core/routine-sentence.js`), persists across reload | UI: `public/project-page.js`, `task-manager.js`; API: `GET /api/tasks` | Project page → Routines | task-created-listed | tasks, projects |
| Schedule types (daily, hourly, interval, weekly, cron, once, on demand) | UI: task dialog; `core/task-schedule.js` | Task dialog Schedule | none yet — journey uses On demand only | tasks |
| Enabled / Catch up missed runs | UI: task dialog | Task dialog | none yet — not written | tasks |
| Run a task now | API: `POST /api/tasks/:taskId/run` | Task list action | task-created-listed (Run Now) | tasks |
| Routines page: every routine across projects, one `#routines` tab (not persisted, not on the rail), a row opens a sheet with the sentence, last result and Relay tool calls | UI: `public/routines-page.js`, `panes/routines-pane.js`, `routine-audit.js`, `routine-history.js`; `app.js` `#routines` route | ⌘K, project page All routines link, the deep link | task-created-listed (the new routine is listed with "When I ask"); cloud specs `goals/routines-page` | tasks, projects |
| Make this a routine: the chat header button `thread-make-routine` (shown only on a thread with a first prompt, hidden on voice threads and routine runs) opens a panel pre-filled from the thread | UI: `public/routine-panel.js`; API: `POST /api/tasks` | Chat header | routine-from-thread; cloud specs `goals/routines-make` | tasks, chat, home |
| Edit / delete a task | UI: task dialog; API: `PUT`/`DELETE /api/tasks/:taskId` | Task list | none yet — delete uses native `confirm()` | tasks |
| Task events live (`/ws/tasks`) | `relay-client.js#_connectScheduler` | Tasks tab while a run happens | none yet — not written | tasks, core |

### G6 · Check what my agents did

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| The Morning brief's last run is its card on Today (Open shows the run); a failed brief still appears in Needs you | UI: `public/today/parts/brief-part.js`, `public/task-viewer.js` | Today → Morning brief → Open | brief-injection-refused; cloud specs `goals/today-brief` | home, tasks |
| Routine-failure notifications (background, not user-visible yet): a `task_error` from relayScheduler appends one line to `notifications.jsonl` in the data dir, with or without a browser open; nothing leaves the machine ([design-on-the-go.md](design-on-the-go.md)) | Server: `notifier.js`, `routine-failure-watcher.js` (own `/ws/tasks` socket) | Background; read the file | routine-failed-notifies; integration `routine-failure-notify` | tasks |
| View a task's last or live run | UI: `public/task-viewer.js`; API: `GET /api/tasks/:taskId/history` | Project page → Tasks → a task | task-created-listed (last run after reload) | tasks |
| Today Routines part: routines that finished in the last 24 h, newest first, unseen ones marked (seen is per device, `eve-routines-seen`); hidden when none | UI: `public/today/parts/routines-part.js`, `routine-history.js` | Today | cloud specs `goals/routines-today` | home, tasks |
| What a routine's project called through Relay (sheet section; `call_tool` rows, allowed or denied; Claude Code's built-in tools never appear) | UI: `public/routine-audit.js`, `project-audit.js`; API: `GET /api/projects/:id/audit` | Routine sheet | routine-touched; cloud spec `goals/routines-audit` | tasks, terminal |
| Running indicators (Today dot and count, rail and panel dots): a turn in progress in a joined thread or an executing task run; a live idle process shows none | UI: `public/today/**`, `project-panel.js`, `project-page.js`, `activity-rail.js`; `core/session-activity.js` | Home, rail, project page | none yet — cloud specs `goals/today-truth` | home |
| Changes tab (repos, worktrees, counts) | UI: `public/sidebar/changes-panel.js`; WS `git_changes` | Project panel → Changes | changes-diff | git |
| Uncommitted / vs base scope | UI: changes-panel scope toggle | Changes tab | none yet — not written | git |
| Diff pane (side-by-side / inline) | UI: `public/diff-viewer.js`, `panes/diff-pane.js`; WS `git_file_versions` | Click a changed file | changes-diff | git |
| Ask about this on a diff: the toolbar button `diff-ask` attaches a unified diff of that file in the pane's scope (3 lines of context; not for binary or too-large diffs, not for host projects); enabled once Monaco has computed the diff | UI: `public/diff-viewer.js`, `today/ask-about.js`, `core/unified-diff.js` | Diff pane toolbar | none yet — cloud spec `goals/workbench-ask-about`; journey `ask-about-file` covers the file door only | git, home |
| Live `git_changed` refresh | `file-watcher.js`, `dir-watcher.js` | Edit a file while Changes is open | none yet — not written | git, files |
| Remote sessions: view / reattach / kill | UI: `public/remote-sessions.js`; API: `/api/projects/:id/persistent-sessions` | Host project | none yet — G13 | hosts, terminal |

### G7 · Read and edit project files

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| File tree browse | UI: `public/file-browser.js`, `sidebar/project-tree.js`; WS `list_directory` | Project panel → Files | file-edit-save | files |
| Open a file in the editor | UI: `public/file-editor.js` (Monaco); WS `read_file` | Click a file | file-edit-save | files |
| Ask about this on a file: the tree context menu item (files only, not folders, not host projects) opens Today with Ask focused and a removable chip (`today-ask-attachment`); Return starts one thread in the file's project with the file text attached; over 256 KB gives "That's too large to attach (over 256 KB)."; a binary file says "That isn't a text file." | UI: `public/sidebar/file-tree-node.js`, `today/ask-about.js`, `today/parts/ask-part.js`; `app.sendUserText`; API: `api.getFileText` (`GET /api/files/:projectId/*`) | Tree context menu → Ask about this | ask-about-file; cloud spec `goals/workbench-ask-about` | files, home, chat |
| Save (⌘S / Save) | WS `write_file` | Edit, ⌘S | file-edit-save | files |
| Live file watching (tree refresh, `watch_error` toast when the watcher cannot start) | `file-watcher.js`, `dir-watcher.js`; WS `dir_changed`, `watch_error` | Change a file on disk | none yet — not written | files |
| External change banner (Reload / Keep) | UI: `file-editor.js`; WS `watch_file` | File changes on disk while open | file-edit-save (clean editor updates; dirty editor shows the banner, Reload) | files |
| Markdown / HTML preview, Edit/Split/Preview | UI: `file-editor.js`, `html-preview-pane.js` (sandboxed iframe) | Open `.md`/`.html` | none yet — not written | files |
| Image / PDF / video / audio viewers | UI: `public/viewers/*`; API: `GET /api/files/:projectId/*` | Click such a file | none yet — not written | files |
| Rename / move / delete / new folder | WS `rename_file`, `move_file`, `delete_file`, `create_directory` | Tree context menu, drag | none yet — not written | files |
| Upload by dropping on the tree | WS `upload_file` | Drag files onto the tree | none yet — not written | files |
| Show hidden files | UI: Settings sheet → Files (`settings-hidden-files`) | Settings | none yet — cloud spec `goals/settings-sheet` | files, settings |
| Plan file viewer | WS `read_plan_file` | Plan-mode plan link | none yet — not written | files, chat |

### G8 · Let an agent act, under my control

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Permission prompt (Allow / Deny / Allow All) | UI: `#permissionModal`, `modal-manager.js`; WS `permission_response` | Agent calls a gated tool | **owner gate** (answer): relay's; prompt appearing: none yet | chat |
| Plan approval bar (Approve / Revise) | UI: `#planApprovalBar` | Plan mode proposes a plan | none yet — not a gate: Approve sends a user turn | chat |
| Permission mode banner and control | UI: `message-renderer.js`; WS `set_permission_mode` | Chat header | none yet — not written | chat |
| Project permission policy | relay Settings on the Mac; eve's project dialog has no Permissions tab and never sends `permission_policy` | Relay | project-admin-in-relay (no tab; Save keeps relay's policy) | projects |
| Ask in the other mode: when a tool call in a text thread is refused (relay's `access denied: `, or macMCP's scope check), the chat header shows `thread-ask-elsewhere` ("Ask in Work" or "Ask in Home"); a tap switches mode and opens a new thread in that mode's project with the last question. The first thread is untouched ([design-mode-presets.md](design-mode-presets.md)) | UI: `public/ask-elsewhere.js`, `core/refusal.js`, `message-dispatcher.js`; WS `create_session`, `user_input` | Chat header, after a refusal | ask-in-other-mode; cloud specs `goals/ask-elsewhere` | chat, home |
| Agent-opened image tabs (`eve-control` MCP) | `mcp/main.js`, `ui-command-bus.js`, `POST /internal/ui-command` | Agent calls `eve_open_tab` | none yet — model-dependent | ui-control |

### G9 · Talk hands-free

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| `#/voice-chat` deep link: resumes the voice thread on screen, or one in this mode younger than 30 minutes, else launches the mode's voice preset; with no preset it toasts and opens the launcher's Voice Chat form ([design-mode-presets.md](design-mode-presets.md)) | UI: `app.js` `_handleHashRoute`, `_launchModeVoice`; `core/mode-presets.js` | Open `#/voice-chat` | voice-deep-link; cloud spec `goals/mode-presets` | voice, projects |
| Voice chat from launcher / Home Voice tile | UI: `public/voice-chat-manager.js` | Voice tile, launcher Voice card | none yet — deep link only | voice |
| Speech to text (push-to-talk, hands-free, Space) | UI: `stt-manager.js`, `vad-manager.js`; WS `transcribe_audio`; `stt-service.js` | Hold mic / Space | none yet — needs the live STT daemon | voice |
| Spoken replies, per-message play; on a touch device (coarse pointer) the Read aloud button shows on every answer without hover, at least 44×44 | UI: `tts-manager.js`, `.tts-play-btn`, `public/apple/chat.css`; WS `tts_speak`; `tts-service.js` | Reply, play button | listen (button visible and tap sends `tts_speak`; audio not judged); cloud spec `goals/listen` | voice, chat |
| Voice drawer (voice, speed) | UI: `#voiceDrawerPanel`; API: `GET /api/tts/voices` | Composer voice drawer | none yet — e2e covers the drawer | voice |
| Convert voice → text chat, End session | UI: `#voiceChatConvert`, `#voiceChatClose` | Voice view buttons | voice-deep-link (End visible only) | voice |
| Orb settings, crash guard | UI: `voice-orb-settings.js`, `voice-crash-guard.js` | Voice view | none yet — later | voice |

### G10 · Find something in my project

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Search in files (glob, regex, whole word) | UI: `public/dialogs/search-dialog.js`; WS `search_project`; `search-service.js` | ⌘⇧F, ⌘K Search | none yet — not written | search |
| Ask about this on search results: `search-dialog-ask` closes the dialog and attaches the shown matches (at most 200) as `path:line: text` lines; chip reads "N results for …" | UI: `public/dialogs/search-dialog.js`, `today/ask-about.js` | Search dialog | none yet — cloud spec `goals/workbench-ask-about` | search, home |
| AI summary of results | WS `search_ai_summarize`; `search-summarizer.js` (hidden `__search:` session) | Search dialog checkbox | none yet — model-dependent | search, chat |
| Command palette actions | UI: `command-palette.js` | ⌘K | none yet — not written | home |

### G11 · Share files and images with the model

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Attach / paste / drop files on the composer | UI: `file-attachment-manager.js`, `features/file-attachments.js` | Attach button, paste, drop | none yet — not written | chat |
| Unsupported type rejection | UI: `file-attachment-manager.js` | Attach video/audio | none yet — later | chat |
| Inline and generated images, fullscreen viewer | UI: `message-renderer.js`; API: `GET /api/generated/:filename` | Image in a reply | none yet — model-dependent | chat |

### G12 · Set up and tune a project

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Create / edit / delete project (name, Where among existing hosts, path) | UI: `public/dialogs/project-dialog.js`; API: `/api/projects` | Rail +, ⌘K New project, panel menu | project-mode-new (create, edit; deletes through the API) | projects |
| Project mode Home \| Work \| Both (`project-mode`): a new project starts at Both; create always sends `mode`, an edit only when it changed; the rail, Today and ⌘K re-filter with no reload | UI: project dialog General; API: `POST /api/projects`, `PUT /api/projects/:id` (`mode`) | New Project, Edit Project | project-mode-new; cloud spec `goals/g12-projects` | projects, home |
| Mark a template as a mode's Ask or voice preset (`project-template-preset-home`, `project-template-preset-work`; one Ask and one voice preset per mode; badges in the list) | UI: project dialog Templates; API: `preset_for` on `chat_templates` | Edit Project → Templates | mode-presets; cloud spec `goals/mode-presets` | projects, chat |
| Chat templates tab | UI: project dialog Templates | Edit Project | none yet — world setup S3 is manual | projects, chat |
| Terminal templates | API: `/api/terminal/templates` | Edit Project / tray | none yet — world setup | projects, terminal |
| Allowed models, read-only (`project-allowed-models`: "All models" or the labels), with "Set in Relay Settings on your Mac." (`project-relay-pointer`); models and MCPs are set in Relay, and Save never sends `allowed_models` or `allowed_mcp_ids` | UI: project dialog General | Edit Project | project-admin-in-relay; cloud spec `goals/g12-projects` | projects |
| Regenerate Skills | relay (no longer in eve's project menu) | Relay | none — relay-owned | — |
| Per-tool MCP scoping, token rotation | relay tray Projects tab | Relay tray | none — relay-owned | — |

### G13 · Work on a project on another machine

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Add / probe / remove SSH host | relay; eve's Where only picks an existing host (`project-where-host-<id>`) | Relay | none — relay-owned; project-admin-in-relay checks there is no Host… | — |
| Host status (connecting / connected / unreachable) | WS `host_status`; `ssh-host-pool.js` | Rail, panel | none yet | hosts |
| Files, search, Changes on the host | `remote-file-service.js`, `remote-fs-agent.js` | Host project Files / Changes | none yet | hosts, files, git |
| Host terminals and persistent (tmux) sessions | API: `/api/projects/:id/persistent-sessions` | Host project launcher | none yet | hosts, terminal |

### G14 · Arrange my workspace

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Tab bar, close tab ⌘W | UI: `public/tab-manager.js` | Tabs | none yet — e2e `tab-panes.spec.js` | shell |
| Split pane dock / undock / resize | UI: `core/pane-dnd.js`, `core/split-resize.js`, `panes/*` | Drag a tab onto another | none yet — e2e | shell |
| Sidebar toggle, resize, swipe | UI: `app.js` | Hamburger, drag, swipe | none yet — later | shell |
| Layouts by width: wide (≥ 1024) as before; regular (600–1023) with the sidebar as a slide-over and Today and chat at most 720px, centred; compact (< 600) with no tab bar | UI: `public/core/layout.js` (`data-layout`), `public/apple/*.css` media queries (design: `docs/design-today-s2.md`) | Open eve at that width, or resize | today-ipad-portrait (regular: rail out of view, `.main` full width, `#homeContent` ≤ 720 and centred, no overflow); today-phone (compact); cloud specs `layout-breakpoints`, `layout-overflow` | shell, home |
| Slide-over sidebar on regular, over a scrim; the scrim or any navigation closes it | UI: `#sidebarScrim`, `app.js` `closeSidebarOnMobile`, `core/layout.js` | Menu button on Today or in a chat | today-ipad-portrait (menu opens it, scrim closes it) | shell |
| Bottom bar (Today, Threads, Projects) on compact Today; Threads opens the sheet on Sessions | UI: `nav#bottomBar`, `app.js`, `ProjectPanel.openTab` | Open eve on a phone | today-phone (bar on Today, hidden in a thread) | shell, home |
| Push navigation on compact: Today → thread → Back (in-app `nav-back` or browser Back) shows Today; the thread's tab stays open | UI: `#navBack`, `#navTitle`, `core/layout.js` `navigate`/`back`, `tab-manager.js` `_updateHash` | Open a thread from Today on a phone | today-phone (Back with the hash cleared, `goBack()` to Today, no leftover overflow); cloud spec `layout-nav` (no hash after either Back) | shell, chat |
| Home \| Work wordmark: one control moved between slots, in the sidebar panel on wide and at the top of Today on regular and compact | UI: `public/sidebar/mode-switch.js`, `[data-wordmark-slot]`, `#modeSwitch` | Any width | today-ipad-portrait (reads `Home\|Work` in Today); cloud specs `layout-breakpoints` | home, shell |
| Thumb-sized targets: under a coarse pointer every visible control is at least 44×44 at every width (links in message prose excepted) | UI: `public/apple/touch.css` | Any touch device | today-ipad-portrait, today-phone (sweep of visible controls); cloud spec `layout-touch` | shell |
| Front door: opening eve after 60 minutes or more away shows Today with Ask focused (fine pointers only, #129) and restores no tabs; a deep link still wins; resuming a page after that gap returns to Today and keeps tabs | UI: `public/core/front-door.js`, `app.js`; localStorage `eve-last-active` | Open or resume eve after a break | none yet — a journey would need to age the stamp; cloud spec `layout-front-door`, unit `front-door` | home, shell |
| Appearance Auto / Light / Dark and Text size (no theme presets, colours, fonts or reset; stored values keep applying) | UI: Settings sheet → Display (`settings-appearance-*`, `settings-text-size`) | Settings, ⌘K Appearance | settings-sheet (Light survives a reload); cloud spec `goals/settings-sheet` | settings |
| Settings sheet: one scrolling sheet, no tabs: Display, Voice (voice and speed, shared with the composer drawer; engine pickers in the native app only), Modes (each mode's default project and, under it, its Ask and voice presets, read-only), Files, then "Models, tools, hosts and permissions live in Relay on your Mac."; Done or Escape closes it | UI: `public/dialogs/settings-dialog.js`, `tts-manager.js` (`setVoice`, `setSpeed`) | Rail Settings, ⌘K Settings | settings-sheet; mode-presets; cloud specs `goals/settings-sheet`, `goals/mode-presets` | settings, voice |

### G15 · Use eve from my phone

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Safari passkey fallback | API: `GET /api/auth/safari-login`; iOS `ASWebAuthenticationSession` | iOS app sign-in | **owner gate** (passkey sign-in); none yet — native app needs a devbox pass | auth |
| Action Button → `#/voice-chat`, opening the current mode's voice preset (there is no per-device favourite) | iOS app + hash route | Action Button | voice-deep-link (the route, from a desktop browser) | voice |
| Native voice backends, haptics | UI: `native-audio-bridge.js`, `*-native-backend.js` | iOS app | none yet — devbox pass, not Playwright | voice |
| Mobile keybar, touch scrollback, soft-keyboard resize | UI: `terminal-keybar.js`, `terminal-manager.js` | Terminal on a phone | none yet — later | terminal |

### G16 · Let a new browser in, or remove one

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| First passkey enrolment (bootstrap from trusted network) | UI: `#authScreen`; API: `/api/auth/enroll/*`; `enrollment-gate.js` | First visit | passkey-first-enrol (bootstrap, not an owner gate) | auth |
| Add a browser inside relay's 5-minute window | `enrollment-window.js`; relay tray "Allow Eve Passkey Enrolment…" / `relay eve enrol` | Tray, then eve | **owner gate**: add-browser-in-window (+, screen), agent-enrol-refused (−); opening the window: relay | auth |
| List / revoke passkeys | relay tray Passkeys / `relay eve revoke`; `passkey-sync.js` | Relay tray | **owner gate**: relay; eve's revoked-passkey-refused blocked (one global relay passkey mirror) | auth |

Operator surfaces (`npm run relay:restart`, `register`, `start:secure`,
`ssl`, `verify:devbox`) are not user goals and get no journey.

## Areas

A stable name per area, the code and tests that belong to it, and the journeys
that exercise it. A future change-scoped runner maps changed files → areas →
tests and journeys. `core` is cross-cutting: a change there means a full run.

```yaml
areas:
  core:
    code: [server.js, ws-handler.js, ws/message-registry.js, ws-origin.js, relay-client.js, relay-transport.js,
           launch-identity.js, routes/index.js, security-headers.js, rate-limiter.js, session-store.js, logger.js,
           project-normalize.js, public/index.html, public/app.js, public/ws-client.js, public/message-dispatcher.js,
           public/core/**, public/styles.css, public/apple/tokens.css, public/apple/base.css,
           ws/diagnostics-messages.js, package.json, package-lock.json, jest.config.js, jest.integration.config.js,
           playwright.config.js]
    tests: ["test/**"]
    journeys: all
  auth:
    code: [auth.js, routes/auth.js, trusted-network.js, ip-host-guard.js, enrollment-gate.js, enrollment-window.js,
           passkey-sync.js, public/auth.js, public/auth.css, public/apple/auth.css]
    tests: [test/unit/auth-*.test.js, test/unit/routes-auth.test.js, test/unit/trusted-network.test.js,
            test/unit/ip-host-guard.test.js, test/unit/enrollment-*.test.js, test/unit/passkey-sync.test.js,
            test/integration/eve-passkey-enrolment.test.js, test/integration/passkey-sync-switch.test.js,
            test/integration/launch-identity.test.js, test/e2e/passkey-enrolment.spec.js]
    journeys: [landing-view, passkey-first-enrol, passkey-sign-in, agent-sign-in-refused, agent-enrol-refused, add-browser-in-window]
  home:
    code: [public/home-screen.js, public/today/**, public/agent-board.js, public/core/session-activity.js, public/core/mode.js,
           public/sidebar/mode-switch.js, public/core/front-door.js, public/dialogs/command-palette.js,
           public/apple/home.css, public/apple/palette.css]
    tests: [test/unit/command-palette.test.js, test/unit/session-recents.test.js, test/unit/session-activity.test.js,
            test/unit/today-parts.test.js, test/unit/mode.test.js, test/e2e/app.spec.js, "test/e2e/goals/today-*.spec.js",
            test/e2e/goals/home-screen.spec.js, test/e2e/goals/mode-presets.spec.js, test/e2e/goals/ask-elsewhere.spec.js]
    journeys: [landing-view, world-projects-listed, open-existing-thread, today-ipad-portrait, today-phone, ask-about-file, routine-from-thread,
               project-mode-new, brief-injection-refused, mode-presets, ask-in-other-mode, ask-pasted-url]
  shell:
    code: [public/tab-manager.js, public/panes/**, public/sidebar-renderer.js, public/modal-manager.js,
           public/toast.js, public/dialogs/dialog-base.js, public/apple/shell.css, public/apple/panes.css,
           public/apple/modals.css, public/apple/menus.css, public/apple/toast.css, public/apple/touch.css,
           public/core/layout.js]
    tests: [test/unit/tab-manager-logic.test.js, test/unit/pane-registry.test.js, test/e2e/tab-panes.spec.js,
            "test/visual/**"]
    journeys: [today-ipad-portrait, today-phone]
  projects:
    code: [public/dialogs/project-dialog.js, public/sidebar/activity-rail.js, public/sidebar/project-panel.js,
           public/project-page.js, public/panes/project-pane.js, public/apple/project-page.css,
           public/apple/sidebar-tree.css]
    tests: [test/unit/project-normalize.test.js, test/integration/projects.test.js, test/e2e/goals/g12-projects.spec.js,
            test/e2e/goals/mode-presets.spec.js]
    journeys: [world-projects-listed, project-admin-in-relay, project-mode-new, mode-presets, voice-deep-link]
  chat:
    code: [ws/session-messages.js, slash-command-handler.js, public/dialogs/shell-launcher-dialog.js,
           public/features/chat-form.js, public/features/permissions.js, public/features/file-attachments.js,
           public/message-renderer.js, public/citations.js, public/mermaid-loader.js, public/input-history.js,
           public/file-attachment-manager.js, public/url-chips.js, public/apple/chat.css, public/apple/chat-extras.css]
    tests: [test/unit/chat-*.test.js, test/unit/slash-command-handler.test.js, test/unit/input-history.test.js,
            test/unit/permission-*.test.js, test/unit/persist-session-label.test.js,
            test/unit/file-attachment-manager-init.test.js, test/integration/sessions.test.js,
            test/integration/session-*.test.js, test/integration/permissions.test.js, test/e2e/chat*.spec.js,
            test/e2e/template-blank-model.spec.js, test/e2e/goals/ask-elsewhere.spec.js,
            test/unit/sources.test.js, test/e2e/goals/research-citations.spec.js,
            test/unit/source-urls.test.js, test/e2e/goals/pasted-url-chips.spec.js]
    journeys: [chat-reply, open-existing-thread, today-phone, ask-about-file, routine-from-thread, ask-in-other-mode, research-citations, listen, ask-pasted-url, chat-pasted-url-source]
  terminal:
    code: [ws/terminal-messages.js, terminal-paste.js, public/terminal-manager.js, public/terminal-keybar.js,
           public/agent-board.js, public/core/terminal-text.js, public/apple/terminal.css, public/apple/agents.css]
    tests: [test/unit/terminal-*.test.js, test/unit/message-dispatcher-terminal-request.test.js,
            test/integration/terminals.test.js, test/e2e/terminal-reconnect.spec.js]
    journeys: [terminal-on-request, agent-sign-in-refused, agent-enrol-refused, routine-touched]
  tasks:
    code: [public/dialogs/task-dialog.js, public/task-manager.js, public/task-viewer.js, public/routines-page.js,
           public/panes/routines-pane.js, public/routine-panel.js, public/routine-history.js, public/routine-audit.js,
           project-audit.js, public/core/routine-sentence.js, public/today/parts/routines-part.js,
           notifier.js, routine-failure-watcher.js]
    tests: [test/unit/task-*.test.js, test/integration/tasks.test.js, test/e2e/task-dialog-models.spec.js,
            test/e2e/schedules-and-connection.spec.js, test/unit/notifier.test.js,
            test/unit/routine-failure-watcher.test.js, test/integration/routine-failure-notify.test.js]
    journeys: [task-created-listed, routine-from-thread, routine-touched, brief-injection-refused, routine-failed-notifies]
  files:
    code: [ws/file-messages.js, file-handlers.js, file-service.js, file-watcher.js, dir-watcher.js, public/file-browser.js,
           public/file-editor.js, public/html-preview-pane.js, public/viewers/**, public/sidebar/file-tree-node.js,
           public/sidebar/file-icons.js, public/sidebar/project-tree.js, public/apple/editor.css,
           public/apple/viewers.css]
    tests: [test/unit/file-*.test.js, test/unit/files-route.test.js, test/unit/iframe-sandbox-guard.test.js,
            test/unit/language-detect.test.js, test/unit/static-exposure.test.js, test/integration/file-ops.test.js,
            test/integration/static-mounts.test.js, test/integration/binary-proxy.test.js]
    journeys: [file-edit-save, ask-about-file]
  git:
    code: [ws/git-messages.js, git-service.js, public/sidebar/changes-panel.js, public/diff-viewer.js,
           public/panes/diff-pane.js, public/core/unified-diff.js]
    tests: [test/unit/*git*.test.js, test/unit/changes-panel.test.js, test/unit/diff-viewer.test.js,
            test/integration/git-changes.test.js, test/e2e/changes-panel.spec.js]
    journeys: [changes-diff]
  search:
    code: [ws/search-messages.js, search-service.js, search-summarizer.js, public/dialogs/search-dialog.js,
           public/today/ask-about.js]
    tests: [test/unit/search-*.test.js, test/integration/search*.test.js]
    journeys: []
  voice:
    code: [ws/voice-messages.js, tts-service.js, tts-director.js, tts-chunker.js, stt-service.js,
           public/voice-*.js, public/tts-*.js, public/stt-*.js, public/vad-manager.js,
           public/native-audio-bridge.js, public/features/tts.js, public/features/stt.js, public/apple/voice.css]
    tests: [test/unit/tts-*.test.js, test/integration/voice-ws.test.js, test/e2e/voice*.spec.js, test/e2e/goals/mode-presets.spec.js]
    journeys: [voice-deep-link, listen]
  hosts:
    code: [ssh-command.js, ssh-host-pool.js, remote-file-service.js, remote-fs-agent.js, public/remote-sessions.js,
           public/apple/hosts.css]
    tests: [test/unit/ssh-*.test.js, test/unit/remote-*.test.js, test/unit/state-store-hosts.test.js,
            test/unit/message-dispatcher-host-status.test.js, test/unit/persistent-sessions-proxy.test.js,
            test/integration/host-projects.test.js]
    journeys: []
  settings:
    code: [public/dialogs/settings-dialog.js, public/apple/dialogs.css, public/apple/controls.css]
    tests: ["test/visual/**", test/e2e/goals/settings-sheet.spec.js, test/e2e/goals/mode-presets.spec.js]
    journeys: [settings-sheet, mode-presets]
  ui-control:
    code: [mcp/**, ui-command-bus.js]
    tests: [test/unit/ui-command-bus.test.js, test/integration/ui-command.test.js]
    journeys: []
  verify:
    code: [devboxverify/**, scripts/browser-lock.js]
    tests: [test/unit/devboxverify.test.js, test/integration/browser-lock.test.js]
    journeys: all
```

## Notes

- **Nightly budget.** The journey phase has a 480 s budget; a journey that
  would start past it is `BLOCKED run budget spent`. A green run is about
  4 minutes (preflight and reset ~50 s, journeys ~165 s, leak snapshots
  ~20 s). Timeouts sum to 1290 s, so the budget is what holds the worst case
  under 10 minutes.
- **Run order.** The passkey journeys run first against eve-verify, which
  runs untrusted: passkey-first-enrol claims it and passkey-sign-in signs
  in, and every later journey reuses that session. If either is not PASS,
  the rest are `BLOCKED no signed-in owner`. Then agent-enrol-refused,
  which waits out an enrolment window left open by an earlier run (up to
  5 minutes), then journeys 1–9, then agent-sign-in-refused.
- **Screen journeys run last.** The nightly passes `--screen`, so
  add-browser-in-window runs every night after the rest and consumes the
  enrolment window it opens. A manual run passes
  `--screen` only with a SCREEN grant; without it the journey is
  `NOTRUN screen journey; run with --screen`.
- **Negative journeys** (agent-sign-in-refused, agent-enrol-refused) are
  audited in relay's eve-verify service log. eve does not log an enrolment
  refused outside the window, so agent-enrol-refused runs and stays red
  until the enrolment-refusal logging bug is fixed.
- **Model-dependent features** (tool blocks, question options, generated
  images, AI search summary, agent image tabs) need a scripted or
  deterministic model in the devbox world before a journey can judge them.
- **Owner gates** (G1 sign-in, G8 answers, G15 Safari sign-in, G16) are
  never skipped by an API or flag. The harness passes eve's with the
  operator's test credentials; relay's journeys cover relay's.
- **Relation to README.** `README.md`'s "Feature map" section documents the
  journeys' locators and traps. This file is the goal-level map.
- **Upkeep.** A change a user would notice in a file matched by an area's
  `code` globs updates this map (feature row, journey, Areas block) in the
  same PR.
- **Retired ids (S5a).** The `sidebar-session-*`, `sidebar-terminal-*` and
  `sidebar-task-*` test ids went with the panel rows they named; the page uses
  `project-thread-*`, `project-task-*` and `project-agent-*`, the board on
  Today `today-agent-*`. Design: [design-workbench.md](design-workbench.md).
