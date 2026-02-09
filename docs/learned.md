# Lessons Learned

## Path Handling in Node.js

**Issue**: `path.resolve()` treats paths starting with `/` as absolute paths.

```javascript
// WRONG: Returns '/' (filesystem root), not project directory
path.resolve('/Users/project', '/');

// CORRECT: Strip leading slashes first
const normalized = relativePath.replace(/^\/+/, '') || '.';
path.resolve('/Users/project', normalized);
```

When building file browsers or APIs that accept "relative" paths from clients, always normalize by stripping leading slashes before using `path.resolve()`.

## Test Session Mocks

When mocking session objects for provider tests, include all properties the provider expects:

```javascript
class TestSession {
  constructor() {
    this.messages = [];           // Provider pushes assistant messages here
    this.saveHistory = () => {};  // Provider calls this after messages
    this.stats = { /* ... */ };
    this.processing = false;
    // ... other properties
  }
}
```

Check the provider code for `this.session.*` references to identify required properties.

## Event Type Consistency

The `LLMProvider` base class sends events as `type: 'llm_event'`. Tests and client code must match this:

```javascript
// Base class sends:
{ type: 'llm_event', event: { type: 'assistant', delta: { text: '...' } } }

// NOT provider-specific types like 'lmstudio_event' or 'claude_event'
```

When adding new providers, use the base class `sendEvent()` method to ensure consistent event types across all providers.

## CSS Visibility Control

Use `.hidden` class consistently for showing/hiding elements. Never use inline `style.display`:

```javascript
// WRONG: Inline style overrides class removal, content stays hidden
element.style.display = 'none';
element.classList.remove('hidden');  // Still invisible!

// CORRECT: Use classes consistently
element.classList.add('hidden');
element.classList.remove('hidden');  // Works as expected
```

Inline styles have higher specificity than classes. Mixing them causes hard-to-debug visibility bugs where content appears blank even after removing the `hidden` class.
