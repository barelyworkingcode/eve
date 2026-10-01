# S1 · Today on the Mac, Work mode

Slice S1 of Epic #34. Delivery order and the epic's acceptance criteria are in
[#34](https://github.com/barelyworkingcode/eve/issues/34) and its part-contract
comment; mode semantics are in #38. Design: `design/homework/index.html`.

S1 changes behaviour. It is not a re-skin: five things a person notices change,
and the specs that pinned the old behaviour change with them, each citing the
criterion below.

## User story

As the owner, I would like eve to open to my day with the Ask box ready, show
only the room I am in (Home or Work), tell me the truth about what is running,
failing or waiting for me, and let me ask a question by typing and pressing
Return, so I can get going without choosing anything first.

## Acceptance criteria

Numbered so a spec, a flipped assertion and the PR can cite them.

**S1-A1 · Opens to Today, Ask focused.** With no restored tab, eve shows Today
and the Ask box has focus, so typing needs no click. Opening Today makes no LLM
call and creates no session.

**S1-A2 · Nothing opens by itself.** A terminal that relay lists (`terminal_list`,
at page load or after a reconnect) creates no tab and no xterm, and does not take
focus. It is listed in the project's Sessions panel (and counted there) and opens
on click, through `terminalManager.openTaskTerminal`, which already builds the
xterm from `allTerminals`. Today stays visible. A `#terminal/<id>` link to a
listed but unopened terminal opens it the same way. A late `terminal_joined`
for an unopened terminal does not activate it. Carve-out: persistent-session
reattach on SSH host projects (tmux sessions the user explicitly persisted) still
adds background tabs, but never takes focus.

**S1-A3 · Truthful states.** One word, one meaning, in Today, the sidebar and
the summary line:

| State | Means | Shown as |
|---|---|---|
| running | a turn is in progress in a thread this browser has joined, or a scheduled task run is executing (`lastStatus` `running`) | pulsing dot, in Running, counted in the summary |
| waiting | a permission request is open for a thread this browser has joined | amber dot, in Needs you: "waiting for you" |
| failed | the last turn of a joined thread ended in an `error` frame that names its session, or a task's `lastStatus` is `error` or `timeout`; cleared when the next turn starts or the task's `lastStatus` becomes `running` | red dot, in Needs you, with the reason in plain words |
| open | the provider process is alive (`live`) and nothing else is known | no dot, no count |

a. A live but idle thread is not running. It has no dot and is not counted. The
   same holds everywhere `active` was read as "running": the rail dot, the
   project panel's session dot, the palette's live mark, and the terminal badge
   (which says "open" or "stopped", not "running").
b. A thread this browser has not joined has no turn state, because relay only
   delivers a thread's frames to its joined viewers. eve shows nothing rather
   than guess. State is in memory: a reload forgets it until frames arrive. It is
   also cleared on going offline, on a browser reconnect, and on `session_joined`
   and `session_ended`, so a turn that finished during a disconnect never stays
   "running". An `error` frame without a `sessionId`, and `resume_required`
   (eve resumes it itself), never mark a thread failed. A question
   (`AskUserQuestion`, `ExitPlanMode`) is a block inside `llm_event` handled only
   for the current thread, so S1 does not claim "waiting" for it.
c. With relay unreachable at load, eve does not say "Start with a project" or
   "Nothing yet". Each part that needs relay shows its own "Can't reach relay"
   line with Retry, beside the connection banner. First-run is offered only when
   projects loaded and there are none.
d. An empty Needs you says "Nothing needs you" only when its sources loaded.

**S1-A4 · Home | Work.** A two-option switch (Home | Work) in the rail header,
default Work, persisted in `eve-mode`. A project is visible in mode *m* when its
`mode` is *m* or `both` (missing means `both`). Switching filters the rail,
Today's parts, the project panel's lists and ⌘K (projects and their sessions).
It never closes an open tab. It can move the view: when the active project is out
of the new mode, `ProjectTree` activates the first in-mode project and the tab
bar follows that project (its last tab, or Today if it has none); with no in-mode
project the view is Today. Sessions without a project show in both modes. A URL
scope (`scopedProjectId`) wins over mode. Zero in-mode projects (with some
loaded) says so and offers the other mode; it is not first-run. relay enforces
access; this is presentation only.

**S1-A5 · Ask with typing and Return.** Return in the Ask box creates one thread
in the current mode's default project (`default_for` includes the mode) and
sends the text as its first message. No dialog opens at any point. Shift+Return
adds a line; empty text does nothing.
- Project: the mode's default; with none and exactly one in-mode project, that
  one; otherwise an inline project pick in the Ask box (no dialog), remembered.
- Model: the model last used by Ask (`eve-ask-model`), else the first model the
  chosen project allows. Provider defaults apply as for every chat launch
  (`applyChatDefaults`). Return waits for the model list; if it failed to load,
  or no model is allowed, Send is disabled with a line and Retry.
- First message: Ask records a pending request; `handleSessionCreated` (which
  opens the thread) then sends the text through a `sendUserText(sessionId, text)`
  extracted from `app.js#handleSubmit`, with the optimistic render and
  `markLocalSubmit`.
- Failure: relay's refusals reach the browser as a session-less `error` frame
  (`{type:'error', message}`). The pending-request marker lets the dispatcher
  attribute it to Ask; a table maps the pinned messages ("model not allowed for
  this project", "is a remote project and cannot host a session", launch and
  host-unavailable) to plain words and any other gets a generic line. The typed
  text is kept. The refusal also lands in the chat pane as today; the Today line
  is the user-facing one.
- Relay down, or zero in-mode projects: the box stays, Send is disabled, and the
  line says why ("Can't reach relay", "No projects in Work yet").

**S1-A6 · Parts are independent.**
- Each part loads independently. A part whose source fails shows its own one-line
  error with Retry while the others render normally; a slow part shows a skeleton
  while the others are usable (typing in Ask works while another part loads).
  Parts that share a source fail together; that is accepted and is not
  cross-part coupling.
- A slow or failed tasks call never delays projects, sessions, tab restore or
  Ask. Today, `loadProjects` awaits `loadAllTasks` and `onWebSocketReady` chains
  sessions, tab restore and the hash route behind it; S1 starts tasks without
  that await. Task runs are headless sessions identified by task data, so
  Continue (and the palette and sidebar, on `TASKS_LOADED`) never list a run as
  a thread: Continue stays `loading` until the tasks source answers, and shows
  its own error and Retry if tasks fail, rather than listing runs.
- A bus event updates only the parts that subscribe to it; nothing re-renders
  Today as a whole. Ask's DOM node and typed text survive any session or
  project event.
- Parts register by id and mode; adding one needs no edit to the Today layout
  code. Today lays out the parts registered for the current mode in `order`.
- A part that throws in `mount`, `refresh` or `destroy` becomes its own error
  line; no other part is affected.

**S1-A7 · mode and default_for reach the client.** `normalizeProject` carries
`mode` (`home`|`work`|`both`, default `both`) and `defaultFor` (relay's
`default_for`, default `[]`; camelCase like every other field). The project
token still never crosses.

**S1-A8 · Project chips work.** Clicking a project chip on Today activates that
project (panel, rail highlight and chip highlight follow).

## What I'd notice

- Opening eve shows my day and a blinking cursor in Ask, even when a terminal is
  still running from yesterday.
- A thread that is merely alive no longer glows as "running". When something is
  running it is because a turn is in progress or a task is executing.
- A thread waiting on me, or a task that failed, is at the top under Needs you.
- Typing a question and pressing Return starts the thread. No launcher.
- Home and Work each show their own projects, and the choice sticks.
- If relay is down, eve says so on each card with a Retry; it does not tell me
  I have no projects.
- One card broken does not blank the page.

## Part contract

Plain classes on `window`, registered through the DI container
(`container.get('todayParts')`); no modules, no build step.

```
{ id, modes, order, mount(el, ctx), refresh(), destroy() }
```

- `ctx`: `{ bus, state, container, mode(), sources, activity }`. This and
  `TodayPart` below are scaffolding on top of the epic's contract, which names
  only the six members.
- A part owns its DOM subtree, its data fetch and its error state. It subscribes
  to the bus events it needs through `ctx.on(evt, fn)`, which `destroy()` undoes.
- `TodayPart` (base class) supplies the lifecycle for parts with data: `load()`
  returns data, `render(data)` paints it, and the base owns the three states on
  the part root as `data-state="loading|ready|error"`, the skeleton, and the
  error line with a Retry button. Ask has no `load()`.
- The host (`TodayHost`, in `home-screen.js`) mounts the parts for the current
  mode in `order`, wraps every lifecycle call in a catch that turns a throw into
  that part's error line, and never calls a part's render from another part's
  path. Switching mode destroys parts not in the new mode and mounts new ones.
- **Sources** (`public/today/sources.js`) wrap the existing loaders as
  `{ status: 'idle'|'loading'|'ready'|'error', error, ensure(), reload() }` for
  projects, sessions and tasks. The loaders today log and swallow their errors
  (`app.js#loadProjects`, `#loadSessions`, `task-manager.js#loadTasks`); they
  keep their current behaviour for the sidebar and additionally report to the
  source (a non-array tasks answer counts as an error). A source that has not
  started is `loading`, with a timeout line if the socket never opens. A projects
  Retry re-runs `setProjects`, which re-renders the sidebar; accepted.
- **Activity** (`public/core/session-activity.js`, pure, unit-testable) derives
  running/waiting/failed per thread from inbound frames only. `dispatch(data)`
  is the one inbound seam; `observe(data)` runs after the stopped-turn guard and
  before the background-session diversion, so late chunks after Stop do not
  re-mark running and background threads are seen. Running starts on
  `user_message` or `llm_event` and ends on `message_complete`; `process_exited`
  ends it, as failed only mid-turn. Waiting starts on `permission_request` and
  keeps a `permissionId` to `sessionId` map, because `permission_response`
  carries no session; it ends when `modal-manager` answers (the one outbound
  hook, after the socket-open check) or the session ends. Nothing is derived
  from outbound `user_input` (slash commands never start a turn). It exposes
  `statusOf(sessionId)` and emits `SESSION_ACTIVITY`. The dispatcher reaches it
  through `container.has('sessionActivity')`, null-safe, because its unit tests
  build it with a mocked container. `StateStore.addSession` keeps `active`
  meaning "provider alive"; nothing reads it as "running".

`summary` counts running threads only (sessions and projects, not tasks), so a
tasks outage leaves it ready; the Running part lists executing task runs too.

Test ids the specs are written against: `today-part-<id>` (with `data-state`
`loading|ready|error`), `today-error-<id>`, `today-retry-<id>`,
`today-ask-input`, `today-ask-status`, `today-ask-project`,
`today-needs-row-<id>` (`data-kind` `waiting|failed`), `today-running-row-<id>`,
`today-empty-mode`, `mode-switch` (`role="radiogroup"`) with `mode-home` and
`mode-work` (`aria-checked`).

Parts shipped in S1 (all `modes: ['home','work']`; `order` gaps leave room):

| id | order | shows | source |
|---|---|---|---|
| `summary` | 0 | greeting-line summary: N running, projects in mode, date | sessions, projects, activity |
| `ask` | 10 | the Ask box | models (state), projects |
| `needs-you` | 20 | waiting threads, failed turns, failed tasks | activity, tasks |
| `start` | 30 | the existing Start tiles (Chat, templates, Voice) | templates (state) |
| `continue` | 40 | the existing Continue list | sessions |
| `running` | 50 | running turns and executing task runs | activity, tasks |
| `projects` | 60 | the existing project chips | projects |

`start`, `continue` and `projects` keep their markup, class names and test ids,
so the existing goal specs keep passing unchanged except where listed below.
Changes and Morning brief parts are later slices; the registry makes them an
addition, not an edit.

## Tasks

- [ ] **T1 · Contract and red-first specs**: this document, reviewed; the specs
      below written and failing for the right reason before any code.
- [ ] **T2 · Truth**: `session-activity.js` and its wiring; terminals no longer
      open from a listing and the sidebar click opens them; tasks decoupled from
      the sessions chain; sources report errors; the summary and every dot read
      activity, not `live`.
- [ ] **T3 · Parts**: `public/today/` registry, `TodayPart`, host, the seven
      parts; `home-screen.js` becomes the host; Ask focus.
- [ ] **T4 · Mode**: `normalizeProject` fields; `StateStore` mode and two
      accessors: `getVisibleProjects` (URL scope only, unchanged, for session
      creation, directory lookup and the legacy select: `app.js`
      `getCurrentProjectDirectory`, `getProjectIdForDirectory`, `_resolveActiveProjectId`,
      the legacy select) and `getModeProjects` (scope plus mode, for the rail,
      `ProjectTree`, the palette's projects and sessions, Today, the favourite
      fallback); a session counterpart; the switch; persistence.
- [ ] **T5 · Ask**: the Ask part, project and model rules, the failure and
      relay-down states.
- [ ] **T6 · Docs and verification**: feature map rows, `docs/baseline.md`,
      `docs/api.md` untouched (no wire change), detection check, five-run
      stability, handoff notes.

## File ownership

New: `public/today/{today-parts,sources}.js`, `public/today/parts/*.js`,
`public/core/session-activity.js`, `public/core/mode.js` (mode state and
predicate), `docs/design-today-s1.md`, specs under `test/e2e/goals/today-*.spec.js`,
`test/unit/{session-activity,today-parts,mode}.test.js`.

Changed: `public/home-screen.js` (becomes the host), `public/index.html` (script
tags in dependency order, rail switch; restart eve to pick it up),
`public/core/state-store.js`, `public/core/constants.js`, `project-normalize.js`,
`public/message-dispatcher.js` (observe call, pending-Ask marker),
`public/modal-manager.js` (answer hook), `public/terminal-manager.js`
(`onTerminalList`, the `onTerminalJoined` fallback, reattach focus),
`public/app.js` (loaders report to sources, tasks decoupled, `sendUserText`,
hash route falls back to `allTerminals`, focus), `public/sidebar/activity-rail.js`,
`public/sidebar/project-tree.js`, `public/sidebar/project-panel.js` (terminal
click, dots, badge), `public/dialogs/command-palette.js`, the Home CSS,
`test/integration/fake-relay.js` and `harness.js`, `docs/FEATURES.md`,
`docs/baseline.md`, `CLAUDE.md` (localStorage keys `eve-mode`, `eve-ask-model`,
`eve-ask-project`). `public/sidebar-renderer.js` (CRLF) is touched only if its
"Active" label is still reachable, and then patched in place.
Script order in `index.html`: `core/session-activity.js` and `core/mode.js` after
`core/constants.js`; `today/*` after `sidebar/*` and before `home-screen.js`.
The Today host keeps `data-testid="home-screen"` on `#homeContent`.

Not touched: the five CRLF files (`public/tab-manager.js`, `public/file-editor.js`,
`public/sidebar-renderer.js`, `routes/index.js`, `ws-handler.js`) unless a task
forces it, and then patched in place; `devboxverify/` (cross-repo contract,
owner-owned) and `test/visual/__baseline__` (macOS only), both later amended (see
Amendments); relay and relayScheduler
(read references).

## Relay and the fake

S1 adds no relay or relayScheduler call. Ask uses `POST /api/sessions` through
the existing `create_session` path; mode and `default_for` come from the
`GET /api/projects` answer the fake already carries (pinned). So no new fake
route and no new pin.

The specs need faults and delays on routes the fake already serves. The fake
gains test-side `failRoute(method, path, status, body)` and `delayRoute(method,
path, ms)`, one generic hook ahead of the route table, no per-route branches.
What the browser sees on a failed hop is eve's own answer (its proxy returns 502
`{error:'Service unavailable'}`), so the fidelity case asserts what each hop
really emits, with any relay text pinned in `relay-source-pins.test.js`. The
harness gains `eve.reviveRelay(...)` (a fresh fake on `relayPort`, registered so
`stop()` closes it) for "relay down, then Retry". These add no behaviour a real
relay lacks.

## Red-first specs

Written before any code, failing for the right reason (an assertion, not a
missing import), in `test/e2e/goals/today-*.spec.js` unless noted. Each names
its criterion.

| Spec | Criterion |
|---|---|
| fresh open: Today shows, `today-ask-input` is focused, no `create_session` reached the fake | A1 |
| a terminal already on relay at load: no tab, no `#terminal`, Today visible; it is in the Sessions panel and opens on click | A2 |
| same after the browser socket is dropped and reconnects | A2 |
| a live idle thread: no dot, not in Running, summary says "Nothing running" | A3a |
| a turn in progress in an open thread: row in Running, dot, summary counts it; `message_complete` clears all three | A3 |
| a permission request: row in Needs you "waiting for you"; answered, it clears | A3 |
| a turn that ends in an `error` frame: failed row with a plain-words reason; the next turn clears it | A3 |
| a failed task run is in Needs you; an executing run is in Running | A3 |
| relay down at load: no "Start with a project", no "Nothing yet"; each relay part shows "Can't reach relay" + Retry | A3c |
| a thread this browser never joined shows no turn state | A3b |
| switch Work → Home filters rail, chips, Continue, ⌘K; `both` shows in both; missing mode is `both`; reload keeps it; open tabs survive | A4 |
| zero in-mode projects is not first-run | A4 |
| type + Return: one `create_session` in the mode's default project, the text delivered as the first message, no `dialog-*` visible at any moment | A5 |
| no default and two in-mode projects: inline pick, no dialog; one: used silently | A5 |
| Shift+Return newline; empty Return does nothing | A5 |
| allowed-models refusal: text kept, plain-words line | A5 |
| relay down: Send disabled, line says why, text kept | A5 |
| a listed terminal: its row and the Sessions count are in the panel; clicking opens it; `#terminal/<id>` opens it | A2 |
| a listed-then-joined terminal never activates; host-project reattach adds a background tab, no focus | A2 |
| mode switch while a Work file tab is active: the view lands on the first in-mode project or Today, no tab is closed | A4 |
| tasks delayed: Continue is `loading` and never lists a task run as a thread; sessions, tab restore and Ask are unaffected | A6 |
| models held: Return waits, then sends; models failed: Send disabled with Retry | A5 |
| a session-less `error` frame is shown on Ask only for a pending Ask; `resume_required` and unattributed errors never mark a thread failed | A3, A5 |
| a turn left running across a disconnect is not "running" after reconnect | A3b |
| a task with `lastStatus` `timeout` is in Needs you | A3 |
| **one part failing**: `GET /api/tasks` answers an error: `needs-you` is `data-state="error"` with Retry; `ask`, `continue`, `projects` are `ready`; fix the route, Retry, it is `ready` | A6 |
| **one part slow**: `GET /api/tasks` delayed: `needs-you` is `loading` (skeleton) while Ask takes typing and Return and starts a thread; then it becomes `ready` | A6 |
| a session update leaves Ask's node (marked with an expando) and its typed text untouched | A6 |
| a part registered at test time appears in order with no edit to the host | A6 (unit) |
| a part that throws in mount/refresh/destroy yields an error line and leaves the others | A6 (unit) |
| `normalizeProject` carries `mode` and `default_for`, defaults, no token | A7 (unit) |
| `session-activity` table: frame sequences to status | A3 (unit) |
| the project chip activates a non-active project and is marked active | A8 |

### Specs that change on purpose

Each is changed in the same commit as the code that flips it, and the PR
states it. None is weakened: where an assertion goes, a stricter one replaces it.

| Spec | Today | After | Criterion |
|---|---|---|---|
| `test/unit/project-normalize.test.js` | pins that `mode` and `default_for` are dropped | pins that they are carried | A7 |
| `goals/home-screen`: chip `test.fail` | expected failure for the inert chip | marker deleted; the test passes | A8 |
| `goals/g4-terminal`: after reload | clicks the sidebar terminal; passes only because the list auto-opened it | asserts first that no `#terminal` is open and Today is visible, then the click opens it | A2 |
| `test/unit/terminal-rejoin.test.js`: "still sets up terminals it does not hold locally" | asserts `reconnectTerminal` is called from the list | asserts the list registers the terminal and creates no tab | A2 |
| `devboxverify/journeys.js` `terminal-on-request` | expects the terminal pane to reappear within 15s of a reload | flips by design: after a reload the terminal is in the Sessions panel and opens on click. Initially left to the owner; rewritten later (see Amendments) | A2 |
| any other assertion that pins `active` as "running" or the terminal badge text "running" | found by grep during the build | listed in the PR with its criterion | A3 |
| `goals/home-screen`: relay unreachable at load | asserts "Start with a project" | asserts the can't-reach line and Retry, and that first-run is not offered | A3c |
| `goals/g3-reopen-thread`: running marks (the live-session test; the "Nothing running" dormant test still holds) | a live thread shows the running dot and counts | a live idle thread shows neither; a running turn does | A3 |
| `goals/g1-landing`: summary and focus | subtitle from `active` | subtitle from activity; Ask is focused | A1, A3 |
| `test/visual` Home baselines | pixel baselines of the old Home | owner re-baselines on macOS | A1 |

Kept literal so existing specs stay green: `.home__subtitle` and its "N
projects · date" form, the Continue empty text, the Start tiles and
`.home__eyebrow-detail`, and every `home-*` test id. `start` follows the active
project, not the mode. The owner's devbox world must have its projects in
`work` or `both` mode for `world-projects-listed` to hold under the default
Work; the owner checks `world.json`.

A8 is in the brief (step 4 of the hand-off): the `test.fail` marker is deleted
in the same commit as the fix.

## Out of scope

iPad and iPhone layouts, 44pt targets (S2). Home mode content and the Morning
brief (S3). Research (S4). Workbench, Routines, Threads and Projects spaces
(S5). Capture and notifications (S6). The project dialog's mode control
(#38 T4) and setting a default project from eve. The Settings sheet. The
"Today after 60 minutes away" front-door rule: S1 keeps today's restore of
open chat and file tabs and shows Today when none is active. Custom parts (#117).

## As built

Where the build differs from, or settles, the text above:

- **Models.** The model list already retries itself (`app.js#_scheduleModelsRetry`),
  so Ask shows "Waiting for models…" and sends when the list arrives; it has no
  separate Retry for models.
- **First message.** relay auto-joins the creator, so the browser never gets a
  `session_joined` for a new thread. Ask sends on `session_created`, and also
  records the text in the thread's history so a repaint from that history keeps it.
- **resume_required** is handled inside eve before the browser sees it, so
  `session-activity` ignores it defensively and the specs exercise only the
  session-less error.
- **Empty lines.** Needs you and Running use `.today__empty`, not `.home__empty`,
  so the existing Continue empty-state assertion still matches one element.
- **Reattach.** Persistent-session reattach on host projects never takes focus
  (`terminal-manager.js`); its background tabs are unchanged.

## Decisions taken after review

1. Reattach on SSH host projects keeps adding background tabs, never takes
   focus; A2 is scoped to relay-listed terminals and states the carve-out.
2. The switch is a segmented control (`data-testid="mode-switch"`,
   `role="radiogroup"`) in the sidebar panel header, because the rail has no
   header and is avatar-wide. It moves to the wordmark with the S2 layouts.
3. Terminals do not appear in Today in S1; they stay in the Sessions panel,
   counted. Revisit with S5's agent board.

## Size

**L.** About twenty files, roughly 1,500 lines of product code and a larger
amount of spec. Commits are ordered so each is green on its own: contract and
red specs, truth (A2, A3, A7), parts (A1, A6, A8), mode (A4), Ask (A5), docs.
If review asks for a split, the cut line is after "truth" (A2, A3, A7), which
stands alone.

## Verification

Cloud: `npm test`, `npm run test:integration`, five consecutive full
`npx playwright test --retries=0` runs, and a detection check (one deliberate
breakage at a time, each confirmed red). Owner, on the devbox: `devbox/verify`,
the journeys in `devboxverify/` (unedited here), `npm run test:visual` on macOS
and the re-baseline, and relay's real mode enforcement.

## Amendments

After the first devbox verify run on macOS, these files outside the original
ownership were changed:

- `devboxverify/journeys.js`: the journeys `terminal-on-request` (A2) and
  `world-projects-listed` (A4) were rewritten to the new criteria. They are
  stronger: negative assertions were added, and nothing was removed that the
  criterion did not change.
- `test/visual/__baseline__`: re-baselined on macOS.
- `test/unit/dir-watcher.test.js`: corrected for macOS (#124). An in-place write
  is reported as `rename` there, and events from before the start are cleared
  before the close check. Linux expectations are unchanged.
- Ask while eve's own socket is down: `ask-part.js` now blocks with a plain-words
  line when the browser socket is down, and drops a pending Ask (and the text
  queued for the next new session) when the send is lost or the connection goes
  offline. The typed text is kept. Covered by `goals/today-ask`.
