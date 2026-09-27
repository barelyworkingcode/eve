# devboxverify: design and contract

eve's layer-2 verification: drive a **running**, Relay-managed eve in a real
browser against the devboxWorld test world, and report one result per journey.
Modelled on relay's `cmd/devboxverify`: same preflight idea, same stdout
grammar, states, exit codes, `devbox/verify` status and evidence comment.
Runs on the devbox only, never in CI.

## Decisions

- **D1 · Shape.** A plain Node CLI (CommonJS, vanilla JS) in `devboxverify/`.
  It drives Chromium through the Playwright library (`chromium` from
  `@playwright/test`, already a devDependency), not the test runner, so the tool
  owns stdout. No new dependencies.
- **D2 · Target.** A second Relay-managed service, `eve-verify`, on port 3100:
  working dir = the checkout under test, args
  `--env-file=<main checkout>/.env server.js --data <dir outside any repo>`,
  capability `frontend`, no autostart. The tool never touches the live eve on
  :3000 or its checkout; preflight refuses if the target is the live eve.
  Registering the service waits on the owner (a new frontend grant) and on Q1.
- **D3 · "Running from that checkout."** Exactly one process listens on the
  `--url` port; its cwd equals `--checkout` (both `realpath`-resolved); it is
  `node … server.js`; it started no earlier than the newest mtime among the
  checkout's tracked files; tracked files are clean (untracked ignored); with
  `--post`, the PR head equals HEAD.
- **D4 · Cleanup (the sweep).** After `reset.sh`, and again after the journeys
  (best effort, stderr only), the tool deletes every session, terminal and task
  in the three world projects. `reset.sh` does not touch Relay projects. The
  sweep never acts outside the world projects; a journey that leaves anything
  outside them is FAIL and the item is left for a human.
- **D5 · Journeys create things only in Acme Corp**, the one world project whose
  allowed templates include `chat` and `world-probe`.
- **D6 · Known bugs.** A journey entry with `knownBug: '<issue ref>'` reports
  `NOTRUN` with detail `omitted: known bug <ref>` and does not run.
- **D7 · No extras.** No `--only` flag.
- **D8 · Chat reply.** `chat-reply` passes on a non-empty assistant reply with
  no error in the thread. Whether the model answered correctly goes in the
  detail, not the verdict.
- **D9 · Model.** `EVE_VERIFY_MODEL` (default `Chat`) picks the first model whose
  value equals it or ends with `/<it>`. The box's model ids stay out of the repo.
- **D10 · Nightly and `main`.** Relay: verify what is installed; no build (its
  build signs and its register is presence-gated). A relay night after a merge
  but before a rebuild is BLOCKED by preflight, and the record says so. Eve: the
  nightly worktree is dedicated, so the nightly fast-forwards it to
  `origin/main` (`merge --ff-only`), runs `npm ci` when `package-lock.json`
  changed, and restarts `eve-verify` (not presence-gated) before verifying.
  It never retries a verify.
- **D11 · AC3 with a known bug.** A journey marked `knownBug` counts as covered
  by its red `JOURNEY` line on `main` quoted in the bug issue, plus NOTRUN here
  until the fix lands.

## CLI

```
node devboxverify/main.js [--checkout DIR] [--world DIR] [--url URL] [--service ID] [--post PR]
npm run -s verify:devbox -- [flags]     # -s: npm's banner would break the stdout grammar
```

| Flag | Default | Rule |
|---|---|---|
| `--checkout` | git toplevel of `devboxverify/` | |
| `--world` | `<tool checkout>/../devboxWorld` | |
| `--url` | `http://localhost:3100` | `http:`, host `localhost` or `127.0.0.1`, explicit port; else usage error |
| `--service` | `eve-verify` | |
| `--post` | none | integer ≥ 1 |

An unknown flag, positional argument, or bad `--post`/`--url` prints one usage
line to stderr and exits 2. Environment: `RELAY_BIN` (default
`/Applications/Relay.app/Contents/MacOS/relay`, used only for
`relay service list`), `EVE_VERIFY_MODEL`. The tool writes no files and never
builds, registers or edits settings. Its own HTTP, WS and `lsof` calls go to
`127.0.0.1:<port>`; Chromium uses `--url` as given.

## Stdout grammar

Tab-separated, every line through `formatLine`, nothing else on stdout.
Progress, script output and sweep counts go to stderr.

```
PREFLIGHT <check> OK|FAIL <detail>
WORLD pass=<n> fail=<n>
RESET OK|FAIL
JOURNEY <id> PASS|FAIL|BLOCKED|NOTRUN <detail>
SUMMARY pass=<n> fail=<n> blocked=<n> notrun=<n>
POSTED success|failure|error <comment URL>
```

Preflight, in order, stopping at the first FAIL (exit 2):

| Check | OK when | Detail on OK |
|---|---|---|
| `head` | `git -C <checkout> rev-parse HEAD` succeeds | sha |
| `tree` | `git status --porcelain --untracked-files=no` is empty | `clean` |
| `service` | `serviceRowProblem` is null | `<id> running` |
| `eve` | `eveProcessProblem` is null | `pid <n>` |
| `live` | `liveEveProblem` is null | `separate from :3000` |
| `pr` (only with `--post`) | PR `headRefOid` equals HEAD | `PR head is HEAD` |
| `api` | `GET /api/projects` answers 200 with exactly one project per name in `<world>/data/world.json` | the names |
| `browser` | Chromium launches and closes | `chromium` |
| `bootstrap` | `bootstrap.sh --check` exits 0 | `complete` |
| `world` | `verify.sh` exits 0 and its last summary has `fail=0` | `green` |

Then `WORLD`, then `RESET`: OK when `reset.sh` exits 0 and the sweep leaves
zero world items. Each world script has a 300 s timeout; `verify.sh` stdout is
captured, parsed, then echoed to stderr.

Exit codes: 0 when every journey is PASS or NOTRUN; 1 on any FAIL or BLOCKED;
2 on usage, preflight, reset or post failure. `--post` runs after `SUMMARY`.

## Interfaces

### `devboxverify/main.js` (T1)

Entry point only when `require.main === module`; `@playwright/test` and
`./journeys` load lazily inside `run()`.

```js
/** @typedef {'PASS'|'FAIL'|'BLOCKED'|'NOTRUN'} State */
/** @typedef {{id: string, state: State, detail: string}} Result */
scrub(s, home) -> string
formatLine(home, ...fields) -> string
parseArgs(argv, {toolRoot}) -> {checkout, world, url, service, post}   // throws Error with .usage = true
parseWorldSummary(stdout) -> {pass, fail}                               // throws
tally(results) -> {counts: {PASS, FAIL, BLOCKED, NOTRUN}, exitCode: 0|1}
parseListenPids(lsofOut) -> number[]
parseCwd(lsofOut) -> string|null
parseLstart(text) -> number|null
eveProcessProblem({pids, cwd, command, startedAtMs, checkout, newestChangeMs}) -> string|null
liveEveProblem({port, pid, cwd, livePids, liveCwd}) -> string|null
serviceRowProblem(listOut, service, url) -> string|null
run(argv) -> Promise<number>
```

- `scrub` replaces every `home` with `~`; empty `home` is a no-op.
- `formatLine` scrubs each field, collapses whitespace runs (incl. tab, CR, LF)
  to one space, trims, joins with `\t`.
  `formatLine('/Users/someone','JOURNEY','x','FAIL','read /Users/someone/a \n then\t\t/Users/someone/b')`
  → `JOURNEY\tx\tFAIL\tread ~/a then ~/b`.
- `parseWorldSummary` takes the last line starting at column 0 with `SUMMARY\t`,
  which must match `SUMMARY\tpass=<int>\tfail=<int>`; throws otherwise.
- `tally`: exit 1 iff FAIL + BLOCKED > 0.
- `parseListenPids` reads `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fp` → unique
  ascending pids. `parseCwd` reads `lsof -a -p <pid> -d cwd -Fn` → first `n` path
  or null. `parseLstart` reads `LC_ALL=C ps -o lstart= -p <pid>` (local time,
  day may be space-padded) → epoch ms or null.
- `eveProcessProblem`, in order: `pids.length !== 1`; `cwd` null;
  `cwd !== checkout`; command is not node running `server.js`; `startedAtMs`
  null; `startedAtMs < Math.floor(newestChangeMs/1000)*1000`.
- `liveEveProblem` (`LIVE_EVE_PORT = 3000`): problem when `port === 3000`, when
  `livePids` includes `pid`, or when `liveCwd` is non-null and equals `cwd`.
- `serviceRowProblem` parses `relay service list` (space-padded table). The row
  is the first line whose first token equals `service`. Problem when no row, no
  token equals `url`, or the row does not end in `running`.
- Problem strings are one line and name the fix (e.g.
  `relay service restart --id eve-verify`). Tests assert null vs non-null.

### `devboxverify/eve-api.js` (T1)

```js
/** @typedef {{key, id, name, path}} WorldProject */
/** @typedef {{id: string, name: string, world: boolean}} Item */
/** @typedef {{sessions: Item[], tasks: Item[], terminals: Item[]}} Snapshot */
class EveApi {
  constructor(baseUrl)                                   // http://127.0.0.1:<port>
  async worldProjects(worldEntries) -> WorldProject[]    // throws naming a missing or duplicated name
  async snapshot(projects) -> Snapshot
  async sweep(projects) -> {sessions, tasks, terminals}  // counts; throws if any world item remains
}
classify({sessions:[{id,projectId,name}], tasks:[{id,name}], worldTaskIds:[], terminals:[{id,directory,name}]}, projects) -> Snapshot
added(before, after) -> Snapshot
onlyWorld(snap) -> Snapshot
onlyOutside(snap) -> Snapshot
```

- `snapshot`: sessions from `GET /api/sessions`; all tasks from `GET /api/tasks`;
  `worldTaskIds` from `GET /api/tasks?projectId=<id>` per world project;
  terminals from a WS `terminal_list`.
- `classify`: a session is world if its `projectId` is a world project id; a
  task if its id is in `worldTaskIds`; a terminal if its `directory` equals a
  world project path or starts with that path + `/` (a sibling `…/Acme Corp2` is
  not world).
- `sweep` deletes world items only (WS `delete_session`, WS `terminal_close`,
  `DELETE /api/tasks/:id`), then polls the snapshot up to 10 s and throws if a
  world item remains. It never acts on `world: false`.
- WS client: `ws` to `ws://127.0.0.1:<port>`, no Origin; waits for
  `auth_success` (loopback is trusted); unwraps `__batch {msgs}`.
- T1 first captures the real `terminal_list` reply on the devbox; the assumed
  shape `{terminals: [{id, directory, name}]}` comes from the fake relay. A
  difference comes back as a contract amendment.

### Runner, inside `run()` (T1)

One headless Chromium for the run (`--use-fake-ui-for-media-stream`,
`--use-fake-device-for-media-stream`). Per journey: `knownBug` → NOTRUN;
otherwise snapshot `before`, run with `timeoutMs` (throw → FAIL with the first
message line, ≤200 chars; timeout → FAIL `timed out after <n>s at <last step>`),
close the journey's contexts, snapshot `after`. If
`onlyOutside(added(before, after))` is non-empty the result becomes FAIL
`left <kind> "<name>" outside the world`, and the item is not deleted.

### `devboxverify/journeys.js` (T2)

```js
/** @typedef {{
 *  url, nonce /* 8 hex per run */, model /* EVE_VERIFY_MODEL */,
 *  projects: {acme: WorldProject, globex: WorldProject, home: WorldProject},
 *  api: EveApi,
 *  newPage: () => Promise<Page>,    // fresh context: empty localStorage, 1280x800
 *  step: (label) => void,           // stderr; the last label names a timeout
 *  shared: {thread?: {sessionId, question}},
 * }} JourneyEnv */
/** @typedef {{id, timeoutMs, knownBug?: string, run: (env: JourneyEnv) => Promise<Result>}} Journey */
module.exports = { journeys };   // in table order
```

Test ids and roles may be click targets, as in the e2e specs; pass checks are
user-visible text or visibility, never DOM structure. Every wait has an explicit
timeout. T2 first confirms `expect` from `@playwright/test` works outside the
runner; if not, `locator.waitFor()` and polling.

| # | id | Timeout | Steps | PASS when | BLOCKED when | Creates |
|---|---|---|---|---|---|---|
| 1 | `landing-view` | 60 s | Open `--url` | Within 20 s a greeting (`Good morning.`/`Good afternoon.`/`Good evening.`/`Working late.`) and the Start tiles "Chat" and "Voice" are visible; the passkey screen is not | — | nothing |
| 2 | `world-projects-listed` | 60 s | Open `--url` | Home Projects shows a chip for each of `Acme Corp`, `Globex`, `Home`, and the rail has an entry titled with each. FAIL names the missing | — | nothing |
| 3 | `chat-reply` | 180 s | Acme Corp → New Session → Web Chat → pick the model → Start Chat → send `What is 2 + 2? Reply with the number only. (verify <nonce>)` | The question shows as the user's message; a non-empty assistant reply within 150 s; no error; exactly one new Acme session. Sets `shared.thread`. Detail: `reply in <n>s`, and whether it said 4 | Model not offered; launch refused naming template `chat` | 1 chat session |
| 4 | `open-existing-thread` | 60 s | New context → Acme Corp → Sessions tab → click the thread | The pane shows the question (with nonce) and an assistant reply after it; no new session | No `shared.thread` | nothing |
| 5 | `terminal-on-request` | 90 s | Acme Corp; wait for the panel + 3 s; New Session → "World probe"; type `printf '%s_%s\n' EVE OK` + Enter | **A** before asking: no terminal pane, no world terminal (else FAIL "a terminal opened without being asked"). **B** after: a terminal pane shows `EVE_OK` within 20 s, exactly one new world terminal | No "World probe" card | 1 terminal |
| 6 | `task-created-listed` | 90 s | Acme Corp → Tasks → "+ New Task" → name `verify-<nonce>`, type "Chat (LLM)", prompt `Say hello.`, the model, "On demand" → Create Task | The Tasks list shows `verify-<nonce>`, still after reload. FAIL gives any error toast text | Model not offered | 1 task (never runs) |
| 7 | `voice-deep-link` | 90 s | Acme Corp → New Session → star "World voice" (Action Button favourite) → close page → new page, same context, `<url>/#/voice-chat` | Within 30 s the voice chat view shows ("End session" visible, text composer hidden) and exactly one new Acme session | No "World voice" template (setup V1) | 1 voice session |

### `devboxverify/post.js` (T3)

Does not require `main.js`.

```js
statusState(results) -> 'success'|'failure'|'error'   // any FAIL → failure; else any BLOCKED → error; else success
renderComment({pr, commit, toolCommit, worldSummary, home, results}) -> string
commentUrlFrom(ghStdout) -> string                     // last non-empty line; throws unless https://
prHead(pr, {cwd}) -> Promise<string>
post(ev, {cwd}) -> Promise<string>                     // comment URL
```

`renderComment`: heading `### devbox/verify: <state>`; a two-column table with
`Eve commit`, `World verify`, `Tool commit`; then `| Journey | Result | Detail |`
with the id in backticks and `|` escaped as `\|`; the whole thing scrubbed.
`post`: `gh pr comment <pr> --body-file -` first, then
`gh api -X POST repos/{owner}/{repo}/statuses/<commit> -f state=… -f context=devbox/verify -f target_url=<comment URL> -f description="pass=N fail=N blocked=N notrun=N"`,
cwd = tool checkout, 60 s timeout each.

### `devboxverify/nightly.js` (T4)

Node core only (installed as a copy); entry only when `require.main === module`.

```js
classify({exitCode, timedOut, blockedReason}) -> 'GREEN'|'RED'|'BLOCKED'  // reason or timeout → BLOCKED; 0 → GREEN; 1 → RED; else BLOCKED
summaryOf(stdout) -> string    // SUMMARY line, else first PREFLIGHT…FAIL line, else 'no summary'; tabs → spaces
formatRecord({at, repo, result, commit, behind, summary}) -> string
                               // NIGHT\t<at>\t<repo>\t<result>\t<commit12>\tbehind=<n>\t<summary>
parseRecords(logText) -> Record[]      // NIGHT lines only
renderStatusPage(records, {now}) -> string   // static HTML, no JS, all fields escaped; latest per repo on top, then last 60 newest-first
```

Relay, then eve, sequentially:

1. `git -C <checkout> fetch --quiet origin`; failure → BLOCKED.
2. Relay: HEAD must be an ancestor of `origin/main`, else BLOCKED; `behind` =
   `git rev-list --count HEAD..origin/main`. Eve (D10): the worktree must be
   clean and on a branch that can fast-forward; `merge --ff-only origin/main`,
   `npm ci` if `package-lock.json` changed, `relay service restart --id eve-verify`,
   wait up to 60 s for the port; any failure → BLOCKED. `behind` = 0 after.
3. Eve: no `devboxverify/main.js` in the checkout → BLOCKED.
4. Run, killed after 30 min: relay `go run ./cmd/devboxverify --checkout <relay>`
   (cwd relay); eve `node devboxverify/main.js --checkout <eve>` (cwd eve).
5. Full output to `<logdir>/runs/<YYYY-MM-DD>-<repo>.txt`; append the record to
   `<logdir>/nightly.log`.

Then rewrite `<logdir>/status.html`, and if either result is not GREEN show one
macOS notification via `osascript`, the message passed as an argument, not
interpolated. No retries; launchd does not overlap runs of one job.

Environment (from the plist): `NIGHTLY_RELAY_CHECKOUT`, `NIGHTLY_EVE_CHECKOUT`,
`NIGHTLY_LOG_DIR` (default `~/Library/Logs/devboxverify`), `PATH`,
`EVE_VERIFY_MODEL` optional.

### `devboxverify/nightly.plist.template` (T4)

Label `local.devboxverify.nightly`; `StartCalendarInterval` 03:30; `RunAtLoad`
false; `ProgramArguments` `@NODE@ @HOME@/.local/share/devboxverify/nightly.js`;
`EnvironmentVariables` `PATH=@PATH@`, `NIGHTLY_RELAY_CHECKOUT=@RELAY_CHECKOUT@`,
`NIGHTLY_EVE_CHECKOUT=@EVE_CHECKOUT@`; stdout/stderr to
`@HOME@/Library/Logs/devboxverify/launchd.log`. Placeholders only.

Install (README): create `~/.local/share/devboxverify` and the log dir; copy
`nightly.js` there; fill placeholders with `sed` into
`~/Library/LaunchAgents/local.devboxverify.nightly.plist`;
`launchctl bootstrap gui/$(id -u) <plist>`; first run with
`launchctl kickstart gui/$(id -u)/local.devboxverify.nightly`. Uninstall:
`launchctl bootout gui/$(id -u)/local.devboxverify.nightly`, remove the plist.

## One-time setup (README, T3)

- **S1 · Register `eve-verify`** (presence-gated; desktop Terminal). Waits on
  the owner and Q1.
  ```
  relay service register --id eve-verify --name "eve verify" \
    --command node --args --env-file=<main eve checkout>/.env --args server.js \
    --args --data --args ~/.local/state/eve-verify/data \
    --workdir <checkout under test> --url http://localhost:3100 --env PORT=3100 \
    --capability frontend
  relay service restart --id eve-verify
  ```
  `npm ci` in the checkout first. A re-register restates every flag, including
  `--capability frontend`; a missing flag strips that grant.
- **S2 · P1–P3** are shared with relay's tool (`world-probe`, `chat`, Acme's
  allowed templates).
- **S3 · V1:** an Acme Corp chat template `World voice`, mode Voice, model =
  the verify model, added from eve's Edit Project → Chat Templates.
- **S4 ·** Playwright's Chromium installed (`npx playwright install chromium`).
- **Verifying a PR:** worktree at the PR head + `npm ci`; re-register
  `eve-verify` with that `--workdir` and restart; from that worktree run
  `node devboxverify/main.js --checkout <it> --post N`; re-register back to the
  nightly worktree and restart.

## AC3 procedure (T2; evidence in the PR)

`tree` refuses a dirty checkout, so each break is a commit on a scratch
worktree at `origin/main` (local branch `scratch/verify-break`, never pushed).
Point `eve-verify` at it once. Per journey: commit the one-line break, restart
`eve-verify`, run the tool with `--checkout <scratch>`, see that journey FAIL,
`git reset --hard origin/main` and confirm it is clean. Then a full green run on
`origin/main`, point `eve-verify` back, remove the scratch worktree. Paste the
red `JOURNEY` lines and the green run, scrubbed, into the PR. If a planned break
doesn't bite, pick another in the same file and say so.

| Journey | File | Planned break |
|---|---|---|
| landing-view | `public/home-screen.js` | greeting text empty |
| world-projects-listed | `public/core/state-store.js` | `getVisibleProjects` drops `Globex` |
| chat-reply | `public/message-renderer.js` | assistant render returns early |
| open-existing-thread | `public/message-dispatcher.js` | `session_joined` renders no history |
| terminal-on-request | `public/app.js` | activating a project sends `terminal_create` |
| task-created-listed | `public/sidebar/project-panel.js` | Tasks tab renders no rows |
| voice-deep-link | `public/app.js` | `_handleHashRoute` ignores `#/voice-chat` |

## Feature map facts (README, AC5, T3)

- **landing-view.** `public/index.html` (`#authScreen`, `#welcomeScreen`),
  `public/home-screen.js`. Traps: only loopback skips the passkey screen; the
  greeting depends on the hour.
- **world-projects-listed.** `public/sidebar/activity-rail.js`,
  `home-screen.js#_renderProjects`, data from `GET /api/projects`. Traps: rail
  names live in tooltips; a chip's accessible name includes its monogram; a
  `/<project-slug>/` URL narrows the view.
- **chat-reply.** `project-panel.js` New Session →
  `dialogs/shell-launcher-dialog.js` → WS `create_session` →
  `features/chat-form.js`, `message-renderer.js`. Traps: the launcher's default
  model is a Claude model Acme can't run; allowed templates gate the session
  kind; the "Chat" card (`shell-card-chat`) is a terminal template.
- **open-existing-thread.** Sessions tab → `app.joinSession` →
  `message-dispatcher.js#handleSessionJoined`. Traps: thread labels come from
  recents or relay's preview; `eve-open-sessions` reopens threads in a reused
  profile.
- **terminal-on-request.** `GET /api/terminal/templates?project=` → WS
  `terminal_create` → `terminal-manager.js`. Traps: templates are per project;
  terminal tabs restore.
- **task-created-listed.** Tasks tab → `dialogs/task-dialog.js` →
  `POST /api/tasks` → `task-manager.js`. Traps: "On demand" never fires; delete
  uses a native `confirm()`; models filtered by `allowed_models`.
- **voice-deep-link.** `#/voice-chat` → `app.js#_handleHashRoute` → favourite
  template (per-browser localStorage) → `launchTemplate` →
  `voice-chat-manager.js`. Traps: no favourite → a toast and the launcher; the
  star only shows on chat templates; an existing voice session is re-joined.

## File ownership

| Path | Owner | Budget |
|---|---|---|
| `devboxverify/main.js` | T1 | ~230 lines |
| `devboxverify/eve-api.js` | T1 | ~130 |
| `package.json`: `"verify:devbox": "node devboxverify/main.js"` | T1 | 1 line |
| `devboxverify/journeys.js` | T2 | ~320 |
| `devboxverify/post.js` | T3 | ~80 |
| `devboxverify/README.md` | T3; T4 appends one `## Nightly` section | ~170 + ~50 |
| `devboxverify/nightly.js` | T4 | ~190 |
| `devboxverify/nightly.plist.template` | T4 | ~40 |
| `test/unit/devboxverify.test.js` | test writer | ~300 |
| `docs/design-devboxverify.md` | coordinator | this file |

No product code, no `package-lock.json`, no new e2e/integration spec. No file
under `devboxverify/` is named `*.test.js`/`*.spec.js`. Touching a file outside
a task's rows, or passing ~1.5× its budget, is stop-and-ask.

## Acceptance mapping

| AC | Task | Where |
|---|---|---|
| 1 | T1 + T2 | `run()`, preflight, grammar, exit codes |
| 2 | T2 | Journeys table |
| 3 | T2 | AC3 procedure; evidence in the PR (D11 for known bugs) |
| 4 | T3 + T1 wiring | `post.js`, the `pr` check, `POSTED` |
| 5 | T3 | README feature map |
| 6 | T4 | `nightly.js`, plist, README `## Nightly` |
| 7 | process | red on `main` → proven-bug issue quoting the `JOURNEY` line; `knownBug` |

## Test surface

Unit (`test/unit/devboxverify.test.js`), hermetic (no network, `gh`, `lsof`,
children; `home` passed explicitly):

- `main.js`: `formatLine`/`scrub` (example above); `parseArgs` defaults and
  usage errors (`--post` missing/0, non-loopback or https `--url`, positional);
  `parseWorldSummary` (last wins; none, malformed, indented throw); `tally`;
  `parseListenPids`, `parseCwd`, `parseLstart` (padded day; garbage → null);
  `eveProcessProblem` one clause at a time (same-second start OK, one second
  earlier a problem); `liveEveProblem`; `serviceRowProblem` (running + url OK;
  failed, restarting, `-`, other url, missing row are problems; `eve` and
  `eve-verify` rows never satisfy each other).
- `eve-api.js` `classify`/`added`: world items flagged; a non-world session,
  task and terminal (including sibling `…/Acme Corp2`) are not.
- `post.js`: `statusState` combinations; `renderComment` scrubs home, lists
  every journey, escapes `|`; `commentUrlFrom`.
- `nightly.js`: `classify`; `summaryOf`; `formatRecord`/`parseRecords`
  round-trip; `renderStatusPage` marks RED, escapes `<script>`, latest per repo
  on top.

Devbox pass (coordinator): a full green run; refusals (`--checkout` elsewhere →
`eve FAIL`; `touch` a tracked file → stale `eve FAIL`; `--url …:3000` →
`live FAIL`); the AC3 procedure; `--post` on the PR; nightly installed and
kickstarted, record + `status.html` + notification on a BLOCKED night.

## Open questions

- **Q1 · A second eve overwrites relay's passkey mirror.** `server.js` starts
  passkey sync unconditionally; relay's `EvePasskeyOps.Report` replaces the one
  global list and drops pending revocations whose id isn't reported. An
  `eve-verify` with a fresh `--data` reports `[]` every 30 s, so a revocation the
  owner requested for the live eve could be dropped. Read from the code, not yet
  proven. Recommended: a separate eve issue adding an env switch that turns
  passkey sync off, set only on `eve-verify`. Blocks S1, and blocks pointing
  the live eve service at another data dir.

  Draft for that issue (filed by the coordinator once the owner answers,
  `needs-review`):

  > **A verify-only eve instance must not report passkeys to relay**
  >
  > As the owner I would like a second, verify-only eve to leave relay's
  > passkey list alone, so running devbox verification can never drop a
  > revocation I asked for on my real eve.
  >
  > Acceptance criteria:
  > 1. With `EVE_PASSKEY_SYNC=off` in its environment, eve neither reports
  >    its credential list to relay nor pulls revocations; it logs once at
  >    startup that sync is off.
  > 2. Unset or any other value: behaviour is unchanged.
  > 3. The login-time revocation check keeps its current fail-open
  >    behaviour; with sync off there are no pending revocations to apply.
  > 4. A unit test covers both settings.
  >
  > Tasks: `- [ ] **T1 · env switch in passkey-sync.js wiring in server.js,
  > with test**`

## Risks

- Model latency can make `chat-reply` red for reasons outside eve.
- Nothing locks relay's and eve's tools against each other; each resets the
  world. One verification at a time, not at 03:30.
- Conversation mode may not start in headless Chromium; T2 checks this first.
- `osascript display notification` may need permission; `status.html` is the
  durable report.

## Amendments

- **A1 · Relay readiness on the WS.** eve answers `auth_success` before its own
  upstream to relay is open and drops frames sent before then. The eve-api WS
  client re-sends `terminal_list` every 500 ms after auth and treats the first
  reply as ready (10 s limit); each snapshot and sweep opens its own socket.
- **A2 · Runner states.** A snapshot that throws makes the journey BLOCKED
  (`could not snapshot: <msg>`); a failed after-snapshot only downgrades PASS
  to BLOCKED. A journey returning no valid result is FAIL.
- **A3 · CLI.** `--flag=value` is accepted too; `--world` is resolved to an
  absolute path.
- **A4 · Hidden sessions.** `GET /api/sessions` filters `__search:` sessions,
  so the sweep and leak check cannot see one. No journey creates one.
