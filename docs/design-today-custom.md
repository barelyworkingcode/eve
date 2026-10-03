# Custom Today cards

A terminal routine with an output file is a card on Today. Eve adds no store and no server route: the card reads the newest successful run's `output` from the routine's history (relayScheduler stores what the script wrote to the file), and Refresh is Run now.

## What a script writes

One JSON file, in the routine's project folder, named by the routine's Output file. One object; `renderer` picks the shape; unknown keys are ignored.

```json
{ "renderer": "list",    "items":   [{ "title": "Reply to Acme", "detail": "today", "url": "https://acme.test/m/1" }] }
{ "renderer": "table",   "columns": ["Name", "Open"], "rows": [["p1", 3], ["p2", null]] }
{ "renderer": "metrics", "metrics": [{ "label": "Unread", "value": 7, "detail": "INBOX" }] }
```

- `list`: `title` is required (an item without one is dropped); `detail` and `url` are optional. A `url` that is not `http:`/`https:`, or is over 2048 characters, is dropped and the item stays as text. At most 50 items; the card shows 10 and "+N more".
- `table`: `columns` is a non-empty array, at most 8. At most 50 rows; cells become text (`null` is empty); each row is padded or cut to the column count.
- `metrics`: `label` is required; `value` is a string or number. At most 12.
- Caps, in characters (longer text ends in "…"): title 120, detail 200, label 60, value 40, cell 80.

## What the card shows

| State | Shown |
|---|---|
| never ran, or no successful run with output | "No output yet." and Refresh |
| running | "Running…" over the previous output |
| failed (non-zero exit, timeout, missing or oversize file) | the reason and Retry; the previous good output below, marked Stale |
| success | routine name, "Ran <time>", the output, Refresh |
| output unreadable | "Output not understood (<reason>)" with the raw text (first 4,000 characters) behind a disclosure |

Reasons: `empty`, `bad-json`, `unknown-renderer`, `bad-shape`.

## Safety

Output is untrusted (it may hold summarised mail). Every string is set with `textContent`. The only element built from output with an attribute is `a`, and only for an `http:`/`https:` URL, with `rel="noopener noreferrer"`. No `innerHTML`, `img`, `iframe` or `script` comes from output. Loading Today runs nothing.

Setting an output file needs a passkey session; the trusted-network bypass can view and refresh cards but gets a 403 on `POST`/`PUT /api/tasks` carrying `outputFile`. The script runs with its template's access and can change any file it can reach (relay#178 tracks tightening that). The Output file field is hidden for SSH host projects.

## Where

`public/today/custom-output.js` (parser), `public/today/parts/custom-part.js` (`CustomPart`, and `CustomParts`, which keeps one part per card routine in the registry, in the project's mode, ordered by routine name after the Morning brief).
