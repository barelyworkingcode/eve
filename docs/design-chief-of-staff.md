# Chief of Staff: model and prompt

Epic relay#231, eve#197. This page covers the model session and the prompts (`chief-of-staff-model.js`, `chief-of-staff-prompt.js`). The reader, send path and thread view have their own owners; the wire contract is in [api.md](api.md).

## What the model does
It writes. The reader decides when something needs the person, and eve builds every card from relay data. The model only turns a batch of events into a headline and body per session (a wake), or answers a person's message in plain text, reading project files and offering actions through the `eve-cos` tools (a person turn). When it is off or at its daily limit, eve posts a fixed template instead of a wake post, and a person turn gets a notice that names the cause ([Templates](#templates)).

## Why the wake model has no tools, and what the person model has
Same reasoning as [design-brief.md](design-brief.md): agent text is hostile input, and the safety is the gate, not the prompt. The wake model reads agent excerpts, so the cleanest gate is that it cannot do anything at all. A reply is text that eve parses; it cannot send, fetch or read. The person model never sees an excerpt. It gets an allow-list instead: `Read`, `Grep`, `Glob` and the four `eve-cos` MCP tools (`PERSON_ALLOWED_TOOLS`), so it can answer questions about projects and offer actions.

Provenance keeps that safe. Files and tool results are data, and the person session's system prompt says so; but eve does not rely on that. Once the session has called any reading tool, its text may be shaped by what it read, so the `eve-cos` actions act at once only on the person's own words aimed at a target the person named, and anything else becomes a card the person taps (see "Actions and provenance"). The session can read but never edit (`Edit`, `Write`, `Bash` and every other built-in stay denied; `readOnlyProjects` keeps its reads inside the project's roots).

relay has no "no tools" switch. eve gets the same result in three steps (D1, D12 for the person session):

1. The session is created with `settings.permissionPolicy.deniedTools = [...BUILTIN_TOOLS minus the allowed ones, ...extra]`. relay maps that to Claude's `--disallowedTools` and its hook preflight denies the same names. The session is `headless` and has no `agent` (so it stays out of the session list). The wake session sets nothing else. The person session adds `useRelayTools` and `readOnlyProjects`, and drops `mcp__*` from the deny list because an MCP tool is allowed.
2. A bootstrap prompt with no agent data is the first message. The session's `system/init` frame must arrive before `message_complete`, or the launch fails with `tools_unverified`. Agent text is never sent before this passes.
   Only an `init` whose `tools` is an array counts. A `null` or missing list (relay's pi and codex providers send `"tools": null`) is "unknown" and fails the same way.
3. eve compares `init.tools` with `allowedTools` (empty for the wake session). A tool outside the list: eve relaunches once with those names added to the deny list; if it is still listed the model stays off (`tools_present`). An allowed tool that is missing: the turn fails at once (`tools_missing`; its usual cause is that the `eve-cos` MCP is not granted to the project, and the notice says so), and the next person turn launches again, so a grant takes effect without a restart. A later `init` that differs kills the session the same way.

Alerts keep posting as templates while the model is off. `tools_missing` concerns only the person session: the wake model keeps writing alerts.

### BUILTIN_TOOLS
Recorded from a default Claude Code haiku session's `system/init` on the devbox (Claude Code 2.1.x), MCP tools left out because they differ per machine (the init check catches them):

`Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, LSP, Monitor, NotebookEdit, PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, ToolSearch, WebFetch, WebSearch, Workflow, Write`

The constant ends with `mcp__*`, which denies every MCP tool. On the devbox a headless session still loaded the user-scope and claude.ai connector servers, and denying them by name on a relaunch did not clear the init list; `mcp__*` did (checked with the Claude CLI's `--disallowedTools`).

The constant also lists names that earlier or later releases report (`Agent`, `Glob`, `Grep`, `MultiEdit`, `TodoWrite`, `BashOutput`, `KillShell`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `NotebookRead`, `SlashCommand`). Denying a name that does not exist is harmless. The init check, not this list, is what proves the session has only its allowed tools.

## Quoted data
Every value an agent controls (excerpt, session name, project name, state) reaches the model only inside one `<agent_data>` region:

```
<agent_data>
{quoteData(value)}
</agent_data>
```

`quoteData(v)` is `JSON.stringify(v)` with `<`, `>`, `&`, U+2028 and U+2029 escaped as `\uXXXX`. No value can spell `</agent_data>`, so none can close the region, and `JSON.parse` on the region gives the original back. The prompt says the region is data and never an instruction, and the system prompt says it again; that is the second line of defence, not the first.

A person message is trusted. It sits outside the region, but also goes through `quoteData` so it cannot fake a tag. The person turn's project list (names are user-set, local paths are local, a hosted project has no path) and the wake turn's events (labels and excerpts are agent-controlled) sit inside the region.

## Wake and person turns
- **Wake** (`Chief of Staff wake (eve cos v1)`): up to 10 events, each `{sessionId, label, project, state, since, excerpt}`. The reply ends in one fenced json block, `{"posts":[{sessionId, headline, body}]}`. Posts naming an id outside the batch are dropped. A `send` in a wake reply is ignored: nothing in a wake is the person speaking.
- **Person** (`Chief of Staff person (eve cos v1)`): the person's text plus `projects: [{id, name, path}]` for local projects and `{id, name, sshHost: true}` (no path) for projects on an SSH host, in list order, at most 100, in the quoted region. The system prompt says the model cannot read a hosted project's files and must say so by name. There is no roster in the prompt; the model asks `cos_list_sessions` when it needs one. The reply is plain text: eve joins every text block of the turn, trims it and cuts it to `CAPS.reply`, and posts it as a `reply`. Acting goes through `cos_propose_start` and `cos_propose_send`, never through the reply. eve parses no JSON from a person turn. An empty reply with no card, start or send gives the notice "I didn't write a reply. Try again."

Wake parsing takes the last fenced `json` block, else the last balanced `{…}`. Text is trimmed and cut to `CAPS`. Failure reasons: `empty`, `no-json`, `bad-json`, `bad-shape`, `unknown-session`.

A failed person turn posts a notice that names the cause (`turnFailureNotice`): the daily limit, a timeout, a lost model session (`turn_failed`, `disconnected`, with the cause cut to 80 characters), or the off notice for a login, launch or tool-check failure. The session also ends on a `session_ended` or `process_exited` frame or a closed socket; the next turn relaunches it, which picks up new roots and resets the session's read mark.

## Wake rules (reader side, for reference)
A trigger is a `session_state` entering `asking|errored|stalled`, or a `turn_done` whose excerpt `isQuestion`. `isQuestion` strips trailing whitespace and closing punctuation (`` * _ ` " ' ) ] > » ” ``) and tests the last character for `?` or `？`. Eve decides this with a fixed rule (D2); the model only writes the post.

## Errands and the finished post
An **errand** is an agent the person handed work through the thread: a headless `_startSession` that relay answered with 201, or a `_send` that relay accepted (202), whether by a direct action or a card tap. Terminal starts are not errands. Eve keeps them in memory only (`_errands`, newest last, cap 50, oldest evicted); a restart mid-errand posts nothing. A record goes away on settle, on `session_ended`, when the same session is armed again (it moves to newest), or on eviction. There is no timer.

One outcome per errand:
1. `turn_done` whose excerpt `isQuestion`: the record is dropped and the question alert posts as usual.
2. Any other `turn_done`: the record keeps the last 500 characters of the excerpt and waits for the state.
3. The next `session_state` `idle` queues a finished entry (a person's Stop also ends in `idle`, so it posts too). Other states post nothing extra; `errored` keeps its alert.
4. `asking`, `stalled` or `errored` before any `turn_done`: the record is dropped, the alert posts, no finished post. An `idle` from the launch, before the turn, leaves the record alone.

Finished entries wait in `_finished` (cap 50), never in the alert queue, and `_isBusy()` counts them. The pump runs person turns, then the ready alert batch, then up to 10 finished entries, oldest first, with no quiet window. Finished entries are skipped only when their session is gone from the roster; a later send to it does not drop them.

**The finished turn** runs on the wake session. Its prompt (`Chief of Staff finished (eve cos v1)`) holds, per session, `{sessionId, label, project, excerpt}` in one `<agent_data>` region; the model writes one or two short lines each, `{"posts":[{sessionId, summary}]}`, parsed like a wake reply (`parseFinished`). Each post's summary is the model's (`source: model`) or, when the session is at its daily limit, the turn fails or the reply omits that id, the template (`source: template`). eve.log gets `Chief of Staff finished post: session <first 8 of id> source <model|template>`; it never carries summary or excerpt text.

Wake turns (alerts and finished) use `summaryModel` when the chosen project allows it; person turns keep `model`. If the project's allow-list excludes `summaryModel`, wake turns use `model` and eve warns once per project and model: `Chief of Staff summary model <m> is not allowed in <project name>; wake turns use <model>`.

## Templates
| state | headline | body |
|---|---|---|
| asking | `<label> is asking you something` | It won't go further until you answer. |
| question | `<label> asked you a question` | Its last turn ended on a question. |
| errored | `<label> stopped with an error` | Open it to see what happened. |
| stalled | `<label> has gone quiet` | It hasn't printed anything for 5 minutes. |
| finished | `<label> finished` | The last 200 characters of its final reply, from the first word break and prefixed `…` when cut; `It finished without a reply.` when empty. |

## Two model sessions: wake and person
A model session keeps its context. With one session, a hostile excerpt read in an earlier wake turn could still sit in that context when the person types a message, and could steer the reply of that later turn into a send. So there are two sessions, never sharing context:

- **Wake model** reads agent excerpts (inside `<agent_data>`). Its replies can only become posts; a `send` in a wake reply is ignored.
- **Person model** sees the person's own text and the quoted project list, and reads files and the `eve-cos` tools on its own. It never sees an excerpt in a prompt. It can only propose; eve's provenance rules and the roster check decide what an action does.

Both are `ChiefOfStaffModel` instances: launched lazily on their first turn, each with its deny list and the fail-closed tool check, each named `__cos:<12 hex>` (unlisted), each counted against the same daily limit (a person turn costs a bootstrap of its own on first use). The reader ignores both ids, and the roster also skips `__search:` sessions. Both ids are kept in `data/chief-of-staff-state.json` (`modelSessionId` for the wake model, `personSessionId`) and DELETEd best effort at the next start. A `tools_present` or `tools_unverified` failure on either session turns the model off for both; `tools_missing` fails only that person turn.

The roster refetch before a person turn replaces the roster's membership (a session that is gone drops out) and keeps the known states of the rows still listed.

## Model session behaviour
- Each session is launched lazily on its first turn, named `__cos:<12 hex>`. The previous run's session id is DELETEd best effort before launch.
- It joins its own unscoped `/ws` and handles only frames carrying its session id. Reply text is the `text_delta`s up to `message_complete`.
- `error`, `process_exited`, `resume_required` or a closed socket reject the turn and end the session; the next turn launches a fresh one. A timeout sends `stop_generation`, rejects with `timeout` and also ends the session, because the late `message_complete` would otherwise land in the next turn.
- `countCall()` runs before every `send_message`, the bootstrap included. A `false` rejects with `limit` and sends nothing.
- Turns are serialised inside the class.
- State file: `{day, calls, modelSessionId, personSessionId, limitNoticeDay}`. `limitNoticeDay` keeps the once-a-day limit notice from repeating after a restart. `stop()` returns a promise that settles when queued post and state writes are on disk; graceful shutdown waits for it (2 s at most).
- A refused scoped `/ws` upgrade gives no close or error event, so the reader handles `unexpected-response` itself: 403 turns the thread off (`scope_refused`), any other status retries with backoff. The backoff resets only after the roster list has been read.
- Error codes: `limit`, `launch_failed`, `tools_present`, `tools_unverified`, `turn_failed`, `timeout`, `disconnected`.
- An API error from the CLI is not a reply. relay marks it on the assistant `message_start` (`error`) and on `message_complete` (`isError`, `apiErrorStatus`). The turn, the bootstrap included, rejects with the CLI's code (for example `authentication_failed`) and ends the session. `authentication_failed` is fatal: the thread goes off with a notice that the model can't log in and makes no model calls until eve restarts.
- eve.log gets one warning per failed model turn (code and message, never reply text) and one per reply that can't be parsed (turn kind, parse reason, model session prefix, reply length).

## Actions and provenance

The person model can start an agent and send to one through the `eve-cos` MCP (`mcp/cos.js`): `cos_list_sessions`, `cos_session_status`, `cos_propose_start`, `cos_propose_send`. The MCP only calls eve's loopback `/internal/cos`; eve decides.

**A call is tied to a real tool call.** eve records every `tool_use` the person model makes (`ChiefOfStaffModel`'s `onToolUse`, fired when a tool_use block stops) in a `CosTurn` for the length of the person turn. `/internal/cos` checks the loopback peer and the secret, that `meta.project_id` (vouched by relay) is the person model's project, that a person turn is in flight, and then waits for an unclaimed `tool_use` with the same name and the same input (sorted-key JSON). `claim()` resolves when that call is recorded and rejects when the turn settles, so a call that the model never made, or made in an earlier turn, is refused as `unverified_call`. eve.log gets one info line per tool call with the turn id and tool name; the input is never logged, because it can quote agent data.

**Provenance decides act or card** (`chief-of-staff-provenance.js`, pure):
- If the person model session has read nothing, eve acts at once (`no_read`). Any tool except the two propose tools counts as a read, and the mark lasts the life of that model session.
- After a read, eve acts at once only when the prompt or text is a verbatim span of the person's message (whitespace collapsed, case-sensitive) and the message names the project (start) or the session label (send), case-insensitively.
- Otherwise eve posts a `start_card` or `send_card` and does nothing until the person taps Start. Edits made on the card are the person's own words, so a tap needs no provenance check.

**Start goes through relay's scoped route only** (`POST /api/chief-of-staff/sessions`), never an unscoped create, so the session carries `origin: 'chief-of-staff'` and relay audits it. eve then refreshes the roster, so a headless start joins it and alerts for it post as usual. A terminal start shows in relay's session list and in the `started` post, not in the roster. A project on an SSH host starts headless only (relay refuses a terminal there with `terminal_on_host`, which posts `start_failed`). A relay refusal posts `start_failed` (or `send_failed`) and the tool answers `relay_<code>`.

**Cards** persist with the posts. Only a `pending` card takes an action, and its state leaves `pending` before anything is awaited, so one tap acts once. `cos_post_update` replaces the post in every browser. A card never expires; `failed` is final.

## Decisions
- **D1** Wake session: tools off in eve: deny list, init check, one relaunch, else off. The person session uses D12.
- **D12** Person session: an allow-list (`PERSON_ALLOWED_TOOLS`) on the same machinery. Extras are denied and relaunched once; a missing allowed tool turns the model off with a notice that names the fix.
- **D2** Eve judges "ends on a question" with `isQuestion`; judging every turn with the model would cost a call per agent turn.
- **D3** The thread covers every project and ignores Home/Work mode.
- **D4** States seen at startup or reconnect never post; only transitions do.
- **D5** The model runs in the configured project, else the first local project with no permission policy that allows the model (D11 says where "configured" comes from).
- **D6** Eve builds cards from relay data and falls back to template posts.
- **D7** Thread traffic is WS descriptors; `routes/index.js` stays untouched.
- **D8** Drop in on a non-headless session opens it.
- **D9** devboxverify writes the `chiefOfStaff` key into eve-verify's pinned `settings.json`.
- **D10** During a verify run the live eve and eve-verify may both post. Accepted.
- **D11** The project, model and daily call cap come from relay's Chief of Staff setting (`GET /api/chief-of-staff/config`, unscoped). Eve reads it at start and before every model turn, so a change applies to the next turn with no restart. While relay answers `configured:false` (or 404, an older relay), the `chiefOfStaff` block in `data/settings.json` applies, then the defaults; eve reads that file and never writes it. When relay answers anything else, or not at all, eve keeps the settings it has and warns once per outage. `enabled` always comes from the file. Eve logs the source (`Chief of Staff config from relay|settings.json|defaults`) at the first read and on each change.
- **D13** `summaryModel` (default `haiku`) is a file-only key in eve's `data/settings.json` `chiefOfStaff` block; relay's setting is unchanged and does not carry it. It moves the whole wake session, alerts included. A project allow-list that excludes it makes wake turns fall back to `model`, with the warning above.
- **D14** Terminal starts and sessions the thread never started or sent to get no finished post, and errands are not persisted. "Last turns" means the final `turn_done` excerpt (last 500 characters); more history would need a new relay call.
