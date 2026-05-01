# Test Index

Quick-reference index of all test cases. Run `npm test` for unit tests.

## Unit Tests (`test/unit/`)

### `file-service.test.js` -- File browser service

**validatePath**
- resolves a simple relative path
- strips leading slashes from relative path
- strips multiple leading slashes
- resolves empty path to project root
- blocks path traversal with ../
- blocks path traversal with nested ../
- allows ../ that stays within project

**isAllowedFile**
- allows common text extensions
- allows config file extensions
- allows extensionless files
- rejects binary/disallowed extensions
- is case insensitive for extensions
- allows .gitignore extension
- allows .env extension
- allows lock files
- allows log files

**readFile**
- reads an allowed file
- throws for nonexistent file
- throws for disallowed file extension
- throws for directory path
- blocks path traversal

**writeFile**
- writes content to a new file
- overwrites existing file
- throws for disallowed file extension
- throws when parent directory does not exist

**listDirectory**
- lists files and directories
- sorts directories before files
- hides dotfiles
- throws for nonexistent directory
- returns type and size for files

**renameFile**
- renames a file
- rejects names with path separators
- rejects disallowed extension for files
- throws when target already exists
- throws for nonexistent source

**moveFile**
- moves a file to a subdirectory
- throws when destination is not a directory
- throws when file already exists at destination
- prevents moving directory into itself

**createDirectory**
- creates a new directory
- throws when directory already exists
- throws when parent does not exist
- rejects names with path separators

### `file-watcher.test.js` -- File watcher service

**watch/unwatch**
- creates a watcher for a valid file
- does not duplicate watchers for the same file
- ignores unknown project IDs
- ignores invalid paths
- removes watcher on unwatch
- unwatch is safe for unwatched files

**markSelfWrite**
- adds path to selfWrites set
- auto-clears after 500ms

**_onFileChange**
- debounces and sends file_changed message
- skips self-written files
- coalesces multiple rapid events

**closeAll**
- closes all watchers and clears state
- is safe to call multiple times

### `input-history.test.js` -- Chat input history (up/down arrow recall)

**push**
- adds entries and persists to localStorage
- deduplicates consecutive duplicates
- drops empty and whitespace-only entries
- trims whitespace
- enforces cap by trimming oldest
- resets navigation state

**prev / next**
- prev walks oldest, returns null at start
- prev on empty history returns null
- next without prior prev returns null
- next walks back toward newest then restores draft
- prev snapshots draft only on first call

**reset**
- clears index and draft

**persistence**
- second instance loads first instance entries
- load tolerates corrupt JSON
- load tolerates missing entries field
- load filters non-string entries and applies cap
