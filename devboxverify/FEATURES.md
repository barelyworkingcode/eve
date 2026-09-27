# eve feature map

What a person uses eve for, the features that serve each goal, and the devbox
journey that covers it today. Journeys follow goals end to end, so the owner
marks priority per goal, not per feature. Priorities below are **suggested**;
the owner's marks replace them.

Derived from the code (`routes/`, `ws/`, `public/`, `slash-command-handler.js`,
`mcp/`) and `docs/`. "Journey today" means what a journey in
`devboxverify/journeys.js` actually asserts, not what its name suggests.
Per-journey locators and traps live in [README.md](README.md#feature-map).

**Stays human** marks a gate a person must pass: passkey ceremony, a
presence-gated relay action, a tool-permission or plan approval. No journey
answers or bypasses one. A journey may check that the gate *appears*.

## Goals

| # | Goal | Intent | It worked when… | Areas | Suggested | Journeys today |
|---|---|---|---|---|---|---|
| G1 | Get in and see my work | Open eve and land where my projects are | Home greets me, my projects are in the rail and on Home, no passkey prompt on a trusted network | auth, home, projects | **must-have** | landing-view, world-projects-listed |
| G2 | Ask about my project and get an answer | Start a chat in a project and get a reply | My question shows, a reply streams in and settles, Stop works, errors show in the thread | chat | **must-have** | chat-reply |
| G3 | Pick up where I left off | Reopen a thread from yesterday or another device | The thread opens from Home, Sessions or ⌘K with its history, and no new session is made | chat, home | **must-have** | open-existing-thread (Sessions tab only) |
| G4 | Work in a shell on my project | Open a terminal in the project and run things | A terminal opens only when asked, runs my command, and is still there after a reload | terminal | **must-have** | terminal-on-request (open + run only) |
| G5 | Hand a task off and come back later | Give an agent a job, on demand or on a schedule | The task is saved, runs when told, and its last run is readable afterwards | tasks | **must-have** | task-created-listed (create + list only) |
| G6 | Check what my agents did | Come back and see what ran and what changed | Task runs and running sessions are visible; the Changes tab lists edited files and the diff opens | tasks, git, chat | **must-have** | none yet — not written |
| G7 | Read and edit project files | Browse, open, change and save a file | The tree lists the project, a file opens in the editor, Save persists it, an outside edit is flagged | files | **must-have** | none yet — not written |
| G8 | Let an agent act, under my control | Agents use tools only as the project's policy and my answers allow | Mode banner is right; a tool call in a gated mode raises the prompt; plan mode waits for Approve | chat, projects | should | none yet — answering stays human; the prompt appearing is journey-checkable |
| G9 | Talk hands-free | Start a voice chat and converse | The voice view opens (incl. the `#/voice-chat` deep link), speech is transcribed, replies are spoken | voice | should | voice-deep-link (view opens, one session; no audio) |
| G10 | Find something in my project | Locate text or a thing I did before | Search returns matches and opens them; ⌘K finds sessions, projects, files | search, home | should | none yet — not written |
| G11 | Share files and images with the model | Give the model a file, see images it makes | Attached/pasted/dropped files reach the turn; images render and open fullscreen | chat, files | should | none yet — not written |
| G12 | Set up and tune a project | Create a project and set its templates, models and policy | A new project appears in the rail; template and policy edits take effect on the next launch | projects | should | none yet — devbox world is fixed by setup; mutating it needs its own reset |
| G13 | Work on a project on another machine | Use an SSH-host project like a local one | Host shows connected; files, terminals and Changes work against the host | hosts, files, terminal, git | should | none yet — needs an SSH host in the devbox world |
| G14 | Arrange my workspace | Tabs, splits, sidebar, theme and fonts the way I like | Tabs switch and close, a split docks and undocks, settings persist | shell, settings | later | none yet — pixel baselines and e2e cover layout |
| G15 | Use eve from my phone | The iOS app and mobile Safari | Sign-in via Safari fallback, keybar, swipe, Action Button deep link | auth, voice, terminal | later | none yet — native app needs a devbox pass, not Playwright |
| G16 | Let a new browser in, or remove one | Enrol a second device, revoke a lost one | Enrolment succeeds only inside relay's window; a revoked passkey fails its next login | auth | **stays human** | none — presence and passkey gates |

## Features by goal

Columns: **Lives in** (UI surface / API / CLI / tray) · **How reached** ·
**Journey today** · **Areas**.

### G1 · Get in and see my work

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Trusted-network bypass of the passkey screen | API: `trusted-network.js`, `GET /api/auth/status` | Open eve from loopback or a trusted subnet | landing-view | auth |
| Passkey sign-in | UI: `#authScreen`, `public/auth.js`; API: `/api/auth/login/*` | Open eve off the trusted network, Sign In | stays human | auth |
| Home greeting and Start tiles | UI: `public/home-screen.js` | Open eve with no tab open | landing-view | home |
| First-run "Create a project" | UI: `home-screen.js` (`.home__first-run`) | Open eve with zero projects | none yet — world always has projects | home, projects |
| Project chips on Home | UI: `home-screen.js` (`_renderProjects`); API: `GET /api/projects` | Home | world-projects-listed | home, projects |
| Project rail | UI: `public/sidebar/activity-rail.js` | Left rail | world-projects-listed | projects |
| Project panel (Files / Sessions / Tasks / Changes) | UI: `public/sidebar/project-panel.js` | Click a project in the rail | chat-reply etc. (as setup, not a verdict) | projects |
| `/<project-slug>/` URL scoping | API: `server.js` SPA route | Open `/<slug>/` | none yet — not written | home |
| Connection banner and reconnect | UI: `#connectionBanner`; `relay-client.js` upstream self-heal | Relay drops and returns | none yet — needs a controlled relay drop | shell, core |
| Bad-network reload banner | UI: inline in `public/index.html` | A script fails to load | none yet — later | shell |

### G2 · Ask about my project and get an answer

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Session launcher, Web Chat form | UI: `public/dialogs/shell-launcher-dialog.js` | Project panel New Session, Home Chat tile, ⌘K New session | chat-reply | chat |
| Model picker (filtered by `allowed_models`) | UI: launcher `launcher-model-select`; API: `GET /api/models` | Launcher Web Chat form | chat-reply (picks one) | chat, projects |
| Chat templates in the launcher | UI: launcher cards; project Templates tab | Launcher | none yet — World voice card used only by voice-deep-link | chat, projects |
| Per-provider chat defaults | UI: `ShellLauncherDialog#_launchSession` `applyChatDefaults` | Any web/voice launch | none yet — e2e `chat-defaults.spec.js` only | chat |
| Send a message (Enter / Shift+Enter) | UI: `public/features/chat-form.js`; WS `user_input` | Composer | chat-reply | chat |
| Streaming reply, Markdown, code, Mermaid | UI: `public/message-renderer.js` | Any reply | chat-reply (non-empty reply only) | chat |
| Stop generation | UI: `chat-stop`; WS `stop_generation` | Stop button while replying | none yet — chat-reply only waits for Stop to hide | chat |
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

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Sessions tab → open thread with history | UI: project-panel Sessions; `app.joinSession`; `message-dispatcher.js` | Sessions tab, click a thread | open-existing-thread | chat |
| Home "Continue" list | UI: `home-screen.js`; `core/session-recents.js` | Home | none yet — not written | home, chat |
| ⌘K jump to session / project / tab / recent file | UI: `public/dialogs/command-palette.js` | ⌘K | none yet — not written | home |
| Launcher Resume tab (running chats and terminals) | UI: `shell-launcher-dialog.js` | Launcher → Resume | none yet — not written | chat, terminal |
| Reopen tabs after reload (`eve-open-sessions`, `eve-open-files`) | UI: `tab-manager.js`, localStorage | Reload eve | none yet — README notes it as a trap | shell |
| Session labels from first turn | UI: `core/ui-utils.js` `sessionDisplayName`, `session-recents.js` | Anywhere a session is listed | none yet — not written | chat, home |

### G4 · Work in a shell on my project

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Terminal templates per project | API: `GET /api/terminal/templates?project=` | Launcher cards | terminal-on-request | terminal |
| Open a terminal and run a command | UI: `public/terminal-manager.js`; WS `terminal_create`, `terminal_input` | Launcher card, Home tile, rail New Terminal | terminal-on-request | terminal |
| No terminal until asked | — | Open a project | terminal-on-request | terminal |
| Slash `/zsh`, `/bash`, `/claude`, `/rh` | Server: `slash-command-handler.js` | Type in composer | none yet — not written | terminal, chat |
| Terminal survives reload / reconnect | WS `terminal_reconnect`, `join_terminal` | Reload with a terminal open | none yet — e2e `terminal-reconnect.spec.js` only | terminal |
| Resize / fit | WS `terminal_resize` | Resize window | none yet — later | terminal |
| Copy / paste, web links | UI: xterm addons | Select, paste, click a link | none yet — later | terminal |
| Paste an image into a terminal | API: `POST /api/terminal/paste-image`; `terminal-paste.js` | Paste or drop an image on a terminal | none yet — not written | terminal |
| Terminal scrollback log | API: `GET /api/terminals/:id/log` | Reopen a terminal | none yet — not written | terminal |
| Close a terminal | WS `terminal_close` | Close its tab | none yet — sweep closes them | terminal |
| Mobile keybar | UI: `public/terminal-keybar.js` | Terminal on a phone | none yet — G15 | terminal |

### G5 · Hand a task off and come back later

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Create a task (name, type, prompt, model) | UI: `public/dialogs/task-dialog.js`; API: `POST /api/tasks` | Tasks tab → New | task-created-listed | tasks |
| Task listed, persists across reload | UI: `public/task-manager.js`; API: `GET /api/tasks` | Tasks tab | task-created-listed | tasks |
| Schedule types (daily, hourly, interval, weekly, cron, once, on demand) | UI: task dialog; `core/task-schedule.js` | Task dialog Schedule | none yet — journey uses On demand only | tasks |
| Enabled / Catch up missed runs | UI: task dialog | Task dialog | none yet — not written | tasks |
| Run a task now | API: `POST /api/tasks/:taskId/run` | Task list action | none yet — not written | tasks |
| Edit / delete a task | UI: task dialog; API: `PUT`/`DELETE /api/tasks/:taskId` | Task list | none yet — delete uses native `confirm()` | tasks |
| Task events live (`/ws/tasks`) | `relay-client.js#_connectScheduler` | Tasks tab while a run happens | none yet — not written | tasks, core |

### G6 · Check what my agents did

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| View a task's last or live run | UI: `public/task-viewer.js`; API: `GET /api/tasks/:taskId/history` | Tasks tab → a task | none yet — not written | tasks |
| Running indicators (Home dot, panel counts) | UI: `home-screen.js`, `project-panel.js` | Home, rail | none yet — not written | home |
| Changes tab (repos, worktrees, counts) | UI: `public/sidebar/changes-panel.js`; WS `git_changes` | Project panel → Changes | none yet — e2e `changes-panel.spec.js` only | git |
| Uncommitted / vs base scope | UI: changes-panel scope toggle | Changes tab | none yet — not written | git |
| Diff pane (side-by-side / inline) | UI: `public/diff-viewer.js`, `panes/diff-pane.js`; WS `git_file_versions` | Click a changed file | none yet — not written | git |
| Live `git_changed` refresh | `file-watcher.js` | Edit a file while Changes is open | none yet — not written | git, files |
| Remote sessions: view / reattach / kill | UI: `public/remote-sessions.js`; API: `/api/projects/:id/persistent-sessions` | Host project | none yet — G13 | hosts, terminal |

### G7 · Read and edit project files

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| File tree browse | UI: `public/file-browser.js`, `sidebar/project-tree.js`; WS `list_directory` | Project panel → Files | none yet — not written | files |
| Open a file in the editor | UI: `public/file-editor.js` (Monaco); WS `read_file` | Click a file | none yet — not written | files |
| Save (⌘S / Save) | WS `write_file` | Edit, ⌘S | none yet — not written | files |
| External change banner (Reload / Keep) | UI: `file-editor.js`; WS `watch_file` | File changes on disk while open | none yet — not written | files |
| Markdown / HTML preview, Edit/Split/Preview | UI: `file-editor.js`, `html-preview-pane.js` (sandboxed iframe) | Open `.md`/`.html` | none yet — not written | files |
| Image / PDF / video / audio viewers | UI: `public/viewers/*`; API: `GET /api/files/:projectId/*` | Click such a file | none yet — not written | files |
| Rename / move / delete / new folder | WS `rename_file`, `move_file`, `delete_file`, `create_directory` | Tree context menu, drag | none yet — not written | files |
| Upload by dropping on the tree | WS `upload_file` | Drag files onto the tree | none yet — not written | files |
| Show hidden files | UI: Settings → Files | Settings | none yet — later | files, settings |
| Plan file viewer | WS `read_plan_file` | Plan-mode plan link | none yet — not written | files, chat |

### G8 · Let an agent act, under my control

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Permission prompt (Allow / Deny / Allow All) | UI: `#permissionModal`, `modal-manager.js`; WS `permission_response` | Agent calls a gated tool | **stays human** (answer); prompt appearing: none yet | chat |
| Plan approval bar (Approve / Revise) | UI: `#planApprovalBar` | Plan mode proposes a plan | **stays human** (answer); bar appearing: none yet | chat |
| Permission mode banner and control | UI: `message-renderer.js`; WS `set_permission_mode` | Chat header | none yet — not written | chat |
| Project permission policy | UI: project dialog Permissions tab | Edit Project | none yet — G12 | projects |
| Agent-opened image tabs (`eve-control` MCP) | `mcp/main.js`, `ui-command-bus.js`, `POST /internal/ui-command` | Agent calls `eve_open_tab` | none yet — model-dependent | ui-control |

### G9 · Talk hands-free

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| `#/voice-chat` deep link with a favourite template | UI: `app.js` `_handleHashRoute`, launcher star | Open `#/voice-chat` | voice-deep-link | voice |
| Voice chat from launcher / Home Voice tile | UI: `public/voice-chat-manager.js` | Voice tile, launcher Voice card | none yet — deep link only | voice |
| Speech to text (push-to-talk, hands-free, Space) | UI: `stt-manager.js`, `vad-manager.js`; WS `transcribe_audio`; `stt-service.js` | Hold mic / Space | none yet — needs the live STT daemon | voice |
| Spoken replies, per-message play | UI: `tts-manager.js`, `.tts-play-btn`; WS `tts_speak`; `tts-service.js` | Reply in voice mode, play button | none yet — needs the live TTS daemon | voice |
| Voice drawer (voice, speed) | UI: `#voiceDrawerPanel`; API: `GET /api/tts/voices` | Composer voice drawer | none yet — e2e covers the drawer | voice |
| Convert voice → text chat, End session | UI: `#voiceChatConvert`, `#voiceChatClose` | Voice view buttons | voice-deep-link (End visible only) | voice |
| Orb settings, Voice settings tab, crash guard | UI: `voice-orb-settings.js`, settings Voice tab, `voice-crash-guard.js` | Voice view, Settings | none yet — later | voice, settings |

### G10 · Find something in my project

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Search in files (glob, regex, whole word) | UI: `public/dialogs/search-dialog.js`; WS `search_project`; `search-service.js` | ⌘⇧F, ⌘K Search | none yet — not written | search |
| AI summary of results | WS `search_ai_summarize`; `search-summarizer.js` (hidden `__search:` session) | Search dialog checkbox | none yet — model-dependent | search, chat |
| Command palette actions | UI: `command-palette.js` | ⌘K | none yet — not written | home |

### G11 · Share files and images with the model

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Attach / paste / drop files on the composer | UI: `file-attachment-manager.js`, `features/file-attachments.js` | Attach button, paste, drop | none yet — not written | chat |
| Unsupported type rejection | UI: `file-attachment-manager.js` | Attach video/audio | none yet — later | chat |
| Inline and generated images, fullscreen viewer | UI: `message-renderer.js`; API: `GET /api/generated/:filename` | Image in a reply | none yet — model-dependent | chat |

### G12 · Set up and tune a project

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Create / edit / delete project | UI: `public/dialogs/project-dialog.js`; API: `/api/projects` | Rail +, ⌘K New project, panel menu | none yet — world is fixed | projects |
| Chat templates tab | UI: project dialog Templates | Edit Project | none yet — world setup S3 is manual | projects, chat |
| Terminal templates | API: `/api/terminal/templates` | Edit Project / tray | none yet — world setup | projects, terminal |
| MCP picker, model picker | UI: project dialog General; API: `GET /api/mcps`, `GET /api/models` | Edit Project | none yet — not written | projects |
| Regenerate Skills | UI: project-panel context menu | Right-click project | none yet — later | projects |
| Per-tool MCP scoping, token rotation | relay tray Projects tab | Relay tray | none — relay-owned | — |

### G13 · Work on a project on another machine

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Add / probe / remove SSH host | UI: project dialog host form; API: `/api/hosts`, `/api/hosts/:id/probe` | Edit Project → Where → Host… | none yet — no host in the world | hosts |
| Host status (connecting / connected / unreachable) | WS `host_status`; `ssh-host-pool.js` | Rail, panel | none yet | hosts |
| Files, search, Changes on the host | `remote-file-service.js`, `remote-fs-agent.js` | Host project Files / Changes | none yet | hosts, files, git |
| Host terminals and persistent (tmux) sessions | API: `/api/projects/:id/persistent-sessions` | Host project launcher | none yet | hosts, terminal |

### G14 · Arrange my workspace

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Tab bar, close tab ⌘W | UI: `public/tab-manager.js` | Tabs | none yet — e2e `tab-panes.spec.js` | shell |
| Split pane dock / undock / resize | UI: `core/pane-dnd.js`, `core/split-resize.js`, `panes/*` | Drag a tab onto another | none yet — e2e | shell |
| Sidebar toggle, resize, swipe | UI: `app.js` | Hamburger, drag, swipe | none yet — later | shell |
| Theme, presets, colours, typography, reset | UI: `public/dialogs/settings-dialog.js` | Settings, ⌘K Appearance | none yet — visual baselines | settings |

### G15 · Use eve from my phone

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| Safari passkey fallback | API: `GET /api/auth/safari-login`; iOS `ASWebAuthenticationSession` | iOS app sign-in | **stays human** | auth |
| Action Button → `#/voice-chat` | iOS app + hash route | Action Button | voice-deep-link (the route, from a desktop browser) | voice |
| Native voice backends, haptics | UI: `native-audio-bridge.js`, `*-native-backend.js` | iOS app | none yet — devbox pass, not Playwright | voice |
| Mobile keybar, touch scrollback, soft-keyboard resize | UI: `terminal-keybar.js`, `terminal-manager.js` | Terminal on a phone | none yet — later | terminal |

### G16 · Let a new browser in, or remove one

| Feature | Lives in | How reached | Journey today | Areas |
|---|---|---|---|---|
| First passkey enrolment (bootstrap from trusted network) | UI: `#authScreen`; API: `/api/auth/enroll/*`; `enrollment-gate.js` | First visit | **stays human** | auth |
| Add a browser inside relay's 5-minute window | `enrollment-window.js`; relay tray "Allow Eve Passkey Enrolment…" / `relay eve enrol` | Tray, then eve | **stays human** | auth |
| List / revoke passkeys | relay tray Passkeys / `relay eve revoke`; `passkey-sync.js` | Relay tray | **stays human** | auth |

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
    journeys: [landing-view]
  home:
    code: [public/home-screen.js, public/dialogs/command-palette.js, public/apple/home.css, public/apple/palette.css]
    tests: [test/unit/command-palette.test.js, test/unit/session-recents.test.js, test/e2e/app.spec.js]
    journeys: [landing-view, world-projects-listed]
  shell:
    code: [public/tab-manager.js, public/panes/**, public/sidebar-renderer.js, public/modal-manager.js,
           public/toast.js, public/dialogs/dialog-base.js, public/apple/shell.css, public/apple/panes.css,
           public/apple/modals.css, public/apple/menus.css, public/apple/toast.css]
    tests: [test/unit/tab-manager-logic.test.js, test/unit/pane-registry.test.js, test/e2e/tab-panes.spec.js,
            "test/visual/**"]
    journeys: []
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
    journeys: [chat-reply, open-existing-thread]
  terminal:
    code: [ws/terminal-messages.js, terminal-paste.js, public/terminal-manager.js, public/terminal-keybar.js,
           public/apple/terminal.css]
    tests: [test/unit/terminal-*.test.js, test/unit/message-dispatcher-terminal-request.test.js,
            test/integration/terminals.test.js, test/e2e/terminal-reconnect.spec.js]
    journeys: [terminal-on-request]
  tasks:
    code: [public/dialogs/task-dialog.js, public/task-manager.js, public/task-viewer.js]
    tests: [test/unit/task-*.test.js, test/integration/tasks.test.js, test/e2e/task-dialog-models.spec.js,
            test/e2e/schedules-and-connection.spec.js]
    journeys: [task-created-listed]
  files:
    code: [ws/file-messages.js, file-handlers.js, file-service.js, file-watcher.js, public/file-browser.js,
           public/file-editor.js, public/html-preview-pane.js, public/viewers/**, public/sidebar/file-tree-node.js,
           public/sidebar/file-icons.js, public/sidebar/project-tree.js, public/apple/editor.css,
           public/apple/viewers.css]
    tests: [test/unit/file-*.test.js, test/unit/files-route.test.js, test/unit/iframe-sandbox-guard.test.js,
            test/unit/language-detect.test.js, test/unit/static-exposure.test.js, test/integration/file-ops.test.js,
            test/integration/static-mounts.test.js, test/integration/binary-proxy.test.js]
    journeys: []
  git:
    code: [ws/git-messages.js, git-service.js, public/sidebar/changes-panel.js, public/diff-viewer.js,
           public/panes/diff-pane.js]
    tests: [test/unit/*git*.test.js, test/unit/changes-panel.test.js, test/unit/diff-viewer.test.js,
            test/integration/git-changes.test.js, test/e2e/changes-panel.spec.js]
    journeys: []
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

- **Nightly budget.** The seven journeys' timeouts sum to 630 s (10.5 min)
  worst case, already over the 10-minute ceiling before any new journey. Each
  must-have added needs a tight timeout, or journeys sharing a page (for
  example G2 → G3 → G6 in one browser) to stay under it.
- **Partial coverage.** Four goals marked must-have above have a journey that
  covers one step, not the goal: G3 (Sessions tab only), G4 (no reload),
  G5 (no run, no history), G2 (no Stop). T2 would extend those journeys
  rather than add new ones.
- **Model-dependent features** (tool blocks, question options, generated
  images, AI search summary, agent image tabs) need a scripted or
  deterministic model in the devbox world before a journey can judge them.
- **Human gates** (G8 answers, G15 Safari sign-in, G16) stay human. A journey
  may check that a gate appears, never answer it.
- **Relation to README.** `README.md`'s "Feature map" section documents the
  existing journeys' locators and traps. This file is the goal-level map; T3
  decides whether the README section folds in here.
