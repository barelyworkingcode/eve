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

## E2E Tests (`e2e/specs/`)

Playwright specs. Specs run sequentially -- later specs depend on state created by earlier ones.

### `01-project-creation.spec.ts` -- Initial setup and project creation

- welcome screen is visible on first load
- create E2E Claude Project
- create E2E LMStudio Project
- both projects visible in sidebar

### `02-session-creation.spec.ts` -- Session creation within projects

- create session in Claude project
- create session in LM Studio project

### `03-send-messages.spec.ts` -- Message sending and LLM responses

- send message in Claude session and get response
- send message in LM Studio session and get response

### `04-session-switching.spec.ts` -- Navigation between sessions

- switch between sessions via sidebar and tabs

### `05-session-renaming.spec.ts` -- Session rename and persistence

- rename Claude session
- rename LM Studio session
- renamed sessions persist after reload

### `06-shell-and-claude.spec.ts` -- Shell and CLI launch via slash commands

- launch shell via /zsh and interact
- launch Claude CLI via /claude

### `07-screen-redraw.spec.ts` -- UI stability under rapid switching

- rapid tab switching preserves content

### `08-shell-closing.spec.ts` -- Terminal tab lifecycle

- close shell terminal tab
- close Claude CLI terminal tab
- only session tabs remain after closing terminals

### `09-file-manager.spec.ts` -- File browser operations

- open file browser and upload file
- open file in editor
- modify and save file
- switch to split view and see preview

### `10-cleanup.spec.ts` -- Teardown and persistence verification

- delete Claude session
- delete LM Studio session
- delete Claude project
- delete LM Studio project
- verify cleanup persists after reload
