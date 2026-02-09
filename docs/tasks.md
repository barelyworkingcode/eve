# Scheduled Tasks

Eve supports scheduled tasks that run prompts automatically. Tasks are defined in `.tasks.json` in the project root.

## File Format

```json
{
  "version": 1,
  "tasks": [
    {
      "id": "unique-task-id",
      "name": "Human-readable name",
      "prompt": "The prompt to execute when the task runs",
      "schedule": { "type": "daily", "time": "22:00" },
      "enabled": true,
      "model": null,
      "createdAt": "2026-02-06T10:00:00.000Z"
    }
  ]
}
```

## Schedule Types

| Type | Format | Example |
|------|--------|---------|
| Daily | `{ "type": "daily", "time": "HH:MM" }` | Run at 9am daily |
| Hourly | `{ "type": "hourly", "minute": N }` | Run at minute 30 of each hour |
| Interval | `{ "type": "interval", "minutes": N }` | Run every 15 minutes |
| Weekly | `{ "type": "weekly", "day": "monday", "time": "HH:MM" }` | Run Monday at 9am |

## Task Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique identifier (kebab-case) |
| `name` | Yes | Display name shown in UI |
| `prompt` | Yes | The prompt executed when task runs |
| `schedule` | Yes | When to run (see types above) |
| `enabled` | Yes | Set to false to pause without deleting |
| `model` | No | Model override (null uses project default) |
| `createdAt` | Yes | ISO timestamp of creation |

## Examples

### Daily board meeting prep
```json
{
  "id": "board-prep",
  "name": "Board Meeting Prep",
  "prompt": "Review the upcoming board meeting agenda and summarize key discussion points. Check for any pending action items from previous meetings.",
  "schedule": { "type": "weekly", "day": "tuesday", "time": "08:00" },
  "enabled": true,
  "model": null,
  "createdAt": "2026-02-06T10:00:00.000Z"
}
```

### Weekly membership review
```json
{
  "id": "membership-check",
  "name": "Membership Review",
  "prompt": "Check for any membership changes this week and update the tracking notes.",
  "schedule": { "type": "weekly", "day": "friday", "time": "16:00" },
  "enabled": true,
  "model": null,
  "createdAt": "2026-02-06T10:00:00.000Z"
}
```

### Daily todo review
```json
{
  "id": "todo-review",
  "name": "Daily Todo Review",
  "prompt": "Read todo.md and identify any items that are overdue or need attention today.",
  "schedule": { "type": "daily", "time": "09:00" },
  "enabled": true,
  "model": null,
  "createdAt": "2026-02-06T10:00:00.000Z"
}
```

## Managing Tasks

Use standard file editing to manage `.tasks.json`:

- **Create**: Add a new task object to the `tasks` array
- **Disable**: Set `enabled: false` to pause without deleting
- **Delete**: Remove the task object from the array
- **Modify**: Update any field as needed

The task scheduler watches for file changes and picks up updates automatically.
