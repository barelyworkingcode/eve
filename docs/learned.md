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
