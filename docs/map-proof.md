# Map proof

Breaking an area's request-path code turns one of its selected specs red. `node scripts/map-proof.js --all --record docs/map-proof.md` breaks one catalogued line per area (`test/map-proof/breaks.json`) in a detached worktree at the base commit, runs the specs `select()` picks, and records the tests that went red. A test counts only when its title tags a row of a goal that lists the area. The rows below are rewritten by the proof run; the two lists after them are written by hand, and growth in either needs the `map-narrowing-approved` label.

| Area | File | Break | Base | Red tests | Date |
|---|---|---|---|---|---|

## Journey-only areas
none

## Pending
- ui-control: G8 (#369)
