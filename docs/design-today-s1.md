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

**S1-A2 · Nothing opens by itself.** A terminal that already exists on relay
(at page load, or after a reconnect) creates no tab and no xterm, and does not
take focus. It is listed in the project's Sessions panel and opens on click.
Today stays visible.

**S1-A3 · Truthful states.** One word, one meaning, in Today, the sidebar and
the summary line:

| State | Means | Shown as |
|---|---|---|
| running | a turn is in progress in a thread this browser has open, or a scheduled task run is executing | pulsing dot, in Running, counted in the summary |
| waiting | a permission request or question is open for a thread this browser has open | amber dot, in Needs you: "waiting for you" |
| failed | the last turn of an open thread ended in an error, or a task's last run failed; cleared by the next turn or run | red dot, in Needs you, with the reason in plain words |
| open | the provider process is alive (`live`) and nothing else is known | no dot, no count |

a. A live but idle thread is not running. It has no dot and is not counted.
b. A thread this browser has not joined has no turn state, because relay only
   delivers a thread's frames to its joined viewers. eve shows nothing rather
   than guess.
c. With relay unreachable at load, eve does not say "Start with a project" or
   "Nothing yet". Each part that needs relay shows its own "Can't reach relay"
   line with Retry, beside the connection banner. First-run is offered only when
   projects loaded and there are none.
d. An empty Needs you says "Nothing needs you" only when its sources loaded.

**S1-A4 · Home | Work.** A two-option switch (Home | Work) in the rail header,
default Work, persisted in `eve-mode`. A project is visible in mode *m* when its
`mode` is *m* or `both` (missing means `both`). Switching filters the rail,
Today's parts, the project panel's lists and ⌘K (projects and their sessions).
It never closes an open tab. Zero in-mode projects (with some loaded) says so
and offers the other mode; it is not first-run. relay enforces access; this is
presentation only.

**S1-A5 · Ask with typing and Return.** Return in the Ask box creates one thread
in the current mode's default project (`default_for` includes the mode) and
sends the text as its first message. No dialog opens at any point. Shift+Return
adds a line; empty text does nothing.
- Project: the mode's default; with none and exactly one in-mode project, that
  one; otherwise an inline project pick in the Ask box (no dialog), remembered.
- Model: the model last used by Ask (`eve-ask-model`), else the first model the
  chosen project allows. Provider defaults apply as for every chat launch
  (`applyChatDefaults`).
- Failure keeps the typed text and says what happened in plain words
  ("That model isn't allowed in this project"), never `HTTP 400: {...}`.
- Relay down: the box stays, Send is disabled, and the line says why.

**S1-A6 · Parts are independent.**
- Each part loads independently. A part whose source fails shows its own one-line
  error with Retry while the others render normally; a slow part shows a skeleton
  while the others are usable (typing in Ask works while another part loads).
- A bus event updates only the parts that subscribe to it; nothing re-renders
  Today as a whole. Ask's DOM node and typed text survive any session or
  project event.
- Parts register by id and mode; adding one needs no edit to the Today layout
  code. Today lays out the parts registered for the current mode in `order`.
- A part that throws in `mount`, `refresh` or `destroy` becomes its own error
  line; no other part is affected.

**S1-A7 · mode and default_for reach the client.** `normalizeProject` carries
`mode` (`home`|`work`|`both`, default `both`) and `default_for` (default `[]`).
The project token still never crosses.

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

- `ctx`: `{ bus, state, container, mode(), sources, activity }`.
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
  source. Two parts on one source fail together; that is accepted and is not
  cross-part coupling.
- **Activity** (`public/core/session-activity.js`, pure, unit-testable) derives
  running/waiting/failed per thread from the frames the dispatcher already
  receives (`dispatch(data)` is the one inbound seam) and from eve's own outbound
  `user_input` and `permission_response`. It exposes `statusOf(sessionId)` and
  emits `SESSION_ACTIVITY`. `StateStore.addSession` keeps `active` meaning
  "provider alive" and Today stops reading it as "running".

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
      open from a listing; sources report errors; the summary and dots read
      activity, not `live`.
- [ ] **T3 · Parts**: `public/today/` registry, `TodayPart`, host, the seven
      parts; `home-screen.js` becomes the host; Ask focus.
- [ ] **T4 · Mode**: `normalizeProject` fields; `StateStore` mode and the one
      filtering choke point (`getVisibleProjects` plus a session counterpart);
      the switch; persistence.
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
`public/message-dispatcher.js` (observe call), `public/terminal-manager.js`
(`onTerminalList`), `public/app.js` (loaders report to sources, focus),
`public/sidebar/activity-rail.js`, `public/sidebar/project-tree.js`,
`public/dialogs/command-palette.js`, the Home CSS, `docs/FEATURES.md`,
`docs/baseline.md`, `CLAUDE.md` (localStorage keys).

Not touched: the five CRLF files (`public/tab-manager.js`, `public/file-editor.js`,
`public/sidebar-renderer.js`, `routes/index.js`, `ws-handler.js`) unless a task
forces it, and then patched in place; `devboxverify/` (cross-repo contract,
owner-owned); `test/visual/__baseline__` (macOS only); relay and relayScheduler
(read references).

## Relay and the fake

S1 adds no relay or relayScheduler call. Ask uses `POST /api/sessions` through
the existing `create_session` path; mode and `default_for` come from the
`GET /api/projects` answer the fake already carries (pinned). So no new fake
route and no new pin.

The specs need faults and delays on routes the fake already serves. The fake
gains test-side `failRoute` and `delayRoute` for `GET /api/tasks` (and the
others it serves). The injected failure answers with a body relay or
relayScheduler really sends, with that text added to `relay-source-pins.test.js`
and a case in `relay-fidelity.test.js`. These helpers add no behaviour a real
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
| `goals/home-screen`: relay unreachable at load | asserts "Start with a project" | asserts the can't-reach line and Retry, and that first-run is not offered | A3c |
| `goals/g3-reopen-thread`: running marks | a live thread shows the running dot and counts | a live idle thread shows neither; a running turn does | A3 |
| `goals/g1-landing`: summary and focus | subtitle from `active` | subtitle from activity; Ask is focused | A1, A3 |
| `test/visual` Home baselines | pixel baselines of the old Home | owner re-baselines on macOS | A1 |

## Out of scope

iPad and iPhone layouts, 44pt targets (S2). Home mode content and the Morning
brief (S3). Research (S4). Workbench, Routines, Threads and Projects spaces
(S5). Capture and notifications (S6). The project dialog's mode control
(#38 T4) and setting a default project from eve. The Settings sheet. The
"Today after 60 minutes away" front-door rule: S1 keeps today's restore of
open chat and file tabs and shows Today when none is active. Custom parts (#117).

## Open questions for the reviewer

1. Persistent-session reattach on SSH host projects
   (`terminal-manager.js#autoReattachPersistentSessions`) opens tmux sessions
   the user explicitly persisted. Default here: it keeps adding background tabs
   but never takes focus. Alternative: it too opens nothing. A2 is written for
   terminals relay lists; this is the edge.
2. Where the switch lives. Default: the rail header. The epic says "the
   wordmark is the switch"; the wordmark arrives with the S2 layouts.
3. Terminals do not appear in Today in S1. They stay in the sidebar. Is that
   enough discoverability for "terminals stay first-class" until S5's agent
   board?

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
