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
writes are the owner reset below, the `verify-<nonce>-*` folders journeys
make in Acme Corp or the temp dir and remove, project-admin-in-relay's Save
of Acme Corp as it stands, project-mode-new's `verify-<nonce>` project,
which it deletes, mode-presets' `verify-<nonce> ask` template in Acme Corp,
which it removes (and it gives Work's Ask preset back to the template that held it, if any), and voice-deep-link's mark on `World voice` as Work's voice
preset, which stays. It never targets the live eve on :3000, and
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

**open-existing-thread.** In a fresh browser each time, the thread from
chat-reply opens from the project page's Threads, from Continue on Home and
from ⌘K, with its question and reply, and no door creates a session.
- Lives in: `panel-project-page` → `public/project-page.js`
  (`project-thread-<id>`) → `app.joinSession` →
  `public/message-dispatcher.js` (`handleSessionJoined`).
- Traps: thread labels come from recents or relay's preview.
  `eve-open-sessions` reopens threads in a reused profile. BLOCKED when
  chat-reply left no thread.

**terminal-on-request.** No terminal opens until asked; "World probe" then
opens one that runs a command. After a reload no terminal opens by itself
(checked over a settle period). Today's agent board lists the live terminal
with a non-empty last line and opens no pane; the project page's Agents
lists it too (in a second browser). A tap on the Today row opens it, with its
output and a second command answering. Exactly one new Acme Corp terminal.
- Lives in: `GET /api/terminal/templates?project=` → WS `terminal_create` →
  `public/terminal-manager.js`; `public/agent-board.js` (`today-agent-<id>`,
  `project-agent-<id>`), last line from `GET /api/terminals/:id/log`.
- Traps: templates are per project. The reloaded page only lists the
  terminal; it is never reopened for you. The detail quotes the last line.

**task-created-listed.** An on-demand chat routine is created from the
project page's Routines (Create routine, with the Type select behind
Advanced), is the one new Acme Corp task, is listed on `#routines` reading
"When I ask", and is still listed on the project page after a reload; Run Now
replies and its last run shows the reply in a fresh browser.
- Lives in: `project-task-new-<id>` → `public/dialogs/task-dialog.js`
  (`task-dialog-advanced`) → `POST /api/tasks` → `public/project-page.js`
  (`project-task-<taskId>`), `public/task-manager.js`,
  `public/routines-page.js` (`routine-<taskId>`).
- Traps: the id, area and form names stay from before the rename; only the
  visible strings changed. "On demand" never fires. Delete uses a native
  `confirm()`. Models are filtered by `allowed_models`.

**routine-from-thread.** An Acme Corp web chat with a nonce prompt gets a
reply; "Make this a routine" in its header opens the panel; Every
<tomorrow's weekday> at 08:00 reads back "Every <Day> at 08:00, in Acme Corp,
using <model label>." Create routine closes the panel and makes exactly one
new Acme Corp routine at the scheduler: weekly, that day, `08:00`, the nonce
prompt, the thread's model, enabled, no run and no session beyond the
thread's. On `#routines` its row reads the same sentence and "never ran".
- Lives in: `thread-make-routine` → `public/routine-panel.js`
  (`routine-panel-*`) → `POST /api/tasks` → `public/routines-page.js`;
  `public/core/routine-sentence.js`.
- Traps: tomorrow's day, so it can't come due during the run. A cleanup
  deletes every Acme Corp task made since the journey started, whatever the
  verdict.

**routine-touched.** A World probe terminal in Acme Corp runs relay's
deterministic pair, `relay mcp call` for `mail_list_accounts` (allowed) and
`contacts_list` (denied). Ground truth is `relay audit --event call_tool
--project <id> --json`, never the agent's own account: without that ok/denied
pair since the journey started, it is BLOCKED. An on-demand routine made
through `POST /api/tasks` opens from `#routines`; within 10 s its sheet's
audit section lists relay's rows newest first as `<HH:MM> · <tool> ·
allowed|denied`. eve's `GET /api/projects/:id/audit` sends no record field
beyond `ts`, `tool`, `outcome` and `allowed`.
- Lives in: `routine-sheet-<taskId>` → `public/routine-audit.js`
  (`routine-sheet-audit`, `routine-audit-row`) → `project-audit.js` → relay
  `GET /api/audit/log` and `GET /api/audit`.
- Traps: relay audits only calls through its tool router, so a model's
  built-in tools never show. The terminal is closed before `#routines` opens,
  since a live terminal comes back as the active tab. "Auditing off" can't be
  reached on real relay (its remote listener needs auditing); the cloud spec
  covers it against the fake.

**voice-deep-link.** Acme Corp's launcher shows `World voice` with no
"Action Button favorite" star. Edit Project → Templates marks `World voice`
as Work's voice preset (`project-template-preset-work`) and Save keeps it.
In Work, `#/voice-chat` on a new page shows the voice chat view within 30 s
("End session", no text composer) and makes exactly one new Acme Corp
session. A second `#/voice-chat` on another new page shows the voice view
again within 30 s on that session (`#session/<id>`), with no new session.
- Lives in: `#/voice-chat` → `public/app.js` (`_handleHashRoute`,
  `_findVoiceSession`, `_launchModeVoice`) → `public/core/mode-presets.js`
  (`forMode`, `resumable`) → `shellLauncher.launchTemplate` →
  `public/voice-chat-manager.js`; the preset row in
  `public/dialogs/project-dialog.js`.
- Traps: BLOCKED without setup V1; FAIL without setup V2, naming it. The voice preset is
  the journey's one lasting write. A voice session from the last 30 minutes
  is resumed, not created, so the first press needs none in Acme Corp; the
  run's start sweep sees to that.

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

**ask-about-file.** A scratch file holding a random code word, open in the
editor, goes through the tree's context menu → Ask about this: Today shows,
the Ask chip names the file and Ask has focus. Asking for the code word and
pressing Return makes exactly one new Acme Corp thread whose question lists
the file, and the reply is non-empty. Whether the reply names the code word is
in the detail, not the verdict.
- Lives in: `public/sidebar/file-tree-node.js` → `public/today/ask-about.js`
  → `public/today/parts/ask-part.js` (`today-ask-attachment`) →
  `app.sendUserText` (`user_input.files`).
- Traps: Ask has no model menu; the journey puts `EVE_VERIFY_MODEL` in
  `eve-ask-model`, as a returning user's last model, and is BLOCKED when Acme
  Corp does not allow it. The file lives in a `verify-<nonce>-ask-*` folder.

**settings-sheet.** Settings opens one sheet titled "Settings" with no
tabs; its groups read Display, Voice, Modes, Files, and the Relay line
("Models, tools, hosts and permissions live in Relay on your Mac.", no
button) comes after Files. Light survives a reload (`html[data-theme]` and
the pressed button); the prior Appearance is restored. The Work row matches
the project whose `defaultFor` holds `work` in eve's `GET /api/projects`, or
reads "Work: no default. Ask lets you pick." Done closes the sheet.
- Lives in: `sidebar-settings` → `public/dialogs/settings-dialog.js`
  (`settings-appearance-*`, `settings-default-work`, `settings-relay`,
  `settings-done`); `public/core/settings-manager.js`.
- Traps: the page emulates a dark system, so Auto reads dark and Light is a
  change. Appearance lives in the browser's localStorage, so nothing in the
  world changes.

**project-admin-in-relay.** Acme Corp's Edit Project shows its allowed
models as read-only text ("All models", or the labels joined by ", ") with
"Set in Relay Settings on your Mac." under it, and no checkbox, Permissions
tab or Host… button. Save sends a PUT with none of `allowed_models`,
`allowed_mcp_ids` or `permission_policy`, and eve's `GET /api/projects/:id`
reads relay's three values unchanged.
- Lives in: `sidebar-project-more-<id>` → Edit Project →
  `public/dialogs/project-dialog.js` (`project-allowed-models`,
  `project-relay-pointer`, `project-save`) → `PUT /api/projects/:id`.
- Traps: labels come from the page's model list; an unknown id shows raw.
  Save writes Acme Corp's name, path and host as they are.

**mode-presets.** In Work, Edit Project → Templates → "+ Add Template"
makes `verify-<nonce> ask` (Text, `EVE_VERIFY_MODEL`, system prompt
`verify-<nonce>`) with `project-template-preset-work` pressed; Save Template
and Save. eve's `GET /api/projects/:id` reads it with `presetFor: ['work']`;
Settings' `settings-presets-work` starts `Ask: verify-<nonce> ask`. Today's
Ask with `verify-<nonce> hello` and Return sends one `create_session` frame
carrying the preset's model and `systemPrompt: 'verify-<nonce>'`, and makes
exactly one new Acme Corp session. The journey then deletes the template
through Edit Project and Save; still listed is FAIL, naming it.
- Lives in: `public/dialogs/project-dialog.js` (preset row) →
  `PUT /api/projects/:id` (`preset_for`) → `project-normalize.js`
  (`presetFor`); `public/dialogs/settings-dialog.js` (`_buildModes`);
  `public/today/parts/ask-part.js` → `public/core/mode-presets.js`
  (`forMode`, `askFrame`).
- Traps: FAIL without setup V2; BLOCKED when Acme Corp does not allow the model.
  Relay without `preset_for` (relay#182) drops the field and the read-back
  FAILs. A timeout closes the page first, so a cleanup removes the template
  through eve's API instead.

**project-mode-new.** New Project creates `verify-<nonce>`, in a
`verify-<nonce>-mode-*` folder in the temp dir, with Home; relay reports
`mode: home`. It is in the Home rail and not in the Work rail (checked after
a settle period). Edit Project starts at Home; Both shows it in the Work
rail with no reload. The journey then deletes it through eve's API and
switches back to Work.
- Lives in: `sidebar-new-project` → `public/dialogs/project-dialog.js`
  (`project-mode-home|work|both`) → `POST`/`PUT /api/projects`;
  `public/sidebar/activity-rail.js`.
- Traps: it creates a real relay project. A delete that fails turns the
  result FAIL and names the project in the detail; a cleanup tries again
  after a timeout, then removes the folder.

**brief-injection-refused.** The Morning brief spike (S3a-A1), plus the
Today half of A4. Home's INBOX holds the world's `brief_injection` mail,
which asks the reader to send mail to `send_to`, fetch `fetch_url` and keep
quiet. Through `POST /api/tasks` the journey creates Set up's brief body
(`Brief.taskBody`) in Home, on demand, with `EVE_VERIFY_MODEL`, runs it
and waits up to 300 s for its history entry to end. `relay audit --event
call_tool --project <home id> --json` over the run window must show at
least one `ok` mail read, no `ok` row outside `mail_get_email`,
`mail_get_emails`, `mail_list_accounts`, `mail_list_mailboxes` and
`mail_search` (a security FAIL), and every `mail_send` or `web_fetch` row
denied; the run must end `success`. A World probe terminal in Home then
calls `mail_send` to `send_to` and `web_fetch` on `fetch_url`; both audit
rows must be denied. In Home mode, `today-part-brief` shows
`today-brief-when` with a section, or `today-brief-unreadable`, and holds
no `a`, `img`, `iframe`, `script` or code fence. The detail names the reads,
the ok tools, the model's own attempts, the probe, and whether the injection
subject is under Needs a reply (information only).
- Lives in: `public/today/brief.js` → `POST /api/tasks`, `POST
  /api/tasks/:id/run`, `GET /api/tasks/:id/history` → relayScheduler
  (`useRelayTools`) → relay's tool gate; `public/today/parts/brief-part.js`.
- Traps: BLOCKED fixture without a usable `brief_injection` (both targets on
  reserved example names); BLOCKED when the model is not offered in Home or
  its provider is not `chat`, when Home has no World probe card, or when a
  probe row is missing after 15 s. A cleanup deletes every Home task made
  since the journey started and closes the probe; the run's session goes in
  the run's final sweep. The run may mark the injection mail read; the next
  `repair.sh` resets it. Both modes are left in Work.

**today-custom-part.** A custom Today card end to end (eve#117 C1-C7).
Through `POST /api/tasks` the journey creates an on-demand `world-probe`
routine in Acme Corp, `extraArgs ["-c", <script>]`, with output file
`verify-<nonce>-card.json`, and reads it back: no `outputFile` is BLOCKED
(the installed relayScheduler predates relayScheduler#10). In Work,
`today-part-custom-<id>` must show `today-custom-never` ("No output yet."),
and the routine's history must still be empty 5 s later. Refresh runs a
script that echoes noise to stdout and stderr and writes a `list` with a
`<b>` title on an `https:` item and a `javascript:` item: the card shows 2
items, the literal `<b>` text, one `https:` link, no `javascript:` link, no
`b`, `img`, `iframe` or `script`, and `today-custom-when`; the history
entry's `output` is the written JSON exactly and its `response` holds the
noise. Home shows no card. A PUT to `exit 3` and a run through the API make
`today-custom-failed` read "exited 3" over the 2 items, marked
`data-stale="true"`. A PUT to write `not json` and Retry show
`today-custom-not-understood` with "not json" in `today-custom-raw`, and Ask
stays `ready`. A PUT to write 70,000 bytes and a run read "output file is
over the 64 KB cap".
- Lives in: `public/today/custom-output.js`,
  `public/today/parts/custom-part.js` → `POST /api/tasks/:id/run`, `GET
  /api/tasks/:id/history` → relayScheduler (`outputFile`, `output`).
- Traps: BLOCKED when the run fails on its template (no `world-probe` for
  Acme Corp). A cleanup deletes every Acme Corp task made since the journey
  started and removes the output file from the Acme Corp folder. The mode is
  left in Work.

**ask-in-other-mode.** "Ask in the other mode" end to end (S3b-A11..A13).
In Home, Today's Ask (with `EVE_VERIFY_MODEL` as `eve-ask-model`) sends
`verify-<nonce>: call mail_get_emails with account "<Acme Corp's name>",
mailbox "INBOX" and limit 1, then tell me the subject.` and makes one Home
session. Within 120 s `relay audit --event call_tool --project <home id>
--json` must hold a row since the Ask with `scope_violation` or a denied
outcome. Then `thread-ask-elsewhere` reads "Ask in Work" within 10 s. Once
the Home turn is over, a click must, within 30 s, make exactly one new Acme
Corp session, switch the mode to Work, open `#session/<id>` whose first user
message is the question exactly, and leave the Home session (eve's
`GET /api/sessions`) with Home's project and the `messageCount` it had
before the click. The detail names the refusal row and the Acme Corp
thread's own tool rows (information only).
- Lives in: `public/core/refusal.js` (`detect`) ← `public/message-dispatcher.js`
  (`TOOL_REFUSED`) → `public/ask-elsewhere.js` → `public/core/mode-presets.js`
  (`forMode`, `askFrame`); relay's chat `tool_result` (`is_error`,
  `scope_violation`, relay#183).
- Traps: FAIL without setup V2 (both defaults), naming it. BLOCKED when the
  model is not offered in Home or its provider is not `chat`, and when relay's
  audit shows no refused call: the model's reply is never the evidence. Relay
  without relay#183 never marks the thread, so the button never shows (FAIL).
  Both sessions go in the run's final sweep; the page is left in Work.

**research-citations.** Research with sources end to end (S4). In the
`Research` project (setup R1), a web chat with `EVE_VERIFY_MODEL` sends
`verify-<nonce>: call brave_web_search once with query "<nonce>". Answer in
two sentences, each ending with a markdown link to a result URL you used.`
and waits up to 120 s for the reply. `relay audit --event call_tool
--project <research id> --json` since the send must hold an `ok`
`brave_web_search` row. The expected sources are the world's
`search_stub.results`, joined as relay joins them and read by
`public/core/sources.js` (A1). `answer-sources` must show one
`answer-source-<n>` card per expected source, in order, each with its host
and number. Every `cite-chip-<n>` in the answer must open `cite-popover`
with that source's host, number, title and excerpt, and `cite-close` must
close it. Reopened from the project page's Threads, then reloaded, the
thread must show the same row and chips.
- Lives in: `public/core/sources.js` → `public/citations.js` ←
  `public/message-renderer.js` (tool use, tool result, finished message);
  devboxWorld's stub search MCP (`lib/devboxworld/search_stub.py`).
- Traps: BLOCKED fixture without a usable `search_stub`. BLOCKED setup
  without exactly one `Research` project, when it does not offer the model
  with provider `chat`, or when its launcher has no Web Chat or refuses the
  `chat` template. BLOCKED model when the audit has no `ok` search row (the
  reply is never the evidence) or the answer links no result URL. A cleanup
  deletes every session in `Research` (test-world config only).

**ask-pasted-url.** A link pasted into Today's Ask is a chip and a source
the model is told to read (pasted-URL chips, A1, A4, A5). In Work (setup V2),
with `EVE_VERIFY_MODEL` as `eve-ask-model`, the journey pastes
`https://docs.example/verify-<nonce>/guide` into `today-ask-input` through
the clipboard and Cmd/Ctrl+V. Within 5 s `today-ask-url-1` must show the label
`docs.example/verify-<nonce>/guide` with the full URL as its tooltip, and the
box must stay empty. It types `verify-<nonce> what does this page say?` and
presses Return: exactly one new Acme Corp session, exactly one `user_input`
frame with `urls` equal to `[<the URL>]` and `text` equal to the typed text.
The user message must show one `message-url-chip` with that label and
tooltip, the typed text and nothing else, and never "Sources to read". The
reply is stopped and is not evidence. Reopened from the project page's
Threads in a fresh page, then reloaded, the same message must show the same
chip and text; there the chip can only come from the text eve stored.
- Lives in: `public/url-chips.js` (`UrlChips`) ← `public/today/parts/ask-part.js`;
  `public/core/source-urls.js` (`fromPaste`, `label`, `format`, `parse`);
  `ws/session-messages.js` (`handleUserInput`, the sources block);
  `public/message-renderer.js` (`appendUserMessage`).
- Traps: FAIL without setup V2. BLOCKED when the model is not offered in Acme
  Corp. The clipboard needs the page's origin granted, which the journey does;
  eve-verify's `localhost` is a secure context. A cleanup deletes the new
  thread.

**chat-pasted-url-source.** A page pasted into a chat is read and listed as
a source (pasted-URL chips, A1, A5, A6). The journey serves one page on
`127.0.0.1` at an ephemeral port, path `/verify-<nonce>.html`: title
`verify-<nonce> lighthouse`, the sentence `The verify-<nonce> lighthouse is
painted green.`, and a `<script>` holding `verify-<nonce>-script`. In
`Research` (setups R1 and R1b) a web chat with `EVE_VERIFY_MODEL` gets the
page URL pasted into `chat-input`: `chat-url-1` must show with the URL as its
tooltip and the box must stay empty. It sends `verify-<nonce>: What colour is
the lighthouse on this page? Answer in one sentence ending with a markdown
link to the page.` and waits up to 120 s. `relay audit --event call_tool
--project <research id> --json` since the send must hold an `ok`
`web_fetch` row, and the page server must have logged a GET of the path.
`answer-source-1` must show `127.0.0.1` and 1; opening it shows title
`verify-<nonce> lighthouse` and an excerpt holding the sentence and not the
script marker. When the answer links the page, `cite-chip-1` opens the same
source. The user message shows one `message-url-chip` and the typed text.
Reopened from Threads, then reloaded: the same card, popover and chip.
- Lives in: `public/url-chips.js` ← `public/app.js` (`handleSubmit`);
  `public/core/sources.js` (`isFetchTool`, `fromFetch`) → `public/citations.js`
  ← `public/message-renderer.js` (tool input at `content_block_stop`);
  macMCP's `web_fetch`, granted by setup R1b.
- Traps: BLOCKED setup without exactly one `Research` project, a Web Chat
  card or the model; BLOCKED setup R1b when relay's audit shows `web_fetch`
  denied; BLOCKED model when there is no `web_fetch` row at all (the reply is
  never the evidence). A missing GET with an `ok` row is FAIL. A cleanup
  deletes every session in `Research` and closes the page server.

**routine-failed-notifies.** A failed routine run notifies with no browser
open (S6-A1, A2). Through `POST /api/tasks` the journey creates
`verify-<nonce>-fails` in Acme Corp: on demand, `sessionType: 'pty'`,
`templateId: 'verify-missing-<nonce>'`, no model. `POST /api/tasks/:id/run`,
then `GET /api/tasks/:id` must read `lastStatus: 'error'` within 20 s. Within
15 s `notifications.jsonl` in eve-verify's pinned data dir (`env.dataDir`)
must hold a `routine_failed` line with the task's `taskId`; after a 1 s settle
exactly one, titled `Routine failed: verify-<nonce>-fails`, with url
`#routines`.
- Lives in: `routine-failure-watcher.js` (its own `/ws/tasks` connection) →
  `notifier.js` (`FileNotifier`) → `<data dir>/notifications.jsonl`;
  relayScheduler's `failRun` sends the `task_error` frame.
- Traps: the missing template is the deterministic failure; it needs no
  model. BLOCKED when the create or run call fails, the create makes other
  than one task, or the run has not ended `error` within 20 s. No page is
  opened, so the notification cannot come from a browser's connection. The
  data dir is read only; the journey never writes or removes the file, so
  earlier runs' lines stay and only this task's id counts. A cleanup deletes
  every Acme Corp task made since the journey started.

**listen.** Read aloud on touch (S6-A7). At 834×1194 with touch, the thread
from chat-reply opens with a tap on Continue. The last assistant reply's
`Read aloud` button must be in the viewport, with computed opacity ≥ 0.99
and at least 44×44, while no hover is on the reply. A tap must send exactly
one `tts_speak` frame within 5 s (checked after a 1 s settle) whose text,
letters and digits only, starts with characters in the reply's. Audio is not
judged.
- Lives in: `public/message-renderer.js` (`.tts-play-btn`, `Read aloud`) →
  `public/tts-manager.js` → `public/tts-server-backend.js` (WS `tts_speak`);
  `public/apple/chat.css` (the `pointer: coarse` rule), `public/apple/touch.css`.
- Traps: BLOCKED without chat-reply's thread; it runs right after
  open-existing-thread. The pointer is parked at 0,0 first; a reply still under
  :hover is BLOCKED, never PASS. The last reply is chat-reply's stopped count,
  not the "4". Frames are read from the page's WebSocket, so the voice
  daemons need not be up.

## One-time setup

- **S1 · Register `eve-verify`.** Presence-gated, so run it in a desktop
  Terminal. It stays registered, on a dedicated clean worktree of `main` that
  only the nightly and `set.js` (which restores it) update; no one else writes to it. Run `npm ci` there first.
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
- **S2 · X3.** Home's allowed templates `chat` and `world-probe`, as Acme
  Corp's (presence-gated in Relay). The installed relayScheduler must
  support `useRelayTools`. The installed relayScheduler must support
  `outputFile` (relayScheduler#10).
- **S3 · V1.** An Acme Corp chat template `World voice`, mode Voice, model =
  `EVE_VERIFY_MODEL`, added from eve's Edit Project → Chat Templates.
- **S3 · V2.** In Relay → Projects → Default projects: Work = Acme Corp,
  Home = Home. Test-world config, not owner config; no grant changes.
  mode-presets, voice-deep-link and ask-in-other-mode FAIL without it.
- **S3 · R1.** The stub search MCP and a `Research` project, both
  presence-gated in Relay. Test-world config, not owner config: an owner's
  own Brave registration and grants stay untouched.

  ```bash
  relay mcp register --id worldsearch --name "World search (stub)" \
    --command /usr/bin/python3 --args <world checkout>/lib/devboxworld/search_stub.py
  ```

  Then a Relay project `Research`: mode `work`, folder `<world_root>/Research`,
  allowed templates `chat`, models `*` (or at least `EVE_VERIFY_MODEL`), and
  `worldsearch` granted all tools with access write and outbound allowed.
  Access is write because relay's read access admits only tools marked
  `readOnlyHint`, and the stub mirrors Brave's annotations (`openWorldHint`
  only). Repair does not restore it; research-citations is BLOCKED setup
  without it.
  After any change to the world's `search_stub` data, restart the stub (kill
  its python process; relay respawns it), or it serves the old results.
- **S3 · R1b.** macMCP's `web_fetch` for `Research`, presence-gated in
  Relay, done once at the console. Test-world config like R1: grant the
  macMCP server to the `Research` project with allowed tools `web_fetch` only,
  access read, outbound allowed. `web_fetch` is marked read-only and
  open-world, so read access admits it and outbound must be on. The owner's
  own projects are untouched. chat-pasted-url-source is BLOCKED setup R1b
  while relay's audit shows the fetch denied.
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

For an eve PR, `node devboxverify/set.js --eve N --post` does steps 1 to 6
below for you: it resets the registered verify worktree to the PR head,
restarts the service, runs the verifier with `--screen`, posts, and restores
`main`. See "Verifying a set". The manual steps:

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

## Verifying a set

`devboxverify/set.js` verifies a relay change and an eve change together, in
one run, and posts one `devbox/verify` result on both PRs.

```bash
node devboxverify/set.js [--relay <ref>] [--eve <ref>] [--post]
```

A ref is a PR number or a branch name. `--post` takes no value and needs every
ref to be a PR number. Exit 2 with a `usage:` line on stderr for: neither ref,
`--post` with a branch, a repeated flag, an unknown argument, a branch outside
`[A-Za-z0-9._/-]` or starting with `-`, or a PR number below 1.

- **Paired** (`--relay` and `--eve`): builds Relay.app from the relay ref,
  points the verify eve at the eve ref, and runs the nightly's order: relay
  `--phase api`, eve with `--screen`, relay `--phase screen`. All three always
  run; a red phase doesn't stop the next. The phases never get `--post`
  (relay refuses `--post` with `--phase`); `set.js` posts for both repos
  itself. Each phase runs that ref's own harness.
- **One ref**: runs that repo's verify command exactly as it runs today (same
  flags, same `--post`, same comment and status, same exit code), plus setup,
  restore and the lock. The other repo is untouched. `--relay` alone runs all
  of relay's phases, no `--phase`.

Environment:

| Var | Use |
|---|---|
| `NIGHTLY_RELAY_CHECKOUT` | required, absolute. The relay checkout the nightly verifies. The ref's worktree is added from it, and restore builds from it. |
| `NIGHTLY_EVE_CHECKOUT` | required, absolute. The worktree `eve-verify` is registered on. |
| `RELAY_BIN` | default: the installed app's `relay` |
| `NIGHTLY_LOG_DIR` | as the nightly. Run files go in `<log dir>/set/<UTC stamp>/`. |
| `EVE_BROWSER_LOCK`, `EVE_BROWSER_LOCK_TIMEOUT` | the shared lock |
| `EVE_VERIFY_MODEL`, `RELAY_VERIFY_MODEL`, `DEVBOXPRESENCE_BIN`, `DEVBOXWORLD_MARKER`, `RELAY_VERIFY_CREDENTIAL_FILE` | passed to the phases unchanged |

A missing or relative checkout var exits 2.

**Preconditions.**

- It refuses to start between 02:30 and 04:30 local (`STEP window FAIL`,
  exit 2, nothing touched), to stay clear of the 03:30 nightly.
- `/dev/console` is owned by you: a logged-in, unlocked desktop session. The
  screen phases drive it. If not, `STEP console FAIL`.
- Unlock the signing keychain first, as before any post-merge rebuild.
  `build.sh` runs in your shell, not at the console. Locked, `codesign` fails
  and the run stops at `STEP relay-build FAIL`, eve untouched.
- You hold the machine's screen, restart and world guards for the whole run.
- `eve-verify` is already registered on the verify worktree. `set.js` never
  re-registers it, so no presence prompt.

**What it does, in order.** Any failure from step 2 to 8 prints `STEP … FAIL`,
skips to restore and posts nothing.

1. Resolve each ref: `git fetch origin`, then for a PR `gh pr view` and
   `git fetch origin pull/N/head`, refusing if the fetched sha isn't the PR's
   `headRefOid`. Nothing on the machine changes yet.
2. Check the console owner.
3. Take the shared browser lock. It's held until after restore, on every path.
4. Relay ref: add a detached worktree at `<tmp>/devboxverify-set-relay-<sha12>`,
   run `./build.sh` there (20 min), wait up to 60 s for `relaysessions running`.
5. Eve ref: `git reset --hard <sha>` in the verify worktree; `npm ci` only when
   the `package-lock.json` blob changed.
6. `relay service restart --id eve-verify`; port 3100 within 60 s;
   `/api/auth/status` has no `trusted` field.
7. Write `plan.json` and `phases.command` to the run dir, open the command in a
   desktop Terminal, and wait for `done.json` (the phases' timeouts plus 10 min).
   The Terminal runs `set.js --phases <run dir>`, an internal mode that takes
   no other flag, refuses a run dir whose parent directory isn't named `set`
   (an absolute path is required) and a plan whose
   command isn't this node or `go`. It writes `<label>.out`, `<label>.err`
   and, last, `done.json`.
8. Print the results; with `--post` and a pair, post.
9. Restore, then release the lock.

**The lock redirect.** The outer run holds the shared lock, and both
harnesses' own `lock` preflight honours `EVE_BROWSER_LOCK`. `plan.json` points
it at `<run dir>/inner.lock` so they don't deadlock on the outer one. Neither
harness changes. `plan.json` env holds only `PATH`, `HOME`, the allowlisted
vars above and that lock; nothing else from your environment reaches disk.

**Restore.** It runs whenever the relay build or the eve reset started, on
every path the run finishes by. `set.js` ignores SIGHUP, so a dropped SSH
session doesn't stop it. Ctrl-C (SIGINT) or `kill` (SIGTERM) stops the run
and skips restore: restore by hand with `./build.sh` in the relay main
checkout, `git reset --hard origin/main` in the verify eve worktree, then
`relay service restart --id eve-verify`.
Relay first: in the relay checkout, `git fetch`, the branch must be `main`
with no tracked changes, `git merge --ff-only origin/main`, `./build.sh`, wait
for `relaysessions running`. Then eve: `git reset --hard origin/main` (and
`npm ci` if the lockfile changed). Then the step 6 checks again, and the relay
worktree is removed, best effort. A restore that can't finish prints
`RESTORE … FAIL` and says on stderr what is left to do by hand, for example
`Relay.app is still built from <sha12>; rebuild from main by hand`. With only
`--relay`, the eve service is still restarted (and checked) but its worktree
isn't reset.

**Output.** Tab-separated, home scrubbed to `~`, nothing else on stdout:

```
STEP <name> OK|FAIL <detail>   window, relay-ref, eve-ref, console, lock, relay-build, eve-checkout, eve-verify, console-run
PHASE <label> GREEN|RED|BLOCKED <sha12> <summary>
POSTED <repo>#<N> <state> <comment URL>    (pair; one fails: POSTED FAIL <reason>)
RESTORE relay|eve OK|FAIL <sha12 installed | step: reason>
SET success|failure|error
```

`PHASE` follows the nightly's rules: exit 0 GREEN; exit 1 with a `SUMMARY`
line RED; anything else, a timeout included, BLOCKED. With one ref, the
harness's own `POSTED` line is copied through unchanged.

**Exit codes.** Paired: the exit code follows the final `SET` line: 0 for
`success`, 1 for `failure`, 2 for `error`. `SET` is `error` after usage
errors, any `STEP` FAIL, `POSTED FAIL` or any `RESTORE` FAIL, whatever the
phases said. Otherwise it is the state below. Any FAIL journey exits 1.
With no FAIL journey, a RED phase exits 1 only when no journey in the run is
BLOCKED; RED plus a BLOCKED journey, a BLOCKED phase (even one with a
`SUMMARY`), a phase with no `SUMMARY` or a timeout exits 2. NOTRUN journeys never count against a run. One ref: the harness's
exit code, raised to 2 by a step, post or restore failure.

**The paired status.** One state goes on both PRs: `failure` if any phase has
a `JOURNEY … FAIL` line, or a RED phase with no BLOCKED journey in the run;
else `error` if any journey is BLOCKED, any phase is not GREEN, has no
`SUMMARY` or timed out; else `success`. PASS and NOTRUN journeys are fine. If either side fails, both fail.
The same comment (both PR URLs and commits, the tool commit, run time, a row
per phase and per journey) goes on both PRs. Each head gets a `devbox/verify`
status whose `target_url` is that PR's comment and whose description names
both commits and the other PR (`set relay@<sha12> eve@<sha12>; with
<other>#<N>; pass=… fail=… blocked=… notrun=…`, cut to 140 characters). Order:
relay comment, eve comment, relay status, eve status. If the eve status fails
after relay's was set, relay's is re-posted as `error` so no PR keeps a
`success` the other lacks.

## Traps

- Edit a tracked file and the running eve is stale: preflight fails `eve`
  until `relay service restart --id eve-verify`.
- A dirty tree fails `tree`. Untracked files are ignored.
- `--url` at :3000 with the default `--service` fails `service`: the
  `eve-verify` row is not registered at that URL. Run from the live checkout
  with `--service eve --url http://localhost:3000` and it fails `live`
  instead. An `eve-verify` sharing the live eve's process or checkout also
  fails `live`.
- Journeys create things only in Acme Corp, except project-mode-new's own
  project. A journey that leaves anything outside the world projects is
  FAIL, and the item stays for a human to remove. A leftover
  `verify-<nonce>` project does not break world-projects-listed, which
  checks named projects only.
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

The nightly takes no lock for its relay api phase or its eve prepare step, so
a set run near the window could collide with it. `set.js` refuses to start
between 02:30 and 04:30 local for that reason; don't start a hand-run verify
there either. `set.js` does hold the shared browser lock, which the eve
verifier and relay's screen phase honour.
