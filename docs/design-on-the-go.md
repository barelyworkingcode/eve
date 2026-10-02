# On the go (S6)

Failed routines are written to a file, and any answer or the Morning brief can be read aloud on a touch device. Nothing reaches the phone yet.

## Notifier

`notifier.js`. A notifier is an object with `notify(n): Promise<void>` that never rejects. `createNotifier({ dataDir, log })` returns the one implementation, `FileNotifier`, at `<dataDir>/notifications.jsonl`. A later Pushover or native-push sink is a second class with the same method, chosen in `createNotifier`. Nothing else changes.

`FileNotifier({ file, max = 200, log })` appends one line and keeps the last `max`. Writes go through one promise chain (tmp file, then rename), so concurrent calls all land. The file is created 0600 because task names and errors are private. On error it logs `Notification not written` with the kind and task id, and resolves.

## Watcher

`routine-failure-watcher.js`. `RoutineFailureWatcher` holds its own `/ws/tasks` connection, because the per-browser one exists only while a browser is open. It reconnects at 2 s doubling to a 30 s cap (as `relay-client.js#_connectScheduler`), never sends upstream, and stops on shutdown. `routineFailedNotification(frame, now)` returns a notification for a `task_error` frame with a string `taskId`, otherwise null. Started, completed and `task_status` frames write nothing.

## File format

One UTF-8 JSON line per notification, `\n`-terminated:

```json
{"v":1,"kind":"routine_failed","at":"2026-10-02T07:00:03.120Z","title":"Routine failed: Morning brief","message":"process exited with code 3","url":"#routines","taskId":"t_123","projectId":"p_9","status":"error"}
```

- `at`: eve's clock when the frame arrived, ISO 8601 UTC.
- `status`: the frame's, or `error` when absent (a run that never started has none).
- `title`: `Routine failed: ` or, for `timeout`, `Routine timed out: `, then the task name capped at 80 characters (falls back to the task id).
- `message`: the error with whitespace collapsed, capped at 200. Empty gives `The run took too long.` for a timeout, else `The run failed.`
- There is no run id: on a run that never started, the frame's run id is the previous run's.

## Listen and read aloud

Under a coarse pointer the existing Read aloud button is always visible (`chat.css`; sizing from `touch.css`). The Morning brief card adds Listen when the brief is shown with its Refresh and Open actions. It speaks what the card shows, in card order: `<label>. <item>. <item>.` per section, joined by a space, with ` · ` read as a comma. Event notes, `+N more`, the header and the "Not in this brief" line are not spoken. It reads Stop while speaking.

## What was cut and why

- Permission-ask notifications: relay denies a tool call when nobody is viewing the thread, so no ask waits while the owner is away.
- Real Pushover sends, credentials, env vars and settings: secrets and publishing are the owner's. The file is the stub.
- Quiet hours and mode filters: every failed run notifies.
- Per-run deep link: the link is `#routines`; eve doesn't know its public URL.
- Hold-to-talk: changes the frozen chat input row. Voice into any thread already exists.
- Sentence highlighting, spoken placeholders for code and tables, screen-off playback: the last needs the native app.
- Quick capture to Reminders: needs a session limited to `reminders_create`, which relay can't express.
- Handoff rows ("from iPhone"): needs a per-thread device record that doesn't exist. Continue already puts the latest thread first.
- iOS share extension and native push: out.
