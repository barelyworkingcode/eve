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
| G3 | Pick up where I left off | Reopen a thread from yesterday or another device | The thread opens from Home, Sessions or ⌘K with its history, and no new session is made | chat, home | **must-have** | open-existing-thread (Sessions, Home Continue, ⌘K) |
| G4 | Work in a shell on my project | Open a terminal in the project and run things | A terminal opens only when asked, runs my command, and is still there after a reload | terminal | **must-have** | terminal-on-request (with reload) |
| G5 | Hand a task off and come back later | Give an agent a job, on demand or on a schedule | The task is saved, runs when told, and its last run is readable afterwards | tasks | **must-have** | task-created-listed (with Run Now and history) |
| G6 | Check what my agents did | Come back and see what ran and what changed | A task's run is readable afterwards; the Changes tab lists edited files and the diff opens | tasks, git | **must-have** | task-created-listed (run and history), changes-diff |
| G7 | Read and edit project files | Browse, open, change and save a file | The tree lists the project, a file opens in the editor, Save persists it, an outside edit is flagged | files | **must-have** | file-edit-save |
| G8 | Let an agent act, under my control | Agents use tools only as the project's policy and my answers allow | Mode banner is right; a tool call in a gated mode raises the prompt; plan mode waits for Approve | chat, projects | should | none yet — answering the prompt is relay's owner gate; the prompt appearing is journey-checkable |
| G9 | Talk hands-free | Start a voice chat and converse | The voice view opens (incl. the `#/voice-chat` deep link), speech is transcribed, replies are spoken | voice | should | voice-deep-link (view opens, one session; no audio) |
| G10 | Find something in my project | Locate text or a thing I did before | Search returns matches and opens them; ⌘K finds sessions, projects, files | search, home | should | none yet — not written |
| G11 | Share files and images with the model | Give the model a file, see images it makes | Attached/pasted/dropped files reach the turn; images render and open fullscreen | chat, files | should | none yet — not written |
| G12 | Set up and tune a project | Create a project and set its templates, models and policy | A new project appears in the rail; template and policy edits take effect on the next launch | projects | should | none yet — devbox world is fixed by setup; mutating it needs its own reset |
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
| Today: a host that lays out independent parts (summary, Ask, Needs you, Start, Continue, Running, Projects) for the current mode; a failing part shows one line with Retry, a slow one a skeleton | UI: `public/home-screen.js`, `public/today/**` (design: `docs/design-today-s1.md`) | Open eve with no tab open | landing-view (greeting, tiles); none yet for part failure/slowness — cloud specs `goals/today-parts` | home |
| Ask box: Return starts a thread in the mode's default project, no dialog | UI: `public/today/parts/ask-part.js`; WS `create_session`, `user_input` | Today, focused on open | none yet — cloud specs `goals/today-ask` | home, chat |
| Needs you / Running: waiting, failed and running threads and task runs, from frames eve receives | UI: `public/today/parts/needs-you-part.js`, `running-part.js`; `public/core/session-activity.js` | Today | none yet — cloud specs `goals/today-truth` | home |
| Home \| Work switch; lists show only projects whose mode includes it | UI: `public/sidebar/mode-switch.js`, `core/mode.js`, `StateStore.getModeProjects`; API: `mode`, `default_for` on `GET /api/projects` | Sidebar panel header | world-projects-listed (checks each mode shows only its projects); cloud specs `goals/today-mode`; real enforcement is relay's | home, projects |
| First-run "Create a project" | UI: `public/today/parts/projects-part.js` (`.home__first-run`) | Open eve with zero projects | none yet — world always has projects | home, projects |
| Project chips on Home | UI: `public/today/parts/projects-part.js`; API: `GET /api/projects` | Home | world-projects-listed | home, projects |
| Project rail | UI: `public/sidebar/activity-rail.js` | Left rail | world-projects-listed | projects |
| Project panel (Files / Sessions / Tasks / Changes) | UI: `public/sidebar/project-panel.js` | Click a project in the rail | chat-reply etc. (as setup, not a verdict) | projects |
| `/<project-slug>/` URL scoping | API: `server.js` SPA route | Open `/<slug>/` | none yet — not written | home |
| Connection banner and reconnect | UI: `#connectionBanner`; `relay-client.js` upstream self-heal | Relay drops and returns | none yet — needs a controlled relay drop | shell, core |
| Bad-network reload banner | UI: inline in `public/index.html` | A script fails to load | none yet — later | shell |

### G2 · Ask about my project and get an answer

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Session launcher, Web Chat form | UI: `public/dialogs/shell-launcher-dialog.js` | Project panel New Session, Home Chat tile, ⌘K New session | chat-reply | chat |
| Model picker (filtered by `allowed_models`) | UI: launcher `launcher-model-select`; API: `GET /api/models` | Launcher Web Chat form | chat-reply (picks one) | chat, projects |
| Chat templates in the launcher | UI: launcher cards; project Templates tab | Launcher | none yet — World voice card used only by voice-deep-link | chat, projects |
| Per-provider chat defaults | UI: `ShellLauncherDialog#_launchSession` `applyChatDefaults` | Any web/voice launch | none yet — e2e `chat-defaults.spec.js` only | chat |
| Send a message (Enter / Shift+Enter) | UI: `public/features/chat-form.js`; WS `user_input` | Composer | chat-reply | chat |
| Streaming reply, Markdown, code, Mermaid | UI: `public/message-renderer.js` | Any reply | chat-reply (non-empty reply only) | chat |
| Stop generation | UI: `chat-stop`; WS `stop_generation` | Stop button while replying | chat-reply (clicks Stop mid-reply) | chat |
| Same chat open in two browsers | UI: `message-dispatcher.js` (`user_message` from another viewer) | Open one thread in a second browser, send from either | none yet — needs two browser contexts and a turn long enough to Send into; unit `message-dispatcher-stale-submit.test.js` only | chat |
| Thinking, tool-use and agent blocks | UI: `message-renderer.js` | Replies that use tools or think | none yet — model-dependent | chat |
| Interactive question options | UI: `message-renderer.js` | Model offers choices | none yet — model-dependent | chat |
| Errors shown in the thread | UI: `message-system.error` | A refused or failed turn | chat-reply (classifies FAIL/BLOCKED) | chat |
| Slash commands `/clear`, `/help` | Server: `slash-command-handler.js` | Type in composer | none yet — not written | chat |
| Provider slash commands (`/model`, `/compact`, …) | Forwarded to relayLLM | Type in composer | none yet — not written | chat |
| Input history ↑/↓ | UI: `public/input-history.js` | Arrow keys in composer | none yet — later | chat |
| Cost stat | UI: `#costStat` | Chat header | none yet — later | chat |
| Rename / move to folder / delete a session | UI: project-panel context menu; WS `rename_session`, `set_session_folder`, `delete_session` | Right-click a session | none yet — not written | chat |
| End session | WS `end_session` | Session menu / voice End | voice-deep-link (button visible only) | chat |

### G3 · Pick up where I left off

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Sessions tab → open thread with history | UI: project-panel Sessions; `app.joinSession`; `message-dispatcher.js` | Sessions tab, click a thread | open-existing-thread | chat |
| Home "Continue" list | UI: `public/today/parts/continue-part.js`; `core/session-recents.js` | Home | open-existing-thread (Continue row) | home, chat |
| ⌘K jump to session / project / tab / recent file | UI: `public/dialogs/command-palette.js` | ⌘K | open-existing-thread (session by title) | home |
| Launcher Resume tab (running chats and terminals) | UI: `shell-launcher-dialog.js` | Launcher → Resume | none yet — not written | chat, terminal |
| Reopen tabs after reload (`eve-open-sessions`, `eve-open-files`) | UI: `tab-manager.js`, localStorage | Reload eve | none yet — README notes it as a trap | shell |
| Session labels from first turn | UI: `core/ui-utils.js` `sessionDisplayName`, `session-recents.js` | Anywhere a session is listed | none yet — not written | chat, home |

### G4 · Work in a shell on my project

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Terminal templates per project | API: `GET /api/terminal/templates?project=` | Launcher cards | terminal-on-request | terminal |
| Open a terminal and run a command; a terminal relay already holds is listed in the Sessions panel and opens on click, never by itself | UI: `public/terminal-manager.js`, `project-panel.js`; WS `terminal_create`, `terminal_input`, `terminal_list` | Launcher card, Home tile, rail New Terminal, Sessions panel | terminal-on-request (after a reload: nothing opens by itself, Sessions lists it, a click opens it) | terminal |
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
| Create a task (name, type, prompt, model) | UI: `public/dialogs/task-dialog.js`; API: `POST /api/tasks` | Tasks tab → New | task-created-listed | tasks |
| Task listed, persists across reload | UI: `public/task-manager.js`; API: `GET /api/tasks` | Tasks tab | task-created-listed | tasks |
| Schedule types (daily, hourly, interval, weekly, cron, once, on demand) | UI: task dialog; `core/task-schedule.js` | Task dialog Schedule | none yet — journey uses On demand only | tasks |
| Enabled / Catch up missed runs | UI: task dialog | Task dialog | none yet — not written | tasks |
| Run a task now | API: `POST /api/tasks/:taskId/run` | Task list action | task-created-listed (Run Now) | tasks |
| Edit / delete a task | UI: task dialog; API: `PUT`/`DELETE /api/tasks/:taskId` | Task list | none yet — delete uses native `confirm()` | tasks |
| Task events live (`/ws/tasks`) | `relay-client.js#_connectScheduler` | Tasks tab while a run happens | none yet — not written | tasks, core |

### G6 · Check what my agents did

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| View a task's last or live run | UI: `public/task-viewer.js`; API: `GET /api/tasks/:taskId/history` | Tasks tab → a task | task-created-listed (last run after reload) | tasks |
| Running indicators (Today dot and count, rail and panel dots): a turn in progress in a joined thread or an executing task run; a live idle process shows none | UI: `public/today/**`, `project-panel.js`, `activity-rail.js`; `core/session-activity.js` | Home, rail | none yet — cloud specs `goals/today-truth` | home |
| Changes tab (repos, worktrees, counts) | UI: `public/sidebar/changes-panel.js`; WS `git_changes` | Project panel → Changes | changes-diff | git |
| Uncommitted / vs base scope | UI: changes-panel scope toggle | Changes tab | none yet — not written | git |
| Diff pane (side-by-side / inline) | UI: `public/diff-viewer.js`, `panes/diff-pane.js`; WS `git_file_versions` | Click a changed file | changes-diff | git |
| Live `git_changed` refresh | `file-watcher.js`, `dir-watcher.js` | Edit a file while Changes is open | none yet — not written | git, files |
| Remote sessions: view / reattach / kill | UI: `public/remote-sessions.js`; API: `/api/projects/:id/persistent-sessions` | Host project | none yet — G13 | hosts, terminal |

### G7 · Read and edit project files

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| File tree browse | UI: `public/file-browser.js`, `sidebar/project-tree.js`; WS `list_directory` | Project panel → Files | file-edit-save | files |
| Open a file in the editor | UI: `public/file-editor.js` (Monaco); WS `read_file` | Click a file | file-edit-save | files |
| Save (⌘S / Save) | WS `write_file` | Edit, ⌘S | file-edit-save | files |
| Live file watching (tree refresh, `watch_error` toast when the watcher cannot start) | `file-watcher.js`, `dir-watcher.js`; WS `dir_changed`, `watch_error` | Change a file on disk | none yet — not written | files |
| External change banner (Reload / Keep) | UI: `file-editor.js`; WS `watch_file` | File changes on disk while open | file-edit-save (clean editor updates; dirty editor shows the banner, Reload) | files |
| Markdown / HTML preview, Edit/Split/Preview | UI: `file-editor.js`, `html-preview-pane.js` (sandboxed iframe) | Open `.md`/`.html` | none yet — not written | files |
| Image / PDF / video / audio viewers | UI: `public/viewers/*`; API: `GET /api/files/:projectId/*` | Click such a file | none yet — not written | files |
| Rename / move / delete / new folder | WS `rename_file`, `move_file`, `delete_file`, `create_directory` | Tree context menu, drag | none yet — not written | files |
| Upload by dropping on the tree | WS `upload_file` | Drag files onto the tree | none yet — not written | files |
| Show hidden files | UI: Settings → Files | Settings | none yet — later | files, settings |
| Plan file viewer | WS `read_plan_file` | Plan-mode plan link | none yet — not written | files, chat |

### G8 · Let an agent act, under my control

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Permission prompt (Allow / Deny / Allow All) | UI: `#permissionModal`, `modal-manager.js`; WS `permission_response` | Agent calls a gated tool | **owner gate** (answer): relay's; prompt appearing: none yet | chat |
| Plan approval bar (Approve / Revise) | UI: `#planApprovalBar` | Plan mode proposes a plan | none yet — not a gate: Approve sends a user turn | chat |
| Permission mode banner and control | UI: `message-renderer.js`; WS `set_permission_mode` | Chat header | none yet — not written | chat |
| Project permission policy | UI: project dialog Permissions tab | Edit Project | none yet — G12 | projects |
| Agent-opened image tabs (`eve-control` MCP) | `mcp/main.js`, `ui-command-bus.js`, `POST /internal/ui-command` | Agent calls `eve_open_tab` | none yet — model-dependent | ui-control |

### G9 · Talk hands-free

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| `#/voice-chat` deep link with a favourite template | UI: `app.js` `_handleHashRoute`, launcher star | Open `#/voice-chat` | voice-deep-link | voice |
| Voice chat from launcher / Home Voice tile | UI: `public/voice-chat-manager.js` | Voice tile, launcher Voice card | none yet — deep link only | voice |
| Speech to text (push-to-talk, hands-free, Space) | UI: `stt-manager.js`, `vad-manager.js`; WS `transcribe_audio`; `stt-service.js` | Hold mic / Space | none yet — needs the live STT daemon | voice |
| Spoken replies, per-message play | UI: `tts-manager.js`, `.tts-play-btn`; WS `tts_speak`; `tts-service.js` | Reply in voice mode, play button | none yet — needs the live TTS daemon | voice |
| Voice drawer (voice, speed) | UI: `#voiceDrawerPanel`; API: `GET /api/tts/voices` | Composer voice drawer | none yet — e2e covers the drawer | voice |
| Convert voice → text chat, End session | UI: `#voiceChatConvert`, `#voiceChatClose` | Voice view buttons | voice-deep-link (End visible only) | voice |
| Orb settings, Voice settings tab, crash guard | UI: `voice-orb-settings.js`, settings Voice tab, `voice-crash-guard.js` | Voice view, Settings | none yet — later | voice, settings |

### G10 · Find something in my project

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Search in files (glob, regex, whole word) | UI: `public/dialogs/search-dialog.js`; WS `search_project`; `search-service.js` | ⌘⇧F, ⌘K Search | none yet — not written | search |
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
| Create / edit / delete project | UI: `public/dialogs/project-dialog.js`; API: `/api/projects` | Rail +, ⌘K New project, panel menu | none yet — world is fixed | projects |
| Chat templates tab | UI: project dialog Templates | Edit Project | none yet — world setup S3 is manual | projects, chat |
| Terminal templates | API: `/api/terminal/templates` | Edit Project / tray | none yet — world setup | projects, terminal |
| MCP picker, model picker | UI: project dialog General; API: `GET /api/mcps`, `GET /api/models` | Edit Project | none yet — not written | projects |
| Regenerate Skills | UI: project-panel context menu | Right-click project | none yet — later | projects |
| Per-tool MCP scoping, token rotation | relay tray Projects tab | Relay tray | none — relay-owned | — |

### G13 · Work on a project on another machine

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Add / probe / remove SSH host | UI: project dialog host form; API: `/api/hosts`, `/api/hosts/:id/probe` | Edit Project → Where → Host… | none yet — no host in the world | hosts |
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
| Front door: opening eve after 60 minutes or more away shows Today with Ask focused and restores no tabs; a deep link still wins; resuming a page after that gap returns to Today and keeps tabs | UI: `public/core/front-door.js`, `app.js`; localStorage `eve-last-active` | Open or resume eve after a break | none yet — a journey would need to age the stamp; cloud spec `layout-front-door`, unit `front-door` | home, shell |
| Theme, presets, colours, typography, reset | UI: `public/dialogs/settings-dialog.js` | Settings, ⌘K Appearance | none yet — visual baselines | settings |

### G15 · Use eve from my phone

| Feature | Lives in | How reached | Journey | Areas |
|---|---|---|---|---|
| Safari passkey fallback | API: `GET /api/auth/safari-login`; iOS `ASWebAuthenticationSession` | iOS app sign-in | **owner gate** (passkey sign-in); none yet — native app needs a devbox pass | auth |
| Action Button → `#/voice-chat` | iOS app + hash route | Action Button | voice-deep-link (the route, from a desktop browser) | voice |
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
    code: [public/home-screen.js, public/today/**, public/core/session-activity.js, public/core/mode.js,
           public/sidebar/mode-switch.js, public/core/front-door.js, public/dialogs/command-palette.js,
           public/apple/home.css, public/apple/palette.css]
    tests: [test/unit/command-palette.test.js, test/unit/session-recents.test.js, test/unit/session-activity.test.js,
            test/unit/today-parts.test.js, test/unit/mode.test.js, test/e2e/app.spec.js, "test/e2e/goals/today-*.spec.js",
            test/e2e/goals/home-screen.spec.js]
    journeys: [landing-view, world-projects-listed, open-existing-thread, today-ipad-portrait, today-phone]
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
           public/apple/sidebar-tree.css]
    tests: [test/unit/project-normalize.test.js, test/integration/projects.test.js]
    journeys: [world-projects-listed]
  chat:
    code: [ws/session-messages.js, slash-command-handler.js, public/dialogs/shell-launcher-dialog.js,
           public/features/chat-form.js, public/features/permissions.js, public/features/file-attachments.js,
           public/message-renderer.js, public/mermaid-loader.js, public/input-history.js,
           public/file-attachment-manager.js, public/apple/chat.css, public/apple/chat-extras.css]
    tests: [test/unit/chat-*.test.js, test/unit/slash-command-handler.test.js, test/unit/input-history.test.js,
            test/unit/permission-*.test.js, test/unit/persist-session-label.test.js,
            test/unit/file-attachment-manager-init.test.js, test/integration/sessions.test.js,
            test/integration/session-*.test.js, test/integration/permissions.test.js, test/e2e/chat*.spec.js,
            test/e2e/template-blank-model.spec.js]
    journeys: [chat-reply, open-existing-thread, today-phone]
  terminal:
    code: [ws/terminal-messages.js, terminal-paste.js, public/terminal-manager.js, public/terminal-keybar.js,
           public/apple/terminal.css]
    tests: [test/unit/terminal-*.test.js, test/unit/message-dispatcher-terminal-request.test.js,
            test/integration/terminals.test.js, test/e2e/terminal-reconnect.spec.js]
    journeys: [terminal-on-request, agent-sign-in-refused, agent-enrol-refused]
  tasks:
    code: [public/dialogs/task-dialog.js, public/task-manager.js, public/task-viewer.js]
    tests: [test/unit/task-*.test.js, test/integration/tasks.test.js, test/e2e/task-dialog-models.spec.js,
            test/e2e/schedules-and-connection.spec.js]
    journeys: [task-created-listed]
  files:
    code: [ws/file-messages.js, file-handlers.js, file-service.js, file-watcher.js, dir-watcher.js, public/file-browser.js,
           public/file-editor.js, public/html-preview-pane.js, public/viewers/**, public/sidebar/file-tree-node.js,
           public/sidebar/file-icons.js, public/sidebar/project-tree.js, public/apple/editor.css,
           public/apple/viewers.css]
    tests: [test/unit/file-*.test.js, test/unit/files-route.test.js, test/unit/iframe-sandbox-guard.test.js,
            test/unit/language-detect.test.js, test/unit/static-exposure.test.js, test/integration/file-ops.test.js,
            test/integration/static-mounts.test.js, test/integration/binary-proxy.test.js]
    journeys: [file-edit-save]
  git:
    code: [ws/git-messages.js, git-service.js, public/sidebar/changes-panel.js, public/diff-viewer.js,
           public/panes/diff-pane.js]
    tests: [test/unit/*git*.test.js, test/unit/changes-panel.test.js, test/unit/diff-viewer.test.js,
            test/integration/git-changes.test.js, test/e2e/changes-panel.spec.js]
    journeys: [changes-diff]
  search:
    code: [ws/search-messages.js, search-service.js, search-summarizer.js, public/dialogs/search-dialog.js]
    tests: [test/unit/search-*.test.js, test/integration/search*.test.js]
    journeys: []
  voice:
    code: [ws/voice-messages.js, tts-service.js, tts-director.js, tts-chunker.js, stt-service.js,
           public/voice-*.js, public/tts-*.js, public/stt-*.js, public/vad-manager.js,
           public/native-audio-bridge.js, public/features/tts.js, public/features/stt.js, public/apple/voice.css]
    tests: [test/unit/tts-*.test.js, test/integration/voice-ws.test.js, test/e2e/voice*.spec.js]
    journeys: [voice-deep-link]
  hosts:
    code: [ssh-command.js, ssh-host-pool.js, remote-file-service.js, remote-fs-agent.js, public/remote-sessions.js,
           public/apple/hosts.css]
    tests: [test/unit/ssh-*.test.js, test/unit/remote-*.test.js, test/unit/state-store-hosts.test.js,
            test/unit/message-dispatcher-host-status.test.js, test/unit/persistent-sessions-proxy.test.js,
            test/integration/host-projects.test.js]
    journeys: []
  settings:
    code: [public/dialogs/settings-dialog.js, public/apple/dialogs.css, public/apple/controls.css]
    tests: ["test/visual/**"]
    journeys: []
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
