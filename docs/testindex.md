# Test Index

Quick-reference index of all test cases. Run `npm test` for unit/integration, see `e2e/` for Playwright.

## Unit Tests (`test/unit/`)

### `providers/llm-provider.test.js` — Base provider class

**sendEvent**
- sends normalized event via WebSocket
- does not send when ws is null
- does not send when ws is closed

**normalizeEvent**
- passes events through unchanged by default

**abstract methods**
- startProcess throws not implemented
- sendMessage throws not implemented
- handleEvent throws not implemented
- kill throws not implemented
- getMetadata throws not implemented
- static getModels throws not implemented

**session state defaults**
- getSessionState returns null by default
- restoreSessionState does not throw
- clearSessionState deletes providerState

**handleCommand**
- returns false by default

**getCommands**
- returns empty array by default

### `providers/claude-provider.test.js` — Claude CLI provider

**parseQuotedArgs**
- splits simple whitespace-separated args
- handles double-quoted strings
- handles single-quoted strings
- handles mixed quotes
- handles empty string
- handles extra whitespace
- handles quoted string with spaces inside
- handles single arg with no value

**removeCustomArg**
- removes a flag without value
- removes a flag with its value
- removes a flag with multiple values
- returns false when flag not found
- handles removing last flag
- removes flag at end of array with values

**formatArgsForDisplay**
- formats single flag
- formats flag with value
- formats multiple flags
- formats flag with multiple values
- handles empty array

**validateFiles**
- returns valid for empty files
- returns valid for null files
- accepts valid text files
- accepts valid image files
- rejects unsupported image types
- rejects invalid base64 data URL format
- rejects files exceeding individual size limit
- rejects files exceeding total size limit
- filters out invalid files but keeps valid ones

**getModels**
- returns array of model objects
- each model has value, label, and group
- includes haiku, sonnet, and opus

**handleEvent**
- captures session ID from system init event
- ignores system events without init subtype
- starts tracking assistant message on assistant event with message
- accumulates text deltas into current assistant message
- adds tool use blocks from deltas
- ignores deltas when no current assistant message
- updates stats from result event with usage
- accumulates stats across multiple result events
- saves assistant message to history on result
- sends message_complete on result
- sends system_message for result with direct text and no assistant message
- does not send system_message for result when assistant message exists
- handles user event with local-command-stdout
- handles user event with array content (tool_result) without crashing
- forwards all events via sendEvent

**processLine**
- sends raw_output for non-JSON lines
- does not send raw_output when handleEvent throws
- logs error to console when handleEvent throws

**handleCommand**
- shows current model with /model and no args
- rejects invalid model names
- shows transfer error when no session ID
- returns transfer object when session ID exists
- returns false for unhandled commands

**session state round-trip**
- persists and restores claudeSessionId
- handles null state gracefully
- handles empty customArgs

### `providers/gemini-provider.test.js` — Gemini CLI provider

**normalizeEvent**
- transforms streaming message to Claude-like format
- handles empty content in streaming message
- passes through non-message events unchanged
- passes through non-assistant messages unchanged
- passes through non-delta messages unchanged

**handleEvent**
- starts tracking assistant message on first assistant event
- accumulates text deltas
- captures session ID from init event
- tracks stats from result event
- saves assistant message on result
- sends message_complete on result
- forwards events via sendEvent

**handleCommand**
- shows current model with /model and no args
- rejects invalid model names
- switches to valid model
- returns false for unhandled commands

**getModels**
- returns array with gemini models

### `file-service.test.js` — File browser service

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

### `session-store.test.js` — Session persistence

**save and load round-trip**
- saves and loads a session
- preserves messages and stats
- preserves name field
- saves null name when not set
- includes name in loadAll results
- preserves providerState

**load**
- returns null for nonexistent session
- returns null for corrupt JSON file

**delete**
- removes a saved session
- does not throw when deleting nonexistent session

**loadAll**
- returns all saved sessions
- returns empty array when no sessions
- skips corrupt JSON files gracefully

### `session-manager.test.js` — Session lifecycle and routing

**getProviderForModel**
- routes gemini models to gemini provider
- falls back to claude for unknown models

**getAllModels**
- returns models from enabled providers only
- returns models from multiple enabled providers
- returns empty array when no providers enabled

**handleSlashCommand**
- returns false for non-slash text
- returns false for non-existent session
- handles /help command
- handles /clear command
- handles /zsh command
- handles /bash command as shell
- handles /claude command
- delegates unrecognized commands to provider
- returns false when provider does not handle command
- handles commands with arguments
- handles transfer command from provider

**createSession**
- creates a session and sends session_created
- uses project model and path when projectId provided
- initializes provider for new session
- sets up saveHistory function

**joinSession**
- joins an existing in-memory session
- restores session from store if not in memory
- sends error for nonexistent session
- sends stats_update after joining

**sendMessage**
- saves user message and delegates to provider
- passes files to provider
- does nothing for nonexistent session
- intercepts slash commands instead of sending to provider
- blocks messages on transferred sessions

**endSession**
- kills provider, saves, and removes session
- handles session without provider
- does nothing for nonexistent session

**deleteSession**
- kills provider, deletes from store and memory, sends session_ended
- sends session_ended even if session not in memory

**renameSession**
- renames a session and broadcasts
- trims whitespace and limits to 100 characters
- sets name to null for empty string
- sends error for nonexistent session

**restoreSavedSessions**
- loads all sessions from store into memory
- restored sessions have no active provider
- returns 0 when no saved sessions

## Integration Tests (`test/integration/`)

Auto-skipped when the required CLI or server is unavailable.

### `providers/claude-provider.test.js` — Claude CLI end-to-end

- responds to a simple message
- handles file attachment

### `providers/gemini-provider.test.js` — Gemini CLI end-to-end

- responds to a simple message
- responds to a calculation

### `providers/lmstudio-provider.test.js` — LM Studio HTTP end-to-end

- responds to a simple message
- handles file attachment
- maintains conversation history

## E2E Tests (`e2e/specs/`)

Playwright specs. Specs run sequentially — later specs depend on state created by earlier ones.

### `01-project-creation.spec.ts` — Initial setup and project creation

- welcome screen is visible on first load
- create E2E Claude Project
- create E2E LMStudio Project
- both projects visible in sidebar

### `02-session-creation.spec.ts` — Session creation within projects

- create session in Claude project
- create session in LM Studio project

### `03-send-messages.spec.ts` — Message sending and LLM responses

- send message in Claude session and get response
- send message in LM Studio session and get response

### `04-session-switching.spec.ts` — Navigation between sessions

- switch between sessions via sidebar and tabs

### `05-session-renaming.spec.ts` — Session rename and persistence

- rename Claude session
- rename LM Studio session
- renamed sessions persist after reload

### `06-shell-and-claude.spec.ts` — Shell and CLI launch via slash commands

- launch shell via /zsh and interact
- launch Claude CLI via /claude

### `07-screen-redraw.spec.ts` — UI stability under rapid switching

- rapid tab switching preserves content

### `08-shell-closing.spec.ts` — Terminal tab lifecycle

- close shell terminal tab
- close Claude CLI terminal tab
- only session tabs remain after closing terminals

### `09-file-manager.spec.ts` — File browser operations

- open file browser and upload file
- open file in editor
- modify and save file
- switch to split view and see preview

### `10-cleanup.spec.ts` — Teardown and persistence verification

- delete Claude session
- delete LM Studio session
- delete Claude project
- delete LM Studio project
- verify cleanup persists after reload
