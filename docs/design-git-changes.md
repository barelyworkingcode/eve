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
  the default branch — the "what does this branch change" view). With no
  default branch or no merge-base it falls back to the uncommitted list and
  reports `base: null`.
- **Header ⟳** forces a refresh; the list otherwise refreshes on file-watch
  events (debounced).
- Remote projects reuse the existing `panelHostBar` connection state; while
  the host is `unreachable` the tab shows the last list greyed out.

## Opening a file: the diff pane

Clicking a row opens a document-area pane keyed
`diff:<projectId>:<repo>:<path>`
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
  delta (image before/after is out of scope for v1).
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

Exact shapes are in **Contract** below.

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
- Every call runs with `-c core.fsmonitor=false`, so a repo's own config
  can't make a status poll spawn a hook command. Both runners also drop
  inherited `GIT_*` env vars that would redirect git elsewhere.
- `git_changes` is registered `expensive`, so it shares the WS rate limit.

### Refresh

Piggy-back on the existing `watch` stream. Any change event under a repo
schedules a debounced (500 ms) `gitStatus` for that repo only. Events inside
`.git/` are ignored except `index`, `HEAD`, `ORIG_HEAD` and `MERGE_HEAD`,
which cover commits, staging, branch switches and merges. Remote watch events
pass through the same ignore filter as local ones, so `.git` and
`node_modules` churn never triggers a tree refresh.

## Contract (pinned — every task builds against this)

### Server: `GitService` (`git-service.js`)

One implementation for local and remote. Discovery, porcelain parsing,
merge-base, and binary detection live here once; only the runner differs.

```js
new GitService({
  // Run git. cwdRel is root-relative ('/' = root). Resolves, never rejects on
  // non-zero exit. stdout is a Buffer. Enforces timeout + maxBytes and
  // rejects with GitError('TIMEOUT'|'TOO_LARGE'|'GIT_MISSING').
  run: (root, cwdRel, args, { maxBytes }) => Promise<{ code, stdout: Buffer, stderr: string }>,
  // Existing FileService/RemoteFileService.listDirectory (showHidden: true).
  listDirectory: (root, rel, opts) => Promise<[{ name, type }]>,
  // readFile -> { content, size }, minus the extension allowlist and capped
  // at 2 MB (GitError('TOO_LARGE') with .size). Local: FileService
  // #_readFileForGit; remote: the agent's `read` with maxBytes, plus a
  // `stat` for the size on overflow.
  readFile: (root, rel) => Promise<{ content, size }>,
})
```

`GitError extends Error` with `.code` in
`NOT_A_REPO | GIT_MISSING | TOO_LARGE | TIMEOUT | FAILED`.

Methods (also exposed 1:1 on `FileService` and `RemoteFileService` as
`gitRepos` / `gitStatus` / `gitFileVersions`, each taking `projectPath` first):

- `repos(projectPath)` →
  `[{ path, name, branch, head, detached, upstream, ahead, behind, defaultBranch }]`
  - `path` is root-relative with a leading slash (`'/'` for the root repo,
    `'/feat-login'` for a child). `name` is the folder basename.
  - `branch`/`upstream`/`defaultBranch` are `null` when unknown.
    `defaultBranch` is `origin/HEAD`'s target (e.g. `origin/main`) when
    set, else local `main`, else `master`;
    `head` is the 7-char short SHA; `ahead`/`behind` are `0` without upstream.
- `status(projectPath, repoPath, scope)` — `scope` is `'uncommitted' | 'base'` →
  `{ repo, scope, base, files: [{ path, status, oldPath?, staged }], truncated }`
  - `path`/`oldPath` are repo-relative, no leading slash.
  - `status` ∈ `M A D R U ?` (copies fold into `A`, type changes into `M`).
  - `base` is the merge-base short SHA for `'base'`, else `null`. A `'base'`
    request with no default branch or merge-base returns the uncommitted
    list with `base: null`.
  - `truncated` is true when the file list was capped (5 000 entries).
- `fileVersions(projectPath, repoPath, filePath, scope)` →
  `{ original, modified, binary, tooLarge, originalSize, modifiedSize }`
  - `original`: text at `HEAD` (uncommitted) or merge-base (base); `null` when
    the file didn't exist there. `modified`: working-tree text, `null` when
    deleted. Both `null` when `binary` or `tooLarge`.

### Remote agent op

`remote-fs-agent.js` gains one op, `git`:
`{ op: 'git', root, cwd, args, maxBytes }` → `{ ok, code, stdout (base64), stderr }`.
`cwd` is confined to `root` with the agent's existing `resolveInRoot`; a
missing or non-directory `cwd` fails with `NO_DIR`, which
`RemoteFileService` maps to `NOT_A_REPO` (matching the local runner). Eve
already holds full read/write authority over the agent, so a generic git op
grants nothing new; the browser never supplies `args`.
`RemoteFileService` wraps it as the `run` for its `GitService`.

### WebSocket frames (`ws/git-messages.js`)

| direction | frame |
|---|---|
| → server | `{ type: 'git_changes', projectId, scope, repo? }` |
| ← client | `{ type: 'git_changes', projectId, scope, repo?, repos: [{ ...repoMeta, files, base, truncated, error? }] }` — one entry per repo, or just `repo` when given; `repo` is echoed only on a single-repo reply, so a reply without it is the full list |
| → server | `{ type: 'git_file_versions', projectId, repo, path, scope }` |
| ← client | `{ type: 'git_file_versions', projectId, repo, path, scope, original, modified, binary, tooLarge, originalSize, modifiedSize }` |
| ← client | `{ type: 'git_error', projectId, repo?, path?, code, error }` |
| ← client (push) | `{ type: 'git_changed', projectId, repo }` — from the file watcher |

`git_error.code` is a `GitError` code, or `INVALID` (bad scope/repo/path)
or `NOT_FOUND` (unknown project). A per-repo failure inside `git_changes`
sets that repo's `error: { code, message }` rather than failing the whole
frame.

### Client bus events

`message-dispatcher.js` re-emits each inbound frame on the EventBus:
`git:changes`, `git:file-versions`, `git:error`, `git:changed` (payload = the
frame). The sidebar emits `git:open-diff` with
`{ projectId, repo, repoName, branch, path, oldPath, status, scope }`; the diff
pane listens for it. The names are `EVT.GIT_CHANGES`, `GIT_FILE_VERSIONS`,
`GIT_ERROR`, `GIT_CHANGED` and `GIT_OPEN_DIFF` (`public/core/constants.js`).

## Out of scope for v1

Staging, committing, discarding, or any other write operation; blame;
history browsing; nested repos deeper than one level.
