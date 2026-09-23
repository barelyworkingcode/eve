# Design: Changes panel (git status + diff viewer)

A sidebar tab that lists every file git considers modified, grouped by
repository — including each worktree under the project root — and opens any
file as a side-by-side diff, an inline diff, or the plain current file.

Tracking issue: see "Changes panel" user story on GitHub.

## The problem being solved

A common layout for agent work is one project root holding several git
worktrees, each checked out on its own branch:

```
project-root/
  main/            ← worktree on main
  feat-login/      ← worktree on feat/login
  fix-timeouts/    ← worktree on fix/timeouts
```

Today the Files tab shows the tree but not what changed. Finding "what did the
agent touch on which branch" means a terminal and `git status` per folder.
Remote (SSH host) projects make it worse: the files live on another machine.

## Sidebar: a fifth panel tab

`ProjectPanel` gains a **Changes** tab next to Files / Sessions / Tasks /
Modules. Its badge is the total count of changed files across all repos.

```
┌ project-name ─────────────────── ⟳ ┐
│ Files  Sessions  Tasks  Modules  Changes 12 │
├─────────────────────────────────────┤
│ Scope: [Uncommitted | vs base]      │
│                                     │
│ ▾ feat-login   ⎇ feat/login  ↑3  7  │
│    M  auth.js           routes/     │
│    M  login.css         public/     │
│    A  token-store.js                │
│    D  old-session.js                │
│    ?  notes.md                      │
│ ▾ fix-timeouts ⎇ fix/timeouts    5  │
│    M  relay-client.js               │
│    …                                │
│ ▸ main         ⎇ main         clean │
└─────────────────────────────────────┘
```

- **Repo group header**: folder name (relative to project root), branch chip,
  ahead/behind vs upstream when known, file count. Collapsible; collapse state
  persisted in `eve-changes-collapsed`. Clean repos sort last and start
  collapsed. Detached HEAD shows the short SHA in the chip.
- **File row**: status letter in a fixed-width colored column
  (`M` modified, `A` added, `D` deleted, `R` renamed, `U` conflicted,
  `?` untracked), file name, then the parent dir dimmed. Reuses
  `file-icons.js`. Renames show `old → new` on hover.
- **Scope toggle**: *Uncommitted* (working tree + index vs `HEAD`, the
  default) or *vs base* (everything on this branch since its merge-base with
  the default branch — the "what does this branch change" view).
- **Header ⟳** forces a refresh; the list otherwise refreshes on file-watch
  events (debounced).
- Remote projects reuse the existing `panelHostBar` connection state; while
  the host is `unreachable` the tab shows the last list greyed out.

## Opening a file: the diff pane

Clicking a row opens a document-area pane keyed `diff:<repo>:<path>`
(re-clicking focuses it). The pane header carries a segmented control:

```
┌ auth.js  feat-login · ⎇ feat/login ─ [Side by side | Inline | File] ┐
│ HEAD                         │ Working tree                          │
│  12  const t = read();       │  12  const t = await read();          │
│ ...                                                                   │
└───────────────────────────────────────────────────────────────────────┘
```

- **Side by side / Inline**: Monaco's `createDiffEditor` (already vendored
  under `/monaco/vs`), toggled via `renderSideBySide`. No new dependency.
- **File**: the current working-tree file in the normal file editor pane.
- Mode choice persists per browser (`eve-diff-mode`). Narrow viewports
  (< 768px) default to Inline.
- Added / untracked files diff against empty; deleted files diff to empty
  and disable **File**. Binary files show "Binary file changed" plus size
  delta; images reuse `image-viewer.js` for a before/after pair.
- The diff pane is read-only in v1. Edits go through **File**.

## Server side

### Discovery

For a project root, collect repos in this order, de-duplicated by top-level
path:

1. The root itself, if `git rev-parse --show-toplevel` succeeds inside it.
2. Each immediate child directory containing a `.git` entry (a file for a
   worktree, a directory for a clone).
3. `git worktree list --porcelain` from each repo found, keeping only
   worktrees whose path is inside the project root.

Depth is capped at 1 below root to keep discovery cheap on large trees.

### Operations

Same surface on `FileService` (local) and `RemoteFileService` (remote agent):

| op | input | output |
|---|---|---|
| `gitRepos` | — | `[{ path, branch, head, upstream, ahead, behind }]` |
| `gitStatus` | `repo`, `scope` | `[{ path, status, oldPath? }]` |
| `gitFileVersions` | `repo`, `path`, `scope` | `{ original, modified, binary, language }` |

`gitStatus` uses `git status --porcelain=v2 -z --untracked-files=all`
(uncommitted) or `git diff --name-status -z <merge-base>` (vs base).
`gitFileVersions` reads the original via `git show <ref>:<path>` and the
modified side from disk.

### Safety

- `execFile('git', argv)` only — never a shell string. Same on the remote
  agent (Node core `child_process`, keeping `remote-fs-agent.js`
  self-contained).
- `repo` and `path` are resolved and checked to lie inside the project root
  before any exec; `path` is passed after `--`.
- Refs are never taken from the client: the server derives `HEAD` or the
  merge-base itself.
- Timeout (10s) and output cap (8 MB for status, 2 MB per file side) on
  every exec; oversize returns a typed error the pane renders as
  "File too large to diff".
- `GIT_OPTIONAL_LOCKS=0` so a status poll never contends with an agent's
  running git command.

### Refresh

Piggy-back on the existing `watch` stream. Any change event under a repo
schedules a debounced (500 ms) `gitStatus` for that repo only. Events inside
`.git/` are ignored except `index` and `HEAD`, which cover commits, staging,
and branch switches.

## Out of scope for v1

Staging, committing, discarding, or any other write operation; blame;
history browsing; nested repos deeper than one level.
