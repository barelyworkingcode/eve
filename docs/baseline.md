# Cloud baseline: goals to specs

What the Linux tiers prove about eve before the Home|Work epic (#34) changes it,
and what they cannot. The specs drive the real eve in Chromium against the relay
fake (`test/integration/fake-relay.js`), so a green run says "eve does this
against a relay that answers as relay's source says". It does not say "relay
does this": the real relay, the devbox journeys (`devboxverify/`) and the
pixel baselines stay the real-app gate.

Every spec asserts what a person sees today. A slice that changes a behaviour on
purpose rewrites the matching assertion in the same PR and says so.

## Goals

Goal numbers are `docs/FEATURES.md`. Specs are under `test/e2e/`; `goals/` is
the goal-level set, the rest predate it.

| Goal | Proved in the cloud by | Not provable here |
|---|---|---|
| G1 Get in, see my work | `goals/g1-landing`, `goals/home-screen`, `app` | passkey sign-in off the trusted network (real WebAuthn) |
| G2 Ask and get an answer | `goals/g2-g8-chat` (reply, list, error row, resume), `chat`, `chat-input-row`, `chat-form-and-permissions` (Stop, send gating) | model quality, real streaming |
| G3 Pick up where I left off | `goals/g3-reopen-thread` (Sessions list, Continue, ⌘K, running marks), `schedules-and-connection` (deep link) | history from a real transcript |
| G4 Shell on my project | `goals/g4-terminal` (only when asked, runs a command, survives reload), `terminal-reconnect`, `goals/home-screen` (template tiles) | a real PTY, sandboxing |
| G5 Hand off a task | `goals/g5-tasks` (create, run, fail, edit, delete), `task-dialog-models`, `schedules-and-connection` (wire shapes) | real scheduling, relayScheduler behaviour beyond its pinned API |
| G6 Check what agents did | `goals/g5-tasks` (last run opens as its thread), `changes-panel` (Changes, diff) | a real agent's edits |
| G7 Read and edit files | `goals/g7-files` (tree, open, save, outside change, Reload, node_modules quiet), `tab-panes` | |
| G8 Agents under my control | `goals/g2-g8-chat` (prompt, Allow, Deny, Allow All, queue), `chat-form-and-permissions` (plan mode) | relay's owner gate |
| G9 Hands-free | `chat-defaults` (voice deep link), `voice-buttons` | speech (`test:voice`, live daemons) |
| G10 Find something | `goals/g10-find` (⌘K, project search, no matches) | |
| G11 Share files and images | `chat-input-row` (attach visibility) | **gap**: paste/drop upload and generated-image rendering have no spec |
| G12 Set up a project | `goals/g12-projects` (create, refuse, edit, delete), `template-blank-model`, `chat-defaults` (template editor) | relay-owned settings (per-tool MCP scoping, tokens) |
| G13 Project on another machine | integration `host-projects` | **gap**: no browser spec for host chips and status |
| G14 Arrange my workspace | `tab-panes` | |
| G15 Phone | | native app, Safari, touch; devbox only |
| G16 Add or remove a browser | `passkey-enrolment` (button), integration `eve-passkey-enrolment` | the ceremony itself (a CDP virtual authenticator could cover it; not attempted) |

## What changed to make this possible

- The fake answers as relay and relayScheduler do, pinned to their source
  (`relay-source-pins.test.js`; see `docs/test.md`): project `mode` and
  `default_for`, the default-project route, tasks (CRUD, run, history, the
  `/ws/tasks` events), terminals that echo and run `echo`, joined-viewer
  delivery, refusals and close codes.
- `test/e2e/goals/fixture.js` gives a spec two projects with files and lets it
  seed sessions, tasks, terminals and templates on the fake before the page opens.

Screenshots of the states these specs drive are in [baseline/](baseline/) (desktop, Chromium, the fake relay).

## Known behaviour recorded, not fixed

Found while writing the specs. Each is pinned as it stands, or as an expected
failure (`test.fail`) that goes red the moment it is fixed.

- **Home project chips are inert** for any project but the active one: the chip
  emits `PROJECT_ACTIVATED`, which only TabManager handles, so the panel, rail and
  highlight do not move (`goals/home-screen`, `test.fail`).
- **Relay down at load looks like a new install**: Home offers "Start with a
  project" because projects come from relay and none loaded, beside a
  "Reconnecting…" banner (`goals/home-screen`).
- **"Running" means the provider process is alive** (`live` in relay's session
  summary), not that a turn is in progress (`goals/g3-reopen-thread`).
- **eve drops `mode` and `default_for`** from relay's project view
  (`project-normalize.js` allow-list); the Home|Work slices add them
  (`test/unit/project-normalize.test.js`).
- **The ⌘K palette is a snapshot** of what is loaded when it opens.
- **Deleting a project asks twice**: a native `confirm()`, then the modal that
  says what is lost (`goals/g12-projects`).

## Stability

The suite is run ten times in a row on Linux with `--retries=0`; the result is
recorded in the PR. A spec that needs a retry is fixed, not retried.
