# devboxverify

Layer 2 verification: drive a **running**, Relay-managed eve in a real
Chromium, against the devboxWorld test world, and report one result per
journey. No mocks. It runs on the devbox, never in CI. Design and contract:
[../docs/design-devboxverify.md](../docs/design-devboxverify.md).

```bash
node devboxverify/main.js [--checkout DIR] [--world DIR] [--url URL] [--service ID] [--post PR]
npm run -s verify:devbox -- [flags]
```

Keep `-s` on the npm form. npm's banner would break the stdout grammar.

| Flag | Default |
|---|---|
| `--checkout` | the git toplevel holding `devboxverify/` |
| `--world` | `<tool checkout>/../devboxWorld` |
| `--url` | `http://localhost:3100`; must be `http:`, `localhost` or `127.0.0.1`, with a port |
| `--service` | `eve-verify` |
| `--post` | none; a PR number |

Environment: `RELAY_BIN` (default `/Applications/Relay.app/Contents/MacOS/relay`,
used only for `relay service list`), `EVE_VERIFY_MODEL` (default `Chat`; the
first model whose value equals it or ends in `/<it>`). The tool writes no
files and never builds, registers or edits settings. It never touches the live
eve on :3000.

## Output

Stdout is tab-separated lines and nothing else. Progress, the world scripts'
output and sweep counts go to stderr. The home directory reads as `~`.

```
PREFLIGHT <check> OK|FAIL <detail>
WORLD pass=<n> fail=<n>
RESET OK|FAIL
JOURNEY <id> PASS|FAIL|BLOCKED|NOTRUN <detail>
SUMMARY pass=<n> fail=<n> blocked=<n> notrun=<n>
POSTED success|failure|error <comment URL>
```

Preflight runs in order and stops at the first FAIL: `lock`, `head`, `tree`,
`service`, `eve`, `live`, `pr` (only with `--post`), `api`, `browser`,
`audio`, `bootstrap`, `world`. Then `reset.sh` and a sweep of every session,
terminal and task in the three world projects. The sweep runs again after the
journeys, best effort.

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

## Feature map

**landing-view.** Opening eve shows the home screen: a greeting and the
Start tiles "Chat" and "Voice", no passkey screen.
- Lives in: `public/index.html` (`#authScreen`, `#welcomeScreen`),
  `public/home-screen.js`.
- Traps: only loopback skips the passkey screen. The greeting depends on the
  hour.

**world-projects-listed.** Home shows a chip for Acme Corp, Globex and Home,
and the rail has an entry for each.
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
opens one that runs a command.
- Lives in: `GET /api/terminal/templates?project=` → WS `terminal_create` →
  `public/terminal-manager.js`.
- Traps: templates are per project. Terminal tabs restore.

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
    --env PORT=3100 --env EVE_PASSKEY_SYNC=off --capability frontend
  relay service restart --id eve-verify
  ```

  A re-register restates every flag, `--capability frontend` included. A
  missing flag strips that grant. Relay supervises the service: killing it
  restarts it, and there is no stop command; `relay service unregister --id
  eve-verify` removes it. The data dir stays outside any repo.
- **S2 · P1–P3** are shared with relay's tool: the `world-probe` and `chat`
  templates, and Acme Corp's allowed templates `chat` and `world-probe`.
- **S3 · V1.** An Acme Corp chat template `World voice`, mode Voice, model =
  `EVE_VERIFY_MODEL`, added from eve's Edit Project → Chat Templates.
- **S4 ·** Playwright's Chromium: `npx playwright install chromium`.

## Verifying a PR

1. Check out the PR head in its own worktree and run `npm ci` there.
2. Re-register `eve-verify` with `--workdir <PR worktree>` (every flag, as in
   S1) and restart it.
3. From that worktree, run
   `node devboxverify/main.js --checkout <PR worktree> --post <N>`.
4. Preflight refuses unless the PR head is HEAD, the tree is clean, and
   `eve-verify` runs from that worktree and started after its newest tracked
   file changed. Then `bootstrap.sh --check` must pass and `verify.sh` must be
   green. Only then does `reset.sh` run.
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
- Model latency can turn chat-reply red for reasons outside eve.
- relay's tool and this one both reset the world. Run one at a time.
- Never post raw output from the world scripts. The tool scrubs the home
  directory from what it posts.

## Nightly

A launchd job runs both verifiers every night at 03:30: relay first, then eve,
one after the other. It never retries a verify.

- **Relay** is verified as installed. The nightly never builds relay, because
  its build signs and its register needs you at the console. After a merge to
  relay's `main`, the night is BLOCKED by preflight until you rebuild and
  re-register. That is expected, not a defect. The record shows `behind=<n>`.
- **Eve** runs from the dedicated verify worktree registered as `eve-verify`
  (see S1). The nightly resets it to `origin/main` (`git reset --hard`),
  discarding any drift, and runs `npm ci` only when `package-lock.json`
  changed. It then runs `relay service restart --id eve-verify` and waits up
  to 60 s for port 3100 before verifying.

### Install

Run this from a shell whose `PATH` has `node`, `go` and `git`.

    mkdir -p ~/.local/share/devboxverify ~/Library/Logs/devboxverify
    cp devboxverify/nightly.js ~/.local/share/devboxverify/
    sed -e "s|@NODE@|$(command -v node)|" \
        -e "s|@HOME@|$HOME|g" \
        -e "s|@PATH@|$PATH|" \
        -e "s|@RELAY_CHECKOUT@|<relay checkout>|" \
        -e "s|@EVE_CHECKOUT@|<nightly eve worktree>|" \
        devboxverify/nightly.plist.template \
        > ~/Library/LaunchAgents/local.devboxverify.nightly.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.devboxverify.nightly.plist
    launchctl kickstart gui/$(id -u)/local.devboxverify.nightly   # first run, now

Set `EVE_VERIFY_MODEL` in the plist's `EnvironmentVariables` if the verify
model is not `Chat`. Set `RELAY_BIN` there if relay is not at
`/Applications/Relay.app/Contents/MacOS/relay`.

**The installed copy is what runs.** launchd runs
`~/.local/share/devboxverify/nightly.js`, not the repo file. After changing
`devboxverify/nightly.js`, copy it there again. After changing the template,
regenerate the plist, then `bootout` and `bootstrap` again.

### Uninstall

    launchctl bootout gui/$(id -u)/local.devboxverify.nightly
    rm ~/Library/LaunchAgents/local.devboxverify.nightly.plist

### Where to look

All of these are in `~/Library/Logs/devboxverify/`:

- `status.html`: the latest night per repo at the top, then the last 60
  records, newest first. RED and BLOCKED are highlighted. Plain HTML, no
  scripts.
- `nightly.log`: one tab-separated line per repo per night:
  `NIGHT <at> <repo> <GREEN|RED|BLOCKED> <commit> behind=<n> <summary>`
  (UTC timestamp).
- `runs/<YYYY-MM-DD>-<repo>.txt`: that night's full output, every command with
  its exit status, stdout and stderr.
- `launchd.log`: the job's own output. Look here if nightly.js itself crashed.

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
