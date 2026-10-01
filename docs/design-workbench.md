# S5a · Project workbench

Slice S5a of Epic #34 (T5). Intent: `design/homework/index.html`, mockup 09. Builds on S1 ([design-today-s1.md](design-today-s1.md)) and S2 ([design-today-s2.md](design-today-s2.md)).

## User story

As the owner, I would like one page per project with its threads, agents and tasks, every live terminal listed with its last line, and a way to ask about what I'm looking at, so I can see my agents and ask about their work without hunting.

## Acceptance criteria

**S5a-A1 · Project page.**
- One main-area tab per project, `#project/<id>`. Opening it again focuses the existing tab. It is not persisted, like `diff`.
- Doors: the panel header button `panel-project-page`, the deep link, and on compact the bottom bar's Threads (A5).
- It shows:
  - a header: the name, then where it lives ("this Mac", or the host chip with its status) and the path;
  - New thread (`project-new-thread-<id>`), which opens the existing launcher;
  - the sections Agents, Threads and Tasks, each with its count;
  - Files and Changes rows that open the sidebar panel on that tab, Changes with its count.
- An unknown id gives "Project not found." (`_hashRouteError`). S1-A4 applies unchanged: a mode switch never closes this tab.

**S5a-A2 · Panel trimmed.**
- The panel's tabs are Files and Changes. A stored `eve-active-tab` of `sessions` or `tasks` opens Files.
- Threads keep everything they had in the panel: folders, rename, move, delete, swipe, long-press. Tasks keep New Task, Run Now, Edit and open last run. All of it now lives on the page.
- A task run is never listed as a thread (S1-A6).

**S5a-A3 · Agent board.**
- Two places show it:
  - a Today part `agents` (order 55, both modes) for terminals in in-mode projects and terminals in no project;
  - the page's Agents section, for that project's terminals only.
- A row shows project (Today only), template label, state ("open", or "exited <code>"), and last line. Task-run terminals are excluded.
- Tapping a row attaches: it switches to the tab if one exists, else calls `openTaskTerminal`. Nothing opens by itself (S1-A2 unchanged).
- Before the first `terminal_list` the board shows loading. With relay down it shows "Can't reach relay" (S1-A3c). Empty reads "No agents running".
- Last line: the last line of output that is not empty and not only box-drawing, with escape sequences removed, at most 120 characters.
  - Source: the xterm buffer when this browser holds the terminal, else the tail of `GET /api/terminals/:id/log`.
  - Fetched when a row first appears and on `TERMINAL_LIST`, at most once per terminal per 15 s, for at most 20 rows. Never polled.
  - A 404 shows no line.

**S5a-A4 · Ask about this.** "Ask about this" appears on a file in the tree's context menu (not folders), in the diff pane toolbar (`diff-ask`), and on the search dialog's results (`search-dialog-ask`).
- It shows Today (on compact, the root), focuses Ask, and shows a removable chip (`today-ask-attachment`).
- For this ask, Ask's project is the item's project, overriding the mode default and the pick. The remembered pick is unchanged.
- Return creates one thread there and sends the typed text with the item as a text attachment. Removing the chip restores the normal rule.
- A second item replaces the first. The chip survives Today events until it is sent or removed.
- Not offered for host projects (Ask cannot start there), nor for a binary or too-large diff.
- An item over 256 KB gets no chip and the line "That's too large to attach (over 256 KB)."
- Content by kind:
  - file: its text;
  - diff: a unified diff of that file in the pane's scope, 3 lines of context;
  - search: the shown matches, at most 200, as `path:line: text`.

**S5a-A5 · Threads door.** On compact, the bottom bar's Threads opens the page of the active project, else of the first in-mode project. With none, it opens the sheet.

## What I'd notice

The panel has only Files and Changes, plus a Project page button. Today lists my terminals with their last line, and a tap opens one. "Ask about this" on a file, diff or search results takes me to Ask with it attached.

## Interfaces

No wire change. `user_input.files[]` already carries text: `{ name, content, type: 'text', mediaType: 'text/plain' }`.

```js
// panes/project-pane.js
panes.registerType({ type: 'project', create({ projectId }) → { id: `project:${projectId}`, type: 'project', projectId, label },
  view: () => 'project', hash: (tab) => `#project/${encodeURIComponent(tab.projectId)}` });   // no persist
panes.registerView({ view: 'project', elementId: 'projectPane', splittable: false, show(ref, ctx) });
// project-page.js:   class ProjectPage { constructor(container); show(projectId); render(); }
// agent-board.js:    class AgentBoard { constructor({ container, testidPrefix, showProject, filter }); mount(el); render(); destroy(); }
// core/terminal-text.js (pure): TerminalText.lastLine(raw, max = 120) → string
// core/unified-diff.js (pure):  UnifiedDiff.format(path, original, modified, lineChanges, context = 3) → string  // Monaco ILineChange[]
// today/ask-about.js: AskAbout.start(container, { projectId, attachment: { kind: 'file'|'diff'|'search', name, label, content } })
//   sets state.askAbout, calls tabManager.showToday(), emits EVT.ASK_ABOUT ('ask:about')
// app.sendUserText(sessionId, text, files = [])      // state.pendingAsk gains `files`
// api.getFileText(projectId, path)                    // existing eve route GET /api/files/:projectId/*
// terminalManager.lastLineOf(id) → string | null      // xterm buffer, open terminals only
