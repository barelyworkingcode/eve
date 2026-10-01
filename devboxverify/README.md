# devboxverify

Layer 2 verification: drive a **running**, Relay-managed eve in a real
Chromium, against the devboxWorld test world, and report one result per
journey. No mocks. It runs on the devbox, never in CI. Design and contract:
[../docs/design-devboxverify.md](../docs/design-devboxverify.md).

```bash
node devboxverify/main.js [--checkout DIR] [--url URL] [--service ID] [--post PR] [--screen]
npm run -s verify:devbox -- [flags]
```

Keep `-s` on the npm form. npm's banner would break the stdout grammar.

| Flag | Default |
|---|---|
| `--checkout` | the git toplevel holding `devboxverify/` |
| `--url` | `http://localhost:3100`; must be `http:`, `localhost` or `127.0.0.1`, with a port |
| `--service` | `eve-verify` |
| `--post` | none; a PR number |
| `--screen` | off; runs the journeys that drive the real screen (no value) |

Environment: `RELAY_BIN` (default `/Applications/Relay.app/Contents/MacOS/relay`;
used for `relay service list`, `relay service restart --id eve-verify` and
`relay audit`), `EVE_VERIFY_MODEL` (default `Chat`; the first model whose
value equals it or ends in `/<it>`), `DEVBOXPRESENCE_BIN` (default
`~/.local/share/devboxverify/bin/devboxpresence`; only `--screen` uses it,
for relay's presence helper), `DEVBOXWORLD_MARKER` (default
`~/.config/devboxWorld/machine.json`; the machine marker, see below).
There is no `--world` flag, and the tool never reads, sets or clears
`DEVBOXWORLD_ROOT`; the world scripts inherit the environment unchanged.
A stray `DEVBOXWORLD_ROOT` fails `bootstrap` with `BLOCKED environment:
bootstrap incomplete; repair.sh exited 2 without a result; run bootstrap.sh`,
and the reason is on stderr.
The tool never builds eve, registers a service or edits settings. Its only
writes are the owner reset below and the `verify-<nonce>-*` folders journeys
make in Acme Corp and remove. It never targets the live eve on :3000, and
preflight refuses it. It does share one thing with the live eve: relay has
a single eve enrolment window. An add-browser-in-window run that fails
between opening the window and consuming it leaves it open for up to
5 minutes, and the live eve would accept a new browser in that time.

## Output

Stdout is tab-separated lines and nothing else. Progress, the world scripts'
output and sweep counts go to stderr. The home directory reads as `~`.

```
PREFLIGHT <check> OK|FAIL <detail>
REPAIRED <what> <detail>
WORLD pass=<n> fail=<n>
RESET OK|FAIL
JOURNEY <id> PASS|FAIL|BLOCKED|NOTRUN <detail>
TIMING journey <id> <ms>
TIMING run <ms>
SUMMARY pass=<n> fail=<n> blocked=<n> notrun=<n>
POSTED success|failure|error <comment URL>
```

Preflight runs in order and stops at the first FAIL: `machine`, `pin`,
`fixtures`, `lock`, `head`, `tree`, `service`, `eve`, `live`, `pr` (only with
`--post`), `browser`, `audio`, `bootstrap`, `world`, `owner`. Then the run
signs in and carries on:

1. The fixture journeys `passkey-first-enrol` and `passkey-sign-in` run the
   real passkey ceremonies with a virtual authenticator.
2. With a signed-in owner, `PREFLIGHT api` runs with its token, then `WORLD`,
   then `reset.sh` and a sweep of every session, terminal and task in the
   three world projects (`RESET`).
3. The other journeys run, screen journeys last. The sweep runs again after
   them, best effort.

If either fixture journey is not PASS, every later journey is
`BLOCKED no signed-in owner`, `api` and `RESET` never run, and the summary
still prints.

A `TIMING journey` line follows every `JOURNEY` line, one for one: whole
milliseconds, truncated, from just before the journey starts until its
result, cleanups and leak check included. A record made without running the
journey (`no signed-in owner`, a NOTRUN skip) has `0`. `TIMING run` comes
right before `SUMMARY`, only when `SUMMARY` prints, and counts from the start
of the run, preflight included. With `--post` the comment gets the same
figure as a `Run time` row, in seconds, and a `Repaired` row right after
`World verify`: `none`, or `<what>: <detail>` per repair, joined with `; `.

### The machine, the pin and the fixtures

The world comes only from devboxWorld's machine marker, which `bootstrap.sh`
writes on a VM. It names the world checkout, the world root and the world's
major version; devboxWorld's `docs/WORLD.md` is the spec. The first three
checks run before the lock and before any script or network call, so a
machine that is not a bootstrapped VM is never touched:

- `machine` reads the marker and checks the machine is a VM (live, with no
  override). FAIL: `not a test machine: …`. OK: `vm; world v<N>`.
- `pin` compares the marker's `world_version` with this tool's
  `WORLD_VERSION` (`devboxverify/world.js`). FAIL: `BLOCKED fixture: this
  machine's world is v<M>; eve needs v<N>`. OK: `v<N>`.
- `fixtures` loads `<world checkout>/data/world.json` and checks that every
  fixture the journeys of this run declare is in its catalogue. FAIL:
  `BLOCKED fixture: <reason>` for bad world data, or `BLOCKED fixture:
  <journey> needs <id>[, <id>…][; <journey> needs …]`. OK:
  `<n> fixtures for <m> journeys`.

Every journey declares its fixtures in `needs` (`project:<key>`,
`file:<key>/<rel>`), and sees only those through `env.world`: `projects.<key>`
and `file(key, rel)`. Names and folders come from the world, never from a
literal. Looking up anything undeclared reports the journey
`BLOCKED undeclared fixture <id>`.

What each BLOCKED prefix blames:

- `BLOCKED fixture:` the test data. The world on this machine is the wrong
  version, its data is malformed, or a fixture a journey needs isn't
  published.
- `BLOCKED environment:` the world scripts. `repair.sh` (run from the
  marker's world checkout) found bootstrap incomplete, a world it could not
  repair, or a person needed; run `bootstrap.sh`, or `reset.sh`, and look at
  its stderr.

`bootstrap` runs `repair.sh` once, from `world_checkout`, with a 900 s
timeout; its stdout is parsed, then echoed to stderr, and `world` reads the
same result. `repair.sh` verifies the world and, if it is red, resets it once
and verifies again. Each `REPAIRED` line prints before `PREFLIGHT world`.
`world` is OK only with a `CHECK world OK` line, exit 0, no timeout and a
last `SUMMARY` with `fail=0`; `WORLD` counts come from that last `SUMMARY`.
With no bootstrap line, `bootstrap` fails `bootstrap incomplete; repair.sh
<how> without a result; run bootstrap.sh`; with no usable world line,
`world` fails `repair.sh <how> without a result`. `<how>` is `exited <n>` or
`timed out after 900s`. A repaired run resets twice: once in `repair.sh`,
once before the journeys. The wire shape is in devboxWorld's `docs/WORLD.md`.

A journey FAIL after a green preflight is a product bug.

`eve FAIL` also covers eve-verify's sign-in setup: its service row needs an
absolute `--data <dir>`, and `GET /api/auth/status` must not say
`trusted: true` (`loopback is trusted; register eve-verify with
EVE_DISABLE_SUBNET_BYPASS=1`).

`owner` runs last, so a broken world never resets the owner. It resets
eve-verify to a box with no owner, so the run can enrol its own: it deletes
exactly `auth.json` and `sessions.json` in the pinned `--data` dir (eve's
documented break-glass), runs `relay service restart --id eve-verify`, waits up to 30 s for the new process, and needs the status
`enrolled: false` with no `trusted`. It refuses any dir that is not a
normalised absolute path or is the live eve's own `data` dir.

`audio FAIL` means the host audio stack is wedged or unavailable: eve's first
click creates an `AudioContext`, and the renderer would block or fail there.
A timeout usually clears after restarting `coreaudiod`.

`lock` takes the shared browser-test lock (`scripts/browser-lock.js`, the same
one `npm run test:e2e` and `npm run test:visual` take) and holds it for the
whole run. While another run holds it, the lock waits up to
`EVE_BROWSER_LOCK_TIMEOUT` seconds (default 1800; the nightly plist sets 600),
logging the holder's pid and command to stderr. `lock FAIL` means it gave up
waiting, or could not take the lock at all (for example `perl` is not on
PATH); the detail names the holder or the reason.

Exit 0 when every journey is PASS or NOTRUN, 1 on any FAIL or BLOCKED, 2 on a
usage, preflight, reset or post failure.

A journey marked with a known bug reports `NOTRUN` with
`omitted: known bug <ref>` and does not run.

A journey marked `screen: true` drives the real screen: a desktop Terminal
and relay's presence dialog. Without `--screen` it reports
`NOTRUN screen journey; run with --screen`. Pass `--screen` by hand only with
a SCREEN grant; the nightly passes it.

All journeys share a 480 s budget. A journey's timeout is cut to what is left,
and one that would get less than 1 s reports `BLOCKED run budget spent`.

The session token from the sign-in is used for every browser context and
every eve API call of the run. It lives in memory only: never logged,
written to disk or put in a detail.

## Feature map

**landing-view.** Opening eve shows the home screen: a greeting and the
Start tiles "Chat" and "Voice", no passkey screen.
- Lives in: `public/index.html` (`#authScreen`, `#welcomeScreen`),
  `public/home-screen.js`.
- Traps: eve-verify does not trust loopback, so the journey runs signed in
  and still checks the passkey screen is gone. The greeting depends on the
  hour.

**world-projects-listed.** In Work, Home and the rail show Acme Corp and
Globex and not Home; switching to Home shows Home and not Acme Corp or
Globex. The journey switches back to Work (persisted in `eve-mode`).
- Lives in: `public/sidebar/activity-rail.js`,
  `public/home-screen.js` (`_renderProjects`); data from `GET /api/projects`.
- Traps: rail names live in tooltips. A chip's accessible name includes its
  monogram. A `/<project-slug>/` URL narrows the view.

**chat-reply.** A web chat in Acme Corp gets a non-empty assistant reply.
Whether it answered correctly goes in the detail, not the verdict.
- Lives in: `public/sidebar/project-panel.js` New Session →
  `public/dialogs/shell-launcher-dialog.js` → WS `create_session` →
  `public/features/chat-form.js`, `public/message-renderer.js`.
- Traps: the launcher's default model is a Claude model Acme can't run.
  Allowed templates gate the session kind. The "Chat" card
  (`shell-card-chat`) is a terminal template, not web chat.

**open-existing-thread.** In a fresh browser, the thread from chat-reply
opens from the Sessions tab with its question and reply.
- Lives in: Sessions tab → `app.joinSession` →
  `public/message-dispatcher.js` (`handleSessionJoined`).
- Traps: thread labels come from recents or relay's preview.
  `eve-open-sessions` reopens threads in a reused profile. BLOCKED when
  chat-reply left no thread.

**terminal-on-request.** No terminal opens until asked; "World probe" then
opens one that runs a command. After a reload no terminal opens by itself
(checked over a settle period); the live terminal is listed in the Sessions
panel and opens on click, with its output and a second command answering.
- Lives in: `GET /api/terminal/templates?project=` → WS `terminal_create` →
  `public/terminal-manager.js`.
- Traps: templates are per project. The reloaded page lists the terminal in the Sessions panel (`sidebar-terminal-<id>`); it is never reopened for you.

**task-created-listed.** An on-demand chat task is created and still listed
after a reload.
- Lives in: Tasks tab → `public/dialogs/task-dialog.js` →
  `POST /api/tasks` → `public/task-manager.js`.
- Traps: "On demand" never fires. Delete uses a native `confirm()`. Models
  are filtered by `allowed_models`.

**voice-deep-link.** With "World voice" starred, `#/voice-chat` opens a voice
chat straight away.
- Lives in: `#/voice-chat` → `public/app.js` (`_handleHashRoute`) → favourite
  template (per-browser localStorage) → `launchTemplate` →
  `public/voice-chat-manager.js`.
- Traps: no favourite gives a toast and the launcher. The star only shows on
  chat templates. An existing voice session is re-joined, not created.

**today-ipad-portrait.** At 834×1194 with touch: Today in a centred column of
at most 720px across the full-width main area, the sidebar off screen until
the menu opens it and the scrim closes it, the wordmark `Home|Work` in Today,
no horizontal overflow, and every visible control at least 44×44.
- Lives in: `public/core/layout.js`, `public/apple/touch.css`, the
  `max-width: 1023.98px` blocks, `public/sidebar/mode-switch.js`.
- Traps: the device is `env.newPage({ device: DEVICES.ipadPortrait })`, with
  `hasTouch` and never `isMobile`. The sweep and overflow probes live in
  `journey-kit.js`, apart from the e2e helpers.

**today-phone.** At 390×844 with touch: a bottom bar (Today, Threads,
Projects) and no tab bar; Projects → Acme Corp → Start Chat (no message is
sent) opens the thread with Back and `#session/<id>`; Back and browser Back
both return to Today (the hash is checked after in-app Back). Overflow and the 44px sweep on Today and the
thread.
- Lives in: `public/core/layout.js` (navigation stack), `public/app.js`
  (bottom bar, Back), `public/tab-manager.js` (`_updateHash`, `showToday`).
- Traps: creates one Acme session. BLOCKED when the model is not offered or
  the launch is refused.

## One-time setup

- **S1 · Register `eve-verify`.** Presence-gated, so run it in a desktop
  Terminal. It stays registered, on a dedicated clean worktree of `main` that
  only the nightly updates; no one else writes to it. Run `npm ci` there first.
  It must only ever point at a checkout that honours `EVE_PASSKEY_SYNC`: a
  second eve with passkey sync on overwrites relay's passkey list.

  ```bash
  relay service register --id eve-verify --name "eve verify" \
    --command node --args server.js \
    --args --data --args ~/.local/state/eve-verify/data \
    --workdir <verify worktree> --url http://localhost:3100 \
    --env PORT=3100 --env EVE_PASSKEY_SYNC=off --env EVE_DISABLE_SUBNET_BYPASS=1 \
    --capability frontend
  relay service restart --id eve-verify
  ```

  `EVE_DISABLE_SUBNET_BYPASS=1` makes loopback sign in like any other
  browser, so the passkey journeys see the real screens. Both env vars only
  tighten. Never add `EVE_NO_AUTH`, `EVE_TRUSTED_SUBNETS` or
  `EVE_ALLOW_ENROLLMENT`. The `--data` dir is the one `PREFLIGHT owner`
  resets each run; never point it at a dir holding an owner you want to keep.

  A re-register restates every flag, `--capability frontend` included. A
  missing flag strips that grant. Relay supervises the service: killing it
  restarts it, and there is no stop command; `relay service unregister --id
  eve-verify` removes it. The data dir stays outside any repo.
- **S2 · P1–P3** are shared with relay's tool: the `world-probe` and `chat`
  templates, and Acme Corp's allowed templates `chat` and `world-probe`.
- **S3 · V1.** An Acme Corp chat template `World voice`, mode Voice, model =
  `EVE_VERIFY_MODEL`, added from eve's Edit Project → Chat Templates.
- **S4 ·** Playwright's Chromium: `npx playwright install chromium`.
- **S5 · Screen journeys.** `computer` on the `PATH` the run sees (the
  nightly plist's too), and relay's presence helper built at
  `DEVBOXPRESENCE_BIN` (default
  `~/.local/share/devboxverify/bin/devboxpresence`; relay documents the
  build). Without it, a presence journey gets `no-helper` and reports
  BLOCKED. Eve never reads the account password: the helper does, and checks
  the dialog is relay's before it types. Journeys start
  `devboxpresence answer --expect <text>` before the command that raises the
  dialog, and only after the helper prints `devboxpresence: ready` on stderr,
  since it refuses a dialog already open when it took its snapshot;
  `closeConsole` runs `devboxpresence cancel --any` to clear a stray one,
  and, only when the frontmost Terminal window carries the
  `devboxverify-console` title `consoleRun` gave it, exits its shell and
  closes the window if the profile left it open.
  Exit codes: 0 answered, 1 no dialog in time, 3 refused (locked screen, not
  relay's dialog, text lacks the expected words, several dialogs, or one
  older than the helper); 2, 4 and 5 are errors.

## Verifying a PR

1. Check out the PR head in its own worktree and run `npm ci` there.
2. Re-register `eve-verify` with `--workdir <PR worktree>` (every flag, as in
   S1) and restart it.
3. From that worktree, run
   `node devboxverify/main.js --checkout <PR worktree> --post <N>`, adding
   `--screen` when you hold a SCREEN grant.
4. Preflight refuses unless the machine marker is valid, the world version
   matches and every declared fixture is published; then unless the PR head
   is HEAD, the tree is clean, and `eve-verify` runs from that worktree and
   started after its newest tracked file changed. Then `repair.sh` must find
   bootstrap complete and the world green, or repair it once. Only then does
   `reset.sh` run.
5. `--post` comments the results on the PR, then sets the `devbox/verify`
   status on the head commit, linking the comment.
6. Re-register `eve-verify` back to the nightly worktree and restart it.

## Traps

- Edit a tracked file and the running eve is stale: preflight fails `eve`
  until `relay service restart --id eve-verify`.
- A dirty tree fails `tree`. Untracked files are ignored.
- `--url` at :3000 with the default `--service` fails `service`: the
  `eve-verify` row is not registered at that URL. Run from the live checkout
  with `--service eve --url http://localhost:3000` and it fails `live`
  instead. An `eve-verify` sharing the live eve's process or checkout also
  fails `live`.
- Journeys create things only in Acme Corp. A journey that leaves anything
  outside the world projects is FAIL, and the item stays for a human to
  remove.
- A journey's `cleanup(label, fn)` runs after its browser contexts close,
  whatever the verdict, with 10 s each. A cleanup that throws turns PASS into
  FAIL. One registered after its journey timed out runs at the end of the run.
  A leftover `verify-<nonce>-*` folder fails the next `world` preflight.
- Every run makes the sign-in ceremonies plus the negative journeys' calls:
  9 of eve's 10 limited auth calls per IP per 15 minutes. The limiter is in
  memory and the owner reset restarts eve-verify, so each run starts at zero.
  Never raise it.
- The owner reset leaves eve-verify with this run's owner. A browser you
  signed in to eve-verify by hand is signed out by the next run.
- Model latency can turn chat-reply red for reasons outside eve.
- relay's tool and this one both reset the world. Run one at a time.
- Never post raw output from the world scripts. The tool scrubs the home
  directory from what it posts.

## Nightly

A launchd job runs the verifiers every night at 03:30, one after the other:
relay's api journeys (`--phase api`, record `relay`), eve with `--screen`
(record `eve`), then relay's screen journeys (`--phase screen`, record
`relay-screen`). It never retries a verify.

- **Relay** is verified as installed. The nightly never builds relay, because
  its build signs and its register needs you at the console. After a merge to
  relay's `main`, the night is BLOCKED by preflight until you rebuild and
  re-register. That is expected, not a defect. The record shows `behind=<n>`.
- **Eve** runs from the dedicated verify worktree registered as `eve-verify`
  (see S1). The nightly resets it to `origin/main` (`git reset --hard`),
  discarding any drift, and runs `npm ci` only when `package-lock.json`
  changed. It then runs `relay service restart --id eve-verify` and waits up
  to 60 s for port 3100 before verifying.

The nightly runner, its launchd job and how to install them live in
devboxWorld: see its `docs/vm-stack.md`.

### Where to look

All of these are in `~/Library/Logs/devboxverify/`:

- `status.html`: the latest night per repo at the top, then the last 60
  records, newest first. RED and BLOCKED are highlighted. Plain HTML, no
  scripts.
- `nightly.log`: one tab-separated line per record per night:
  `NIGHT <at> <repo> <GREEN|RED|BLOCKED> <commit> behind=<n> <summary>`
  (UTC timestamp).
- `runs/<YYYY-MM-DD>-<record>.txt`: that night's full output, every command with
  its exit status, stdout and stderr.
- `launchd.log`: the job's own output. Look here if the nightly runner itself
  crashed.

### Reading a night

- **GREEN**: the verifier exited 0. Every journey passed or was NOTRUN.
- **RED**: the verifier exited 1. A journey failed or was blocked. The summary
  is its `SUMMARY` line; the run file has the `JOURNEY` lines. A red journey on
  `main` gets a bug issue that quotes the `JOURNEY` line.
- **BLOCKED**: the night proved nothing. The summary gives the reason: a
  nightly step (`git fetch origin failed`, `worktree is not clean`,
  `npm ci failed`, `port 3100 not listening after 60s`, …), the verifier's
  first `PREFLIGHT … FAIL` line, or `timed out after 30 min`. Fix the cause;
  the next night, or a `kickstart`, runs again.

Any night that isn't GREEN also posts one macOS notification. The first one
may ask for notification permission. `status.html` is the durable record
either way.

### One verification at a time

Relay's and eve's verifiers both reset the shared devboxWorld, and nothing
locks them against each other. Don't run a manual verify, or verify a PR,
around 03:30. launchd never overlaps two runs of the job.
