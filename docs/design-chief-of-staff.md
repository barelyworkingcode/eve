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

Claude Code 2.1.301 also lists its own MCP tools, which are not named `mcp__*`, when a user-scope MCP server is configured: `WaitForMcpServers` while the server connects, then `ListMcpResourcesTool`, `ReadMcpResourceDirTool` and `ReadMcpResourceTool` once it has. They arrive in two waves, more than the one relaunch covers, so the constant names all four (#523).

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
- **Person** (`Chief of Staff person (eve cos v1)`): the person's text plus `projects: [{id, name, path}]` for local projects and `{id, name, sshHost: true}` (no path) for projects on an SSH host, in list order, at most 100, in the quoted region. The system prompt says the model cannot read a hosted project's files and must say so by name. There is no roster in the prompt; the model asks `cos_list_sessions` when it needs one. The reply is plain text: eve joins every text block of the turn, trims it, passes it through `capReply` (ceiling `CAPS.reply`, 8000; a cut ends ` …` at a sentence or word and keeps a closing fenced block) and posts it as a `reply`. The person system prompt asks for short replies and the full length on request. Acting goes through `cos_propose_start` and `cos_propose_send`, never through the reply. eve parses no JSON from a person turn. An empty reply with no card, start or send gives the notice "I didn't write a reply. Try again."

Wake parsing takes the last fenced `json` block, else the last balanced `{…}`. Text is trimmed and cut to `CAPS`. Failure reasons: `empty`, `no-json`, `bad-json`, `bad-shape`, `unknown-session`.

A failed person turn posts a notice that names the cause (`turnFailureNotice`): the daily limit, a timeout, a lost model session (`turn_failed`, `disconnected`, with the cause cut to 80 characters), or the off notice for a login, launch or tool-check failure. The session also ends on a `session_ended` or `process_exited` frame or a closed socket; the next turn relaunches it, which picks up new roots and resets the session's read mark.

## Wake rules (reader side, for reference)
An `errored` trigger's excerpt is the frame's exit line (`exitLine`, the same text the agent card shows; empty when relay sent no `exit`), and it is never logged. A trigger is a `session_state` entering `asking|errored|stalled`, or a `turn_done` whose excerpt `isQuestion`. `isQuestion` strips trailing whitespace and closing punctuation (`` * _ ` " ' ) ] > » ” ``) and tests the last character for `?` or `？`. Eve decides this with a fixed rule (D2); the model only writes the post.

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

## Row notes
The agent rail shows a one-line note under each agent. Eve sets it from the reader's frames and sends it as `cos_row_note` (and `rowNotes` in `cos_snapshot`); see docs/api.md. A note is `{sessionId, text, kind: summary|alert, source: pending|model|template, at}`: one line, 1 to 160 characters, memory only (cap 200, oldest evicted), removed on `session_ended` and when a roster seed or prune drops the session. A repeat of the same note sends nothing. A row note never posts to the thread: `_rowTurn` never calls `_addPost`, `_notice` or `_noteLimitOnce`.

**Triggers.**
- `turn_done` that `isQuestion`: the note is the template line (`source: template`), no model call; the question alert posts as before.
- `turn_done` on a session that is not an errand: the roster row keeps `turnEnded` (last 500 characters). The next `idle` sets a `pending` note (the agent's last words, from `templateRow`) at once and queues the row in `_rowWaiting`. Any other state clears `turnEnded` and the waiting entry.
- An errand that goes idle also gets a `pending` note; the finished turn then sets the note from the finished summary (`model` or `template`), so an errand never costs a second call.
- Each alert in a wake turn sets an `alert` note from its headline (`model` or `template`). A `question` event sets no alert note.

**Debounce.** `_rowWaiting` holds one entry per session (a newer turn replaces it; cap 50, oldest evicted, since its pending note already equals the template). A batch is ready at `min(newest + 5 s, oldest + 30 s)` and takes at most 10 entries, oldest first. The pump runs person turns, the ready alert batch, finished entries, then the ready row batch, so rows never delay an alert or a reply. `_isBusy()` ignores `_rowWaiting`; a row turn in flight counts through `_inFlight`. `_rowTurn` drops an entry whose session is gone or no longer `idle`; its pending note stays.

**The row turn** runs on the wake session (`summaryModel`) with `Chief of Staff row (eve cos v1)`: per session `{sessionId, label, project, excerpt}` in one `<agent_data>` region, a reply of `{"rows":[{sessionId, line}]}` with each line at most 160 characters, parsed by `parseRow`. A session the reply leaves out, a reply that cannot be parsed, a turn that fails, and a day past either cap all end in the template line. The model runs only when the global daily limit is not reached and `rowCalls` is under the rail cap. `rowCalls` counts every row turn that reached the model (not `off` or `limit`) and is saved in `chief-of-staff-state.json`. eve.log gets `Chief of Staff row summary: session <first 8 of id> source <model|template>`, and once per local day `Chief of Staff row summaries reached today's cap of <n> model calls; rows show last words until tomorrow`. Neither line carries note or excerpt text.

**Template line (`templateRow`).** The excerpt on one line; when longer than 160 characters, its last 160 from the first word break, prefixed `…`; `It finished without a reply.` when empty.

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

The person model can start an agent and send to one through the `eve-cos` MCP (`mcp/cos.js`): seven tools: `cos_list_sessions`, `cos_session_status`, `cos_list_agents` (reads) and `cos_propose_start`, `cos_propose_send`, `cos_propose_agent`, `cos_propose_chat` (propose). The MCP only calls eve's loopback `/internal/cos`; eve decides.

**A call is tied to a real tool call.** eve records every `tool_use` the person model makes (`ChiefOfStaffModel`'s `onToolUse`, fired when a tool_use block stops) in a `CosTurn` for the length of the person turn. `/internal/cos` checks the loopback peer and the secret, that `meta.project_id` (vouched by relay) is the person model's project, that a person turn is in flight, and then waits for an unclaimed `tool_use` with the same name and the same input (sorted-key JSON). `claim()` resolves when that call is recorded and rejects when the turn settles, so a call that the model never made, or made in an earlier turn, is refused as `unverified_call`. eve.log gets one info line per tool call with the turn id and tool name; the input is never logged, because it can quote agent data.

**Provenance decides act or card** (`chief-of-staff-provenance.js`, pure):
- If the person model session has read nothing, eve acts at once (`no_read`). Any tool except the propose tools counts as a read, and the mark lasts the life of that model session.
- After a read, eve acts at once only when the prompt or text is a verbatim span of the person's message (whitespace collapsed, case-sensitive) and the message names the project (start) or the session label (send), case-insensitively.
- Otherwise eve posts a `start_card` or `send_card` and does nothing until the person taps Start. Edits made on the card are the person's own words, so a tap needs no provenance check.

**Start goes through relay's scoped route only** (`POST /api/chief-of-staff/sessions`), never an unscoped create, so the session carries `origin: 'chief-of-staff'` and relay audits it. eve then refreshes the roster, so a headless start joins it and alerts for it post as usual. A terminal start shows in relay's session list and in the `started` post, not in the roster. A project on an SSH host starts headless only (relay refuses a terminal there with `terminal_on_host`, which posts `start_failed`). A relay refusal posts `start_failed` (or `send_failed`) and the tool answers `relay_<code>`.

**Cards** persist with the posts. Only a `pending` card takes an action, and its state leaves `pending` before anything is awaited, so one tap acts once. `cos_post_update` replaces the post in every browser. A card never expires; `failed` is final.

## Agents (eve#407)

A project can have named agents: entries of a type, a name, a kind (claude, codex or pi), an optional model and an optional command. Relay owns them (`projects[].agents`); eve lists them, offers to add one, and starts one by name.

**List.** `cos_list_agents` is a read. It asks relay's scoped list and passes the rows through as relay typed them, filtered to the row types in `LIST_ROW_TYPES` (`agent` and `chat`). The model uses it when the person asks what a project has, or names an agent it cannot match.

**Add is always a card.** `cos_propose_agent` has relay check the entry first (the scoped preview: relay validates the name and kind, finds the command and says which machine runs it; it writes nothing and raises no prompt), then posts an `agent_card`. It never goes through `provenance.decide`. There is no act-at-once path because adding an agent changes what can run on the person's machine: relay gates the write with a presence prompt at the Mac, and eve must not call it on text the model made up. Provenance asks whether the words are the person's. Here the words are a name and a command, and the person's tap on the card is what relay needs to see. The tap calls the unscoped `POST /api/projects/{id}/agents`, and eve sets no timer, because the person may take a while to reach the Mac. The card reads "Approve on the Mac" meanwhile. The state leaves `pending` before the call, so one tap acts once. The card has Add and Cancel and no fields; an edit sent for it is refused ("An add card takes no edits").

**The command is a name only.** The model may send a bare program name such as `mywrapper`, matching `^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,63}$`. A path, an argument or a command line is refused (`invalid_args`), and so is any other field (`args` included). Absolute paths and arguments are set in relay's Settings or its CLI (`relay project agents add`), where the person types them. The prompt tells the model never to put one in `command` and never to ask the person for one. A program that is none of the three kinds is a claude launcher, so the model sends kind `claude`.

**Errors.** A relay refusal on the list, the preview, the add or the start is `{error, message}`. eve keeps `error` as the code when it is lowercase letters and underscores, else `http_<status>`, and answers `502 relay_<code>` with relay's `message` (or `Relay refused the <list|preview|add|start> (<code>).`). A call that throws is `unreachable`. A failed preview posts no card. A failed add leaves the card `failed` with relay's message; presence refused or timed out is such a refusal. A project removed before the tap fails the card with "That project is no longer available".

**Start by entry.** `cos_propose_start` takes `entry` (a name) or `model`, never both. An agent by name starts headless: `mode: 'terminal'` with an entry is refused. eve sends relay exactly one of `entry` and `model`; when the tool sends neither, eve fills the default model as before. A start card for an entry shows Prompt, Folder and a read-only Agent row; Edit changes only the prompt and the folder. An unknown name is relay's refusal, which lists the project's agents.

## Chats (eve#408)

A project also stores chat templates (name, model, mode, voice, system prompt). Relay owns them (`projects[].chat_templates`) and eve's project dialog edits them. The Chief of Staff lists them, adds one from a sentence, and starts one by name.

**List.** `cos_list_agents` returns agents and chats as one list; each row is typed `agent` or `chat`. The prompt tells the model to name both when the person asks "which agents".

**Start by name.** A chat starts like an agent: `cos_propose_start` with `entry` set to its name and no model. Relay resolves the name and builds a chat start (as `applyChatDefaults` does for the web); eve sends only `entry`. The Start card cannot tell the type before relay answers, so it shows the name under "Agent". The `entry` limit is 60 characters, since it may name a chat. A duplicate chat name is relay's `entry_ambiguous`.

**Add is always a card.** `cos_propose_chat {project, name, model}` posts a `chat_card` with Name and Model rows, Add and Cancel, no fields. It never goes through `provenance.decide`, for the reason agents do not: relay gates the write with a presence prompt at the Mac. The tap calls the unscoped `POST /api/projects/{id}/chat-templates` with no timer, and the card reads "Approve on the Mac" meanwhile. The model asks for a model when the person gave none; it never guesses one. eve checks only the model's shape (at most 200 bytes, no whitespace or control characters); a wrong model costs one failed start.

**Why eve checks the name first.** Relay has no scoped preview for a chat, so nothing else would refuse a taken name before the person is asked to approve. eve lists the project's rows and compares the name with every row of any type, case-insensitively. A clash answers 409 `name_taken` (`"<name>" is already a chat template in <project>` or `"<name>" is already an agent in <project>`) and posts no card. Relay checks the name again at the tap, so a race ends as a failed card.

**The list fails closed.** If relay's list fails, eve answers 502 `relay_<code>` and posts no card, rather than offer an add it cannot check.

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
- **D15** Row notes never post. At the global daily limit they use the template line with no thread notice.
- **D16** The rail spends at most half of the day's model calls (`max(1, floor(dailyModelCalls / 2))`), counted as `rowCalls`. Past that, rows show the agent's last words. This keeps the rest of the budget for alerts and the person.
- **D17** Notes are memory only. An eve restart leaves line 3 empty until each agent's next turn.
- **D18** A turn that ends on a question shows the question on line 3 with no model call.

## Recalling a prompt (eve#419)

The composer walks the person's earlier prompts with Up and Down. History is the person posts in the snapshot, oldest first, so it survives a reload. The first Up saves the current text as the draft and steps one older; at the oldest it stays. Down steps newer, and past the newest restores the draft. A recalled prompt lands with the caret at its end. Any edit or Send ends recall, and the edited text becomes the new draft. Modified keys and IME composition are left alone. The caret rule is a line test: Up is taken only when no newline lies before the caret, Down only when none lies after it. The composer is a single-line `<input>` today, so the rule always holds; it is written as a line test so it stays right if the box becomes multi-line.

## Message time (eve#420)

Every post ends with one `<time class="cos-time">` built from the post's `at`; a post whose `at` does not parse gets none. The visible text is the time alone when `at` falls on the browser's local day at render, else date and time; it is `aria-hidden`, and a `.cos-sr` span carries the full date and time for screen readers. A person post is a wrapper (`cos-post-<id>`) holding the bubble and the time, so the bubble text stays exactly the person's. Alert and finished posts no longer carry a clock in their meta line, which keeps only the project. Under 600px the time is hidden. "Today" is not re-evaluated after midnight until the next render.

## Agent rail (eve#274)

The thread has an agent rail: every agent session and terminal as a row, beside the thread. `public/cos-agent-rail.js` (`CosAgentRail`) is not a board. It hosts two mounts of the shared `AgentBoard` (layout `rail`, `filter: () => true`, no row cap, Done collapsed): prefix `rail`, always mounted, and prefix `sheet`, mounted while the phone sheet is open.

- **Wide (over 900px).** `.cos-page` is a grid: `.cos-thread` (the existing top, feed and composer), a divider (`cos-rail-divider`) and `nav.cos-rail` (own scroll) on the right (eve#321). Every existing testid stays.
- **Resizing (eve#321).** The rail's width is `--cos-rail-w` on `.cos-page`, 280px by default, 220 to 480px, and never so wide that the thread drops under 360px (`CosAgentRail.size`, pure). The 6px divider counts toward the thread's room (`DIVIDER_PX`, kept in step with the CSS `366px`). When the window or the sidebar narrows, a `ResizeObserver` re-clamps the shown width and its aria values; the saved width stays until the next resize by hand. The divider is a `role="separator"` with `aria-valuenow`; a pointer drag sets the width live, ←/→ step 16px, Home/End jump to the ends, a double-click resets to 280px. A drag under 160px, or Enter, folds the rail: `data-rail-folded` on the page hides the rail, the divider stays at the right edge, and the strip shows as on a phone. On wide the strip, Enter and "M need you" unfold it at the width the folding drag started from; dragging the folded divider back out measures from the right edge and unfolds it once past 160px. Width and fold are stored as `{width, folded}` in `localStorage` `eve-cos-rail` (no TTL, read and written in try/catch). At 900px and under the divider is hidden and the strip opens the sheet, folded or not.
- **Narrow (900px and under).** The rail is hidden. A 44px strip (`cos-agents-strip`) sits between the feed and the composer, with red, amber and green counts read from the rail board's `onCounts`. A `null` count (relay unreachable or list loading) shows no counts. The strip opens a native `<dialog>` sheet, about 75% of the height. It closes by its button, Escape, a click outside the panel, or a pointer drag of 64px or more on the handle or header. Tab wraps inside it. Focus goes back to the strip, except after a row tap, which closes the sheet and opens the agent.
- **Line 3.** The page keeps `rowNotes` (a Map capped at 200), replaced by each `cos_snapshot` and updated by each `cos_row_note`; the board reads it through `note(id)`. Notes are agent-derived and reach the DOM through `textContent` only.
- **The subline.** "M need you" is a button (`cos-need-you`) that calls `showNeeds()`. Its count is the server roster's, sessions only, so it can differ from the rail's Needs you, which also counts terminals that exited non-zero.
- **Chief of Staff off.** The rail still lists every row, with no notes.

## Outside work

`ChiefOfStaffOutside` is a separate scoped RelayTransport reader. ChiefOfStaff
owns its startup and shutdown; it starts even when the model is disabled.
The existing rail-off behavior stays intact. It replaces full snapshots,
ignores older revisions within a connection and reseeds after reconnect.
Lists return copies, and status tools read latest-turn detail at request time.
An older Relay with no inventory route contributes no outside tool rows. Any
other outside read failure returns the managed rows with `outsideUnavailable:
true`, never an error for the whole list.

Relay also lists sessions that ended in its window (`state:"ended"`, `endedAt`;
relay `settings.json` `outside_sessions.ended_window_days`, 0 turns them off).
Eve keeps their last turn for the browser only: after each accepted snapshot one
sequential pass reads relay's detail for each ended row not yet cached for its
`endedAt` and stores `lastExcerpt` (500 characters). `getSnapshot()` and `list()`
stay metadata only, so the model's `cos_list_sessions` never sees it; the
browser frames use `browserSnapshot()`. A failed read stores nothing and the next
snapshot retries. Ended rows count in neither `watching` nor `needYou`. The model
reads an ended session by finding its row and calling `cos_session_status`.

Outside rows stay read-only: eve never writes to, signals or takes over the original process. An ended row in a console project offers Resume, which starts a new managed `claude-code` terminal in the row's folder with `--resume <conversation id>` (`ChiefOfStaffOutside#resume`, `POST /api/outside-sessions/:id/resume`). Relay serves that id (`claudeSessionId`) on ended rows only; eve keeps it in a private map, strips it from every row, frame and tool result, and the browser sends only the row id. Eve checks the row (in the list, ended, in a console project, a UUID id, not already in flight) and makes one `POST /api/terminals` through the same door as `terminal_create`, so relay's sandbox and project rules apply unchanged.

ChiefOfStaffPage keeps a private outside Map and passes it only to its rail
and phone-sheet boards. Today, projects, managed attention, StateStore, errands
and wake summaries retain their existing membership. Viewer terminals are
excluded from boards to avoid counting an outside session twice. Rows show
Outside, machine, folder, branch and Working, Waiting on you, or Idle. Asking
rows contribute once to both the rail counts and server need-you count.
A row's line reads Read-only thread, or Thread unavailable: Host is unreachable
when its machine's status is unreachable; a row on an unreachable machine opens
nothing.

A row click opens the session's thread (eve#444): one tab per session, global,
not persisted, `#outside/<id>`. `ChiefOfStaffPage` gives each rail row its
`machineStatus` from `outsideMachines` by `hostId` and an `openOutsideThread`
that `AgentBoard#_open` calls. `OutsideThreadPage` (feature `outsideThread`)
reads relay's transcript through eve's `GET /api/outside-sessions/:id/transcript`:
the newest 50 entries first, 50 more older per press of Load older (an empty page
with more behind it steps on, at most four times per press). Entries are `You`,
`Claude` and `Tool`, oldest at the top. The tab polls on the `probeIntervalMs` of
the latest `cos_outside_sessions` frame (15 s by default, clamped to 5 to 60 s),
only while it is the shown tab and the page is visible, asking for the newest 200
and appending what follows the last known entry (else it replaces the list). A
`cos_outside_sessions` frame that lacks the session, or a 404, closes the tab with
the notice "<name> left the Agents list, so its thread closed."; a `cos_snapshot`
never does, because an eve restart can send an empty first list. A failed read
keeps the entries, says "Could not read this thread. Eve tries again at the next
check." and keeps polling. The tab has no input, send or stop control.

A tmux-viewable row also has a sibling button View read-only (like Drop in), which
opens the tmux viewer below. Viewer creation uses the browser's
ordinary authenticated proxy and Relay's fresh attach enforcement, never the
CoS scoped action route. The viewer keeps readOnly/outside across list,
creation, join and reconnect. Its visible badge and suppressed input, resize,
paste, drop and keybar distinguish it from a managed terminal. Close detaches
only the viewer. Terminal tabs retain their existing unpersisted policy;
opening a resident terminal by ID uses its fresh list metadata.

**The promise.** Eve never sends input, kill or start requests to an outside
session; outside sessions are read-only. Outside metadata and latest-turn
replies are untrusted, hostile display data. All row
text uses textContent. Status text stays out of snapshots, row notes,
notifications and logs. The existing real tool-use claim and provenance read
mark still apply; an outside read grants no message or action authority.
Reserved outside IDs are refused at proposal, card tap, direct send, Drop in,
and managed browser opening, even after inventory removal.

The thread is browser-only. The Chief of Staff gets no transcript tool and no new
prompt text: `mcp/cos.js`, `chief-of-staff-outside.js` and
`chief-of-staff-prompt.js` are unchanged, so the model still reads only the latest
turn. Claude text in the thread goes through the shared Markdown renderer
(`MessageRenderer.markdownToHtml`, `rawHtml: false`): raw HTML in the text stays
literal, and links and images stay sanitised as in the main chat. You and tool
text stay `textContent`: a tool call shows its name and a short summary with its
input folded, and a tool result past 400 characters or 8 lines is folded. Eve folds by relay's `kind` and uses `name` as the label, and guesses by text shape only for an entry with no `kind`.

**Adopt (eve#597).** A live outside row relay marks `adoptable` and not on a host offers a button on the Agents board: `Adopt` when idle, `Interrupt and adopt` when working. The browser sends only the row id and `interrupt` to `POST /api/outside-sessions/:id/adopt`. Eve makes one call to relay's `POST /api/sessions/adopt` as itself, with no chief-of-staff scope: relay refuses that scope at this door, and the Chief of Staff gets no adopt action or tool (its outside actions still refuse `outside_session_read_only`). Relay judges the row, the project, idleness and the launch; eve adds no filter and shows the button only on `adoptable === true`. A row relay marks not adoptable shows relay's reason as one line. The conversation id relay returns is dropped at the route. After adopt, relay lists a managed headless session and the board shows it with Drop in. Interrupt and adopt makes relay send one message with origin `relay-recovery`, shown with the chip `Sent by relay after it took over`. A Claude in no project is adoptable too: relay marks it `adoptable` the same way, runs it with no sandbox and no project policy, and lists the managed session with `unsandboxed: true`. The board then shows the chip `Unsandboxed` (description "Runs with no sandbox and no project policy.") in the row head after the title, on the session row and on its drop-in terminal row, through reload, drop in and hand back. `AgentBoard.isUnsandboxed` is the one rule: `=== true` on a session or terminal item. A Pi or Codex row in no project keeps `Not in a project, so it can't be adopted.` and no button.

Relay independently probes healthy machines every 15 seconds, drains optional
native hook reports within two seconds, and emits full changed snapshots.
Eve immediately fans them out: end-to-end promises remain hook state <=5s,
hookless state <=15s, confirmed exit/unreachable expiry <=60s. No hooks are
required on SSH hosts. Optional reports improve fidelity, never authority.
See Relay's outside-sessions and SSH-host docs for opt-in configuration.

## Acting while you're away

Design for eve#507; the first part is the card (eve#508), the second is acting under it (eve#509). The person types an instruction such as "I'm AFK, continue until ready to merge to main". The person model calls `cos_propose_delegation`, which always posts a `delegation_card` and acts on nothing. The card shows the owner's words, one line per rule, the issues the owner approves, the bounds and a fixed never line. The owner taps Approve, Cancel, or later Stop on the bar.

**Rules.** `continue` keeps 1 to 10 managed sessions going with a fixed text that eve builds (`continueText`, never a model). `reply` sends a fixed text to one session when its turn ends on a question or otherwise, with an optional condition in the owner's words. Bounds: a window of 1 to 24 hours (default 8), at most 1 to 100 messages to each listed session (default 50), and 0 to 5 full verify runs (default 2; an instruction in the text, not counted). `chiefOfStaff.delegation` in `data/settings.json` (`windowHours`, `maxActions`, `verifyRuns`; read only) sets the defaults. A wrong type or range warns and uses the default.

**The card is the authority.** `validateProposal` resolves each session in a fresh roster and stores its label and project name on the card. An outside id answers 403 `outside_session_read_only`, an unknown id 404, the Chief of Staff's own session 403 `own_session`, a second continue rule or a bad issue reference 400. A hostile excerpt cannot add a rule, session or issue, or widen a bound: nothing after the card is built reads agent text into it. Never delegated, with no code path: credentials, merges to main, publishing outside the owner's repos, deleting, CI workflows, guards and merge-check, tool approvals, and anything not on the card.

**Approve, Cancel, Stop.** Approve needs `pending`: the state leaves `pending` before the roster is read again, so one tap acts once. A session gone by then fails the whole card with "<label> is gone. Type the instruction again." and nothing becomes active. Approving ends any active delegation with `replaced`: one is active at a time. Stop needs `active`. A delegation card takes no edits; a different instruction is a new card.

**State.** `data/chief-of-staff-delegation.json` (0600, tmp and rename, removed when the delegation ends) is `{v: 1, delegationId, postId, instruction, approvedAt, until, maxActions, verifyRuns, rules, actions, sessions, log}`: the card's rules, the total `actions`, for each session any rule names `{ready, report, waiting, actions}`, and at most 100 `log` entries. A file without `v: 1` is ignored. It survives an eve restart. The window is a timer to `until` (`unref`'d) and a check at start: a window that ended while eve was down ends the card with "time is up". `getStatus().delegation` is null or `{delegationId, postId, until, actions, maxActions}` and drives the bar "Acting for you until HH:MM · n sent · up to max per agent".

**Acting under the card (eve#509).** For a listed session, a `turn_done` followed by `session_state` `idle` is one turn end, evaluated once. `asking`, `errored` and `stalled` record the waiting reason (`tool_approval`, `errored`, `stalled`) and send nothing; `session_ended` records `ended`. The latest reason for a session wins, and a session that moves on clears it. `decideTurnEnd` decides in this order: the ready line (the last non-empty line is `READY-FOR-OWNER`: no send, the session is ready and its report is the excerpt); the session's cap (`sessions[id].actions >= maxActions`: no send, waiting `cap`); the first reply rule of that session whose trigger fits and whose condition is null; the keep-going rule when the session is on it; else nothing. A reply rule with a condition waits for the model's match (below).

Before each send eve checks that the session is under its cap, the window is open, the session is in the roster and no send to it is in flight; one send per session runs at a time, so two turn ends cannot pass the cap or send twice, and a turn end after the delegation ended does nothing. `_send` takes `{delegation: {delegationId, rule}}`: the `sent` post carries it (rule is the 0-based rule index), no model wrote it (`byModel` false), and no errand is armed, so no "finished" post follows the turn. A refused send posts `send_failed` as before, records waiting `send_failed` with the line, and does not count. An accepted send adds 1 to the session's and the total `actions`, appends a `log` entry (at most 100), saves the state file and sends `cos_status`.

The delegation ends when each keep-going session is ready, ended or at its cap: with `cap` ("message limit reached") when any is at its cap, else with `done` ("all done"). A card with no keep-going rule ends with `cap` when every listed session is at its cap or ended; otherwise only by the window or Stop. Every end posts exactly one `delegation_digest` before the state file goes: `{delegationId, from, to, endReason, sent, actions, waiting, ready}` built by `buildDigest` from the state file; `sent` is the total count, `actions` the last 100. A send relay accepted after the delegation ended still shows its chip and relay's audit row, but not in the digest. A session at its cap that is not ready waits with reason `cap`; a keep-going session that is neither ready nor waiting waits with `not_ready`. The page shows "Sent for you · rule <n>" on a delegated `sent` post, and the digest as "While you were away", the line "<HH:MM> to <HH:MM> · <n> sent · ended: <reason>" and the groups "Done for you", "Waits for you" and "Ready". Agent text goes in as text only. 

**A reply rule with a condition (eve#510).** `when` is the owner's words. For a turn end that no unconditional rule decides, `conditionalCandidates` lists the session's reply rules whose trigger fits and that have a `when`. With candidates, and the session under its cap and not ready, the turn end waits in `_delegateWaiting` (one entry per session, a newer turn end replaces it, at most 50) instead of deciding. The pump runs person turns, then alerts, then the delegate batch (at most 10, oldest first, no quiet window), then finished posts and rows. One match turn covers the batch, on the wake session with `summaryModel`; the model counts it as one call against the daily limit like every other turn. `delegateMatchPrompt` puts the agents' excerpts in one `<agent_data>` region and the rules, the owner's words, outside it, quoted; the model answers `{"matches":[{"sessionId","rule":<index>|null}]}` and writes nothing to send. After the await eve re-reads the delegation, the cap, the window and the roster, and sends through the same path as any delegated send, with its in-flight hold, so the cap and the no-double-send rules hold. `acceptMatch` takes a match only when it names a reply rule of that session, with that trigger and a `when`; the card's own text goes, never the model's.

Off, the daily limit, a failed turn and a reply eve cannot parse are all "no match". With no accepted match, `decideTurnEnd` falls to the keep-going rule when the session is on it. Otherwise nothing is sent: eve posts the notice "No rule covers <label>'s last turn; it waits for you." and records waiting `unmatched`, which the digest shows as "no rule matched". A session at its cap gets no match turn and costs no call.

## Clearing the thread (eve#512)

Typing `/clear` (trimmed, case-insensitive, nothing else) in the thread resets it. Any other text, `/clear now` included, is an ordinary message. The command rides the existing `cos_message` frame; eve handles it in `submitPerson`, queues a clear job in the person queue so it runs between turns, and sends every subscriber a fresh `cos_snapshot` once it is done. The client already replaces its thread on that frame.

The job, in order: refuse while a delegation is active; split the posts into kept cards and the rest; append the rest to the archive; `reset()` both model sessions (DELETE on relay); write the kept posts; send the snapshot. It makes no model call and sends nothing to an agent. It leaves the day's call count, row notes, roster, errands and the wake, finished, row and delegate queues alone, so work queued before the clear posts into the new thread on a fresh wake session. It adds no person post and no confirmation post.

Decisions made for the owner:

1. The archive is `data/chief-of-staff-archive.jsonl`: append only, mode 0600, one line per post, `{"v":1,"clearedAt":ISO,"post":<as stored>}`. Eve never reads, rewrites or rotates it, and it has no screen door. Each clear adds at most 200 lines.
2. If the archive write fails, the clear stops with a notice and the thread and sessions stay. A clear never loses posts.
3. Kept cards are `pending`, `approving`, `starting`, `sending` and `adding`, so a tap's result lands on a visible card. Alerts are archived; the rail still shows who needs you.
4. No confirmation post: the empty-thread line confirms. Prompt recall (Up) loses the archived prompts.
5. `/clear` works while the model is off or at its daily limit, because it needs no model.
6. A failed DELETE is logged and not retried; eve never uses that session again.

## Decisions made for the owner

Outside inventory remains available when model calls are off. Legacy Relay
404 on the list means no outside capability, preserving managed read tools.
Status failures never return stale latest-turn text. Terminal tabs stay
unpersisted; viewer flags survive list, join and reconnect only (eve#432).
