# S5b · Routines

Slice S5b of Epic #34 (T5, second half). Intent: `design/homework/index.html`, mockups 04 and 12. Builds on S1, S2 and S5a ([design-workbench.md](design-workbench.md)).

## User story
As the owner, I would like my scheduled tasks to read as plain sentences with their last result. I'd like to turn a useful thread into a routine, find results on Today, and see what a routine's project touched. Then I can trust what runs while I'm away.

## Acceptance criteria

**S5b-A1 · Sentences.**
- The Routines page is a main-area tab, `#routines`. There is only one, and it isn't persisted.
- Doors: the ⌘K action `action:routines` ("Routines"), the project page's "All routines" link (`project-routines-<id>`), and the deep link.
- It lists the routines in in-mode projects, sorted by project, then name.
- Each row shows the sentence, then name · project, then the result.
- The project page's section becomes "Routines" and shows the same sentence and result.

| Stored | Sentence |
|---|---|
| `daily {time}` | Every day at 07:00 |
| `weekly {day,time}` (full or short day name) | Every Monday at 08:00 |
| `hourly {minute}` | Every hour at :15 |
| `interval {minutes}` | Every minute / Every 30 minutes / Every hour (60) / Every 2 hours (multiples of 60) |
| `once {at}` | Once, Thu 2 Oct at 09:00 (local time; the year is added when it isn't this year) |
| `on_demand` | When I ask |
| `cron "M H * * *"` / `"M * * * *"` | Same as daily / hourly |
| any other cron form | Custom schedule |
| missing or unparseable | No schedule |

Result. The checks run in order and the first match wins:
1. Paused: `!enabled`, except a `once` routine that has run.
2. running now: `lastStatus` is `running`.
3. ran <when> · ok: `lastStatus` is `success`.
4. failed <when> · <reason>: `lastStatus` is `error` or `timeout`.
5. never ran: anything else.

`<when>` is `07:00` today, `yesterday 17:30`, `Mon 08:00` within six days, else `2 Oct 08:00`. It is read from `lastRun`, which relayScheduler rewrites when a run finishes (`store.go SetLastRun`).

`<reason>` comes from the newest history entry:
- `took too long` for a timeout;
- `exited <code>` for a terminal run;
- otherwise the first line of `error`, at most 80 characters;
- `no reason given` when there is none.

A row with no history loaded yet shows `failed <when>` alone.

Taps:
- A row opens the routine sheet, `routine-sheet-<taskId>`.
- The sheet shows the sentence, the name, the project and the result.
- It has three actions: Run Now (`routine-sheet-run`), Edit (`routine-sheet-edit`, which opens the existing dialog) and Open last run (`routine-sheet-open-last`). Open last run shows only when there is a last run.
- Last-five runs and Delete are not part of this slice.

Page and source states:
- The tasks source down with relay up: "Can't reach the scheduler." with Retry.
- Loaded but empty: "Nothing scheduled in <Mode>."

**S5b-A2 · Make this a routine.**
- `thread-make-routine` sits in the chat header. It shows only when the active tab is a chat thread that has a first user message and isn't a task run.
- It opens a panel, `routine-panel`. On wide and regular screens the panel docks on the right; on compact it is a full-width sheet.
- Pre-fill:
  - name: the thread's title, at most 60 characters;
  - prompt: the text of the first `role:'user'` entry in `state.sessionHistories`, editable;
  - model: the thread's model. If `modelsForProject` no longer offers it, the first model it does offer, with the line `routine-panel-model-note`: "<old> isn't allowed in <project> now, so this uses <new>.";
  - project: the thread's project.
- When: one of four chips, Every day, Every <weekday>, Every hour and When I ask. Day and weekday take a time; hour takes a minute. The default is Every day at 09:00.
- Read-back (`routine-panel-sentence`): "<sentence>, in <project>, using <model label>." The sentence comes from the same formatter as A1.
- Create (`routine-panel-create`):
  - calls `POST /api/tasks` with `{ name, projectId, prompt, model, schedule, enabled: true, sessionType: 'headless', catchUp: false }`;
  - closes the panel;
  - the new row on `#routines` has exactly the read-back's sentence.
- A failed create keeps the panel open and shows the existing `task-save-error` toast.

**S5b-A3 · Results on Today.**
- A Today part, `routines` (order 25, both modes, source `tasks`), lists the in-mode routines whose `lastRun` falls in the last 24 h and whose status is `success`, `error` or `timeout`.
- Newest first, at most 10, then "+N more".
- A row (`today-routine-<taskId>`) shows the name, then `<HH:MM> · ok|failed · <first line>`:
  - ok: the first non-empty line of `response`, at most 120 characters;
  - failed: the A1 reason.
- Tapping a row calls `taskViewer.openLastRun` and marks the run seen. Nothing opens by itself.
- Unseen means a finished run this device hasn't opened. The count shows in the part's eyebrow only, as `today-routines-unseen` ("2 new"). It is stored in `eve-routines-seen` (`{ taskId: lastRun }`, pruned to known tasks).
- The part is hidden when nothing ran.
- With the tasks source down, the part shows the source's line ("Can't reach the scheduler." when relay is up) with Retry, never an empty message.

**S5b-A4 · What did it touch.**
- The sheet's section `routine-sheet-audit` loads once each time the sheet opens. It is never polled.
- It shows up to 50 rows, newest first, as `routine-audit-row`: time · tool · allowed|denied.
  - denied means `denied`, `unauthorized` or `throttled`; every other outcome is allowed.
- No args, error text or actor details reach the browser.
- Caption: "Tool calls <project> made through Relay. A model's built-in tools aren't listed."
- Other states:
  - auditing off: "Relay isn't recording tool calls.";
  - no rows: "No tool calls through Relay for <project> yet.";
  - failure: "Couldn't load tool calls." with Retry.

**S5b-A5 · Vocabulary and Advanced.**
- "Tasks" becomes "Routines" in every string listed under Vocabulary.
- The dialog's Type select and the terminal fields move inside `<details data-testid="task-dialog-advanced">`.
- The fold is closed unless the routine being edited is a terminal routine.

## What I'd notice
Routines read like sentences. A thread offers "Make this a routine", and the morning's results wait on Today.

## Interfaces

```js
// public/core/routine-sentence.js (pure, UMD like task-schedule.js; uses TaskSchedule.normalizeDay)
RoutineSentence.sentence(schedule) → string
RoutineSentence.fromChoice({ when: 'daily'|'weekly'|'hourly'|'on_demand', day, time, minute }) → schedule
RoutineSentence.toChoice(schedule) → choice | null      // null: interval, once, cron, unknown
RoutineSentence.when(iso, now = new Date()) → string
RoutineSentence.result(task, lastExec = null, now) → { kind: 'ok'|'failed'|'never'|'paused'|'running', text }
RoutineSentence.firstLine(text, max = 120) → string
```

Parser table (`fromChoice`): Every day at T → `{type:'daily',time:T}`; Every <Day> at T → `{type:'weekly',day:'<lowercase full>',time:T}`; Every hour at :M → `{type:'hourly',minute:M}`; When I ask → `{type:'on_demand'}`.

Round trip:
- For every choice c, `toChoice(fromChoice(c))` equals c.
- For every daily, weekly, hourly and on_demand shape, `fromChoice(toChoice(s))` equals s with the day normalized.

```js
// panes/routines-pane.js
panes.registerType({ type: 'routines', create: () => ({ id: 'routines', type: 'routines', label: 'Routines' }),
  view: () => 'routines', hash: () => '#routines' });   // no persist
panes.registerView({ view: 'routines', elementId: 'routinesPane', splittable: false, show });
// routines-page.js:  class RoutinesPage { constructor(container); open(); show(); render(); openSheet(taskId) }   feature 'routinesPage'
// routine-audit.js:  class RoutineAudit { constructor({ container, projectId }); mount(el); destroy() }
// routine-panel.js:  class RoutinePanel { constructor(container); open(sessionId); close() }   feature 'routinePanel'
// today/parts/routines-part.js: class RoutinesPart extends TodayPart   // id 'routines'
// today/sources.js: TodaySource gains `downText`; tasks passes "Can't reach the scheduler."
//   describe(): relay down → "Can't reach relay."; else network/timeout/404/502/503/504 → downText
// core/api-client.js: getProjectAudit(projectId)
// project-audit.js (server): projectAudit(relayTransport, projectId) → { status, body }; toAuditRow(ev)
```

Eve route:
```
GET /api/projects/:id/audit            (requireAuth)
200 { recording: true,  records: [{ ts, tool, outcome, allowed }] }
200 { recording: false, records: [] }
404 { error: 'Project not found' }     // id not in eve's project cache
502 { error: 'Service unavailable' }   // relay unreachable, or any other non-2xx
```

Test ids:
- page and sheet: `routines-page`, `routines-count`, `routine-<taskId>` (`.routine-row__sentence`, `.routine-row__result[data-kind]`), `routine-sheet-<taskId>`;
- panel: `routine-panel-{name,prompt,when-daily,when-weekly,when-hourly,when-on_demand,day,time,minute,model}`, `routine-panel-cancel`;
- the rest are named in the criteria above.

Existing ids stay: `project-task-*`, `project-tasks-count`, `project-task-new-<id>`, `dialog-task-dialog`, `task-dialog-item-*`, the form field names, `task-save-error`, `task-model-required`.

## Relay and the fake
Two new relay calls, both `ClassRead` and both reachable (proof in the issue):
1. `GET /api/audit/log` answers 200 `{path}` when auditing is on and 400 `{"error":"auditing is disabled"}` when it is off (`ops.go` 185-189). The path is thrown away and never forwarded.
2. `GET /api/audit?project_id=<id>&event=call_tool&limit=50&deep=true`.
   - Without the first call, eve can't detect "off": `Query` answers `[]` when auditing is off (`ops.go` 121-133).
   - `deep=true` because the in-memory ring is 1,000 events shared by every project and isn't refilled from disk on start (`audit.go` 477, 854). A deep query reads at most 8 MB.

Fake additions:
- `GET /api/audit`, with `parseAuditQueryParams`' 400s (`limit: "x" is not an integer`, `deep: "x" is not a boolean`), `actor.project_id`, `event`, `limit` (default 200), newest first, and `[]` when off;
- `GET /api/audit/log`;
- controls `seedAudit(events)`, `setAuditEnabled(on)` and `schedulerDown(on)` (`/api/tasks*` answers text/plain 502 `bad gateway`);
- the fidelity fix: `finishTask` sets `lastRun` to `completedAt`.

Pins:
- relay `audit_routes.go` (both `rr.Handle` lines, the limit message);
- `ops.go` (`"auditing is disabled"`, `return []AuditEvent{}, nil`);
- `audit.go` (`json:"project_id,omitempty"`, `json:"tool,omitempty"`, `AuditOutcomeDenied`);
- `api_credential.go:275` (`frontendConsumerClasses`, which must contain `control.ClassRead`);
- `enhanced_services.go` (`"bad gateway", http.StatusBadGateway`);
- scheduler `store.go` (`t.LastRun = time.Now().UTC()`) and `scheduler.go` (`s.store.SetLastRun(task.ID, exec.Status)`).

## Red-first specs
| Spec | Criterion |
|---|---|
| Unit `routine-sentence`: every row of the A1 table; the interval hour forms; `once` in two time zones (`inZone`); `when` for today, yesterday, this week and older; each `result` kind, including the `once` Paused rule; the parser table and round trip | A1, A2 |
| `goals/routines-page`: ⌘K "Routines" and `project-routines-alpha` open one `#routines` tab; one seeded routine per kind shows its sentence; ok, failed with the history error, never and Paused; an out-of-mode routine isn't listed; `schedulerDown` shows "Can't reach the scheduler" and Retry, and never "Nothing scheduled" | A1 |
| `goals/routines-make`: a thread's header action opens the panel with its prompt, model and project; with the model removed from `allowed_models`, the first allowed model and the note; Every Monday at 08:00 reads "Every Monday at 08:00, in Alpha, using Fake Model."; Create sends one `POST /api/tasks` with the weekly schedule; the `#routines` row has the same sentence; no button on a task-run tab | A2 |
| `goals/routines-today`: two runs in the last 24 h and one older; the part lists two with the reply's first line and "2 new"; a tap opens the run and leaves "1 new"; a reload doesn't open anything; the part is hidden with none; `schedulerDown` shows the line and Retry | A3 |
| `goals/routines-audit`: seeded allowed and denied rows render time · tool · allowed or denied; the page has no args text; the off state; a 502 shows "Couldn't load tool calls." | A4 |
| Unit `project-audit`: `toAuditRow` drops args, actor, error and result fields; the denied mapping; an unknown project gives 404; disabled gives `recording:false` | A4 |
| Fidelity: the direct audit cases above; through eve: on, off, 404 and 502 | A4 |
| `g5-tasks`: the Advanced fold is closed for a chat routine and open when editing a terminal routine | A5 |

### Specs that change on purpose
No assertion is weakened; only the strings and the door change.

| Spec | Change |
|---|---|
| `g5-tasks` :23, `task-dialog-models` :44 | open `task-dialog-advanced`, then the same `selectOption` |
| `g5-tasks` :28, `task-dialog-models` :66/77/109, `schedules-and-connection` :18 | 'Create Task' → 'Create routine' |
| `g5-tasks` :119 | `Delete task "Doomed"?` → `Delete routine "Doomed"?` |
| `task-dialog-models` :67 | `…saving this task.` → `…saving this routine.` |
| `workbench-page` :53 | headings `['Agents','Threads','Routines']` |
| `g12-projects` :65 | `1 task(s) will be deleted.` → `1 routine(s) will be deleted.` |
| unit `task-manager-save-errors` :34 | `Couldn't save the routine: …` |
| visual `chat-*` | the header button; the owner re-baselines on macOS |

## Vocabulary
- `project-page.js`: Tasks → Routines; `+ New Task` → `+ New routine`.
- `task-dialog.js`:
  - title and tab label → Routines;
  - `No routines for this project.`;
  - `Task Name` → `Routine name`;
  - `Create routine` / `Update routine`;
  - the model toast;
  - the delete confirm.
- `task-manager.js`: both save toasts.
- `needs-you-part.js`: `routine timed out` / `routine failed`.
- `running-part.js`: `routine`.
- `projects-part.js`: the empty-state copy.
- `app.js:1138`: `routine(s) will be deleted`.
- Unchanged: the dead legacy task UI (`sidebar-renderer.js`, `#taskModal`, which has no `#projectList` to render into), the `Run Now` title, `View Last Run`, the schedule option labels, the area `tasks` and the journey id.

## devboxverify
`task-created-listed` keeps its id and flips:
- 'Create Task' → 'Create routine';
- the Type select sits behind Advanced;
- new: after the create, `#routines` lists the routine with "When I ask".

New `routine-from-thread` (areas tasks, chat, home; needs project:acme; 120 s):
1. Start an Acme thread with a nonce prompt and wait for the reply.
2. Click `thread-make-routine`.
3. Choose tomorrow's weekday at 08:00, then Create routine.
4. Verdict:
   - exactly one new Acme routine at the scheduler, `weekly`, with that day, `08:00`, the nonce prompt and the thread's model;
   - the `#routines` row's sentence equals the read-back's;
   - no run started.
5. The routine is deleted in `finally`, so it never fires on the devbox.

New `routine-touched` (areas tasks, terminal; needs project:acme; 90 s). This is feasible today:
1. Open a World probe terminal in Acme and type `<relay> mcp call --tool mail_list_accounts --args '{}'` and the same for `contacts_list`. This is the same deterministic pair relay's `tool-call-audited` uses (`journey_api.go` 21-22).
2. Create an on-demand Acme routine through eve's API.
3. Open its sheet.
4. Verdict: within 10 s the sheet lists `mail_list_accounts · allowed` and `contacts_list · denied`, matching what `relay audit --event call_tool --json --tail 5` says, and the eve route's body has no `args` key. If `relay audit` doesn't show that allowed/denied pair, the result is BLOCKED.
5. Clean up the routine and close the terminal.

The nightly gains about 120 s.

## Risks
- History fetches: Today fetches at most 10 histories, and the page fetches only failed rows, at most 20. Both are cached per (taskId, lastRun) and never polled.
- The deep audit read of up to 8 MB runs only when a sheet opens.
- Real failure errors may read badly even as one line.
- Script order: `core/routine-sentence.js` loads after `core/task-schedule.js`; the pages after `sidebar/*`; the part with `today/*`. Restart eve after the `index.html` edit.

## Not verifiable unattended
A real 07:00 run waiting on Today the next morning; the panel on a real iPad or iPhone; the auditing-off state on real relay (relay's remote listener needs auditing, so it is tested against the fake only).

## Out of scope
Every weekday, several days and monthly (relayScheduler `days`); "Can reach" in words; filtering the audit per run; last five runs; ping-me; Results land.

## Size
L. About 22 files, ~1,600 product lines and ~1,200 spec and journey lines. Cut line: A5 and A1 first, then A2, then A3, then A4.
