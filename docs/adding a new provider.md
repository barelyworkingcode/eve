# Adding a New Provider

Providers are registered via a lightweight registry in `session-manager.js`. You'll implement the provider class, register it, and add server settings.

## 1. Create the provider class

Create `providers/<name>-provider.js` extending `LLMProvider`:

```javascript
const LLMProvider = require('./llm-provider');

class ExampleProvider extends LLMProvider {
  constructor(session, config = {}) {
    super(session);
    this.config = { ...config };
  }

  // Required — called once when session is created
  startProcess() {}

  // Required — send user message (with optional file attachments) to the LLM
  sendMessage(text, files = []) {
    this.session.processing = true;
    // ... send to LLM, call this.handleEvent() for each response event
  }

  // Required — process events from the LLM, accumulate messages, update stats
  // Must call this.sendEvent(event) to forward normalized events to the client
  handleEvent(event) {
    // On completion: set this.session.processing = false,
    // push to this.session.messages, call this.session.saveHistory(),
    // send 'message_complete' via ws
    this.sendEvent(event);
  }

  // Required — clean up processes/connections
  kill() {}

  // Required — returns display string for the session header
  getMetadata() {
    return `Example ${this.session.model} • ${this.session.directory}`;
  }

  // Required (static) — models available from this provider
  // `group` controls the <optgroup> label in the model selector
  static getModels() {
    return [
      { value: 'example-fast', label: 'Example Fast', group: 'Example' },
      { value: 'example-pro', label: 'Example Pro', group: 'Example' }
    ];
  }
}

module.exports = ExampleProvider;
```

### Optional overrides

| Method | Purpose |
|---|---|
| `normalizeEvent(event)` | Transform provider-specific events to Claude-like format before sending to client. Default: passthrough. |
| `getSessionState()` | Return provider state to persist across server restarts. |
| `restoreSessionState(state)` | Restore persisted state when session is reloaded. |
| `static clearSessionState(session)` | Clean up provider state on `/clear`. Default: deletes `session.providerState`. |
| `static getCommands()` | Return `[{name, description}]` for provider-specific slash commands. |
| `handleCommand(command, args, sendSystemMessage, rawText)` | Handle slash commands. Return `true` if handled. |

### Event contract

`sendEvent()` calls `normalizeEvent()` then sends to the client as:
```json
{ "type": "llm_event", "sessionId": "...", "event": { /* normalized */ } }
```

The client expects events in Claude's format. If your provider emits different shapes, implement `normalizeEvent()` to transform them. See `gemini-provider.js:168-184` for an example.

### Key lifecycle events to send via WebSocket

- `stats_update` — after accumulating token counts / cost
- `message_complete` — when the LLM finishes responding (set `session.processing = false` first)
- `process_exited` — if a spawned process exits
- `error` — on failure

## 2. Register in session manager

`session-manager.js` uses a provider registry. Two changes needed:

**Import** (top of file, with the other providers):
```javascript
const ExampleProvider = require('./providers/example-provider');
```

**Register** with `registerProvider()` — add before the Claude entry (Claude is the catch-all fallback and must be last):
```javascript
registerProvider('example', ExampleProvider, m => m.startsWith('example'));
registerProvider('claude', ClaudeProvider, () => true); // must stay last
```

The `matchModel` function receives a model string and returns `true` if this provider handles it. The registry is checked in order — first match wins. `getProviderForModel()`, `getProviderClass()`, and `getAllModels()` all derive from the registry automatically.

## 3. Register in server settings

`server.js` — add your provider to the default settings object (~line 41-60):

**Enable flag** in `settings.providers`:
```javascript
providers: {
  claude: true,
  gemini: true,
  lmstudio: true,
  example: true       // <-- add
}
```

**Config** in `settings.providerConfig` (only if your provider needs config):
```javascript
providerConfig: {
  // ... existing entries ...
  example: {
    path: null,
    responseTimeout: 120000,
    debug: false
  }
}
```

**Config merge** in `loadSettings()` (~line 82). Add your provider key to the loop:
```javascript
for (const provider of ['claude', 'gemini', 'example']) {
```

## 4. Settings file (`data/settings.json`)

Users can override the enable flag and config. No code changes needed — the merge logic in `loadSettings()` handles it automatically once you've added the defaults above.

```json
{
  "providers": {
    "example": false
  },
  "providerConfig": {
    "example": {
      "path": "/usr/local/bin/example-cli"
    }
  }
}
```

## 5. Client-side

No client code changes required. The model selector, project disable logic, and provider routing all derive from server-side data:

- Model `<optgroup>` labels come from the `group` field in `getModels()`
- Project graying-out works via `getProviderForModel()` matching against `settings.providers`
- Slash commands auto-populate in `/help` via `getCommands()`

## Reference implementations

- **CLI-based (process per message)**: `gemini-provider.js` — spawns a new process for each `sendMessage()`, parses stream-json stdout
- **CLI-based (persistent process)**: `claude-provider.js` — keeps a long-running process, writes to stdin
- **HTTP API**: `lmstudio-provider.js` — stateless HTTP calls, no child process

## Registration summary

Adding a new provider touches 2 files beyond the provider class itself:

| File | Changes |
|---|---|
| `session-manager.js` | 1 import + 1 `registerProvider()` call |
| `server.js` | Enable flag in `settings.providers`, optionally config in `providerConfig` + merge loop |
