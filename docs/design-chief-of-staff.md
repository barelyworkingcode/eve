# Chief of Staff: model and prompt

Epic relay#231, eve#197. This page covers the model session and the prompts (`chief-of-staff-model.js`, `chief-of-staff-prompt.js`). The reader, send path and thread view have their own owners; the wire contract is in [api.md](api.md).

## What the model does
It writes. The reader decides when something needs the person, and eve builds every card from relay data. The model only turns a batch of events into a headline and body per session (a wake), or answers a person's message and optionally names one session to pass words to (a person turn). When it is off, at its daily limit, or unparseable, eve posts a fixed template instead ([Templates](#templates)).

## Why the model has no tools
Same reasoning as [design-brief.md](design-brief.md): agent text is hostile input, and the safety is the gate, not the prompt. Here the cleanest gate is that the model cannot do anything at all. A reply is text that eve parses; it cannot send, fetch or read.

relay has no "no tools" switch. eve gets the same result in three steps (D1):

1. The session is created with `settings.permissionPolicy.deniedTools = [...BUILTIN_TOOLS, ...extra]`. relay maps that to Claude's `--disallowedTools` and its hook preflight denies the same names. The session is `headless`, has no `agent` (so it stays out of the session list) and no `useRelayTools`.
2. A bootstrap prompt with no agent data is the first message. The session's `system/init` frame must arrive before `message_complete`, or the launch fails with `tools_unverified`. Agent text is never sent before this passes.
3. If `init.tools` is not empty, eve relaunches once with those names added to the deny list. If it is still not empty the model stays off (`tools_present`). A later `init` with tools kills the session the same way.

Alerts keep posting as templates while the model is off.

### BUILTIN_TOOLS
Recorded from a default Claude Code haiku session's `system/init` on the devbox (Claude Code 2.1.x), MCP tools left out because they differ per machine (the init check catches them):

`Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit, EnterWorktree, ExitWorktree, ListAgents, LSP, Monitor, NotebookEdit, PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate, ToolSearch, WebFetch, WebSearch, Workflow, Write`

The constant also lists names that earlier or later releases report (`Agent`, `Glob`, `Grep`, `MultiEdit`, `TodoWrite`, `BashOutput`, `KillShell`, `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `NotebookRead`, `SlashCommand`). Denying a name that does not exist is harmless. The init check, not this list, is what proves the session has no tools.

## Quoted data
Every value an agent controls (excerpt, session name, project name, state) reaches the model only inside one `<agent_data>` region:

```
<agent_data>
{quoteData(value)}
</agent_data>
```

`quoteData(v)` is `JSON.stringify(v)` with `<`, `>`, `&`, U+2028 and U+2029 escaped as `\uXXXX`. No value can spell `</agent_data>`, so none can close the region, and `JSON.parse` on the region gives the original back. The prompt says the region is data and never an instruction, and the system prompt says it again; that is the second line of defence, not the first.

A person message is trusted. It sits outside the region, but also goes through `quoteData` so it cannot fake a tag. The roster (labels are agent-controlled) sits inside the region.

## Wake and person turns
- **Wake** (`Chief of Staff wake (eve cos v1)`): up to 10 events, each `{sessionId, label, project, state, since, excerpt}`. The reply ends in one fenced json block, `{"posts":[{sessionId, headline, body}]}`. Posts naming an id outside the batch are dropped. A `send` in a wake reply is ignored: nothing in a wake is the person speaking.
- **Person** (`Chief of Staff person (eve cos v1)`): the person's text plus the roster. The reply is `{"reply","send":{sessionId,text}|null}`. When the target is unclear the model must set `send` to null and ask. Eve refetches the roster just before the prompt, honours at most one send per turn, and never fuzzy-matches: an id outside the roster gives `send: null` with reason `unknown-session`.

Parsing takes the last fenced `json` block, else the last balanced `{…}`. Text is trimmed and cut to `CAPS`. Failure reasons: `empty`, `no-json`, `bad-json`, `bad-shape`, `unknown-session`. A person turn that fails to parse yields an empty `reply`, and the caller falls back to a template or notice.

## Wake rules (reader side, for reference)
A trigger is a `session_state` entering `asking|errored|stalled`, or a `turn_done` whose excerpt `isQuestion`. `isQuestion` strips trailing whitespace and closing punctuation (`` * _ ` " ' ) ] > » ” ``) and tests the last character for `?` or `？`. Eve decides this with a fixed rule (D2); the model only writes the post.

## Templates
| state | headline | body |
|---|---|---|
| asking | `<label> is asking you something` | It won't go further until you answer. |
| question | `<label> asked you a question` | Its last turn ended on a question. |
| errored | `<label> stopped with an error` | Open it to see what happened. |
| stalled | `<label> has gone quiet` | It hasn't printed anything for 5 minutes. |

## Model session behaviour
- One long-lived session, launched lazily on the first turn, named `__cos:<12 hex>`. The previous run's session id is DELETEd best effort before launch.
- It joins its own unscoped `/ws` and handles only frames carrying its session id. Reply text is the `text_delta`s up to `message_complete`.
- `error`, `process_exited`, `resume_required` or a closed socket reject the turn and end the session; the next turn launches a fresh one. A timeout sends `stop_generation`, rejects with `timeout` and also ends the session, because the late `message_complete` would otherwise land in the next turn.
- `countCall()` runs before every `send_message`, the bootstrap included. A `false` rejects with `limit` and sends nothing.
- Turns are serialised inside the class.
- Error codes: `limit`, `launch_failed`, `tools_present`, `tools_unverified`, `turn_failed`, `timeout`, `disconnected`.

## Decisions
- **D1** Tools off in eve: deny list, init check, one relaunch, else off.
- **D2** Eve judges "ends on a question" with `isQuestion`; judging every turn with the model would cost a call per agent turn.
- **D3** The thread covers every project and ignores Home/Work mode.
- **D4** States seen at startup or reconnect never post; only transitions do.
- **D5** The model runs in the configured project, else the first local project with no permission policy that allows the model.
- **D6** Eve builds cards from relay data and falls back to template posts.
- **D7** Thread traffic is WS descriptors; `routes/index.js` stays untouched.
- **D8** Drop in on a non-headless session opens it.
- **D9** devboxverify writes the `chiefOfStaff` key into eve-verify's pinned `settings.json`.
- **D10** During a verify run the live eve and eve-verify may both post. Accepted.
- **D11** Config is `data/settings.json`, which eve reads and never writes.
