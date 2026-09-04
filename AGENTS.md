# eve — agent brief

Browser-based LLM frontend. Vanilla JS, **no bundler, no build step, no
modules** — `public/index.html` loads plain `<script>` tags in dependency
order and every class lands on `window`. Node/Express backend at the repo root.

## Build & test

    node --check <file.js>     # THE build gate — there is no compiler
    npm test                   # jest unit, hermetic. Must stay green.
    npm run test:e2e           # playwright. Must stay green.

## Rules that make an otherwise-correct patch wrong here

- `server.js` reads `public/index.html` into memory **once at startup**.
  Editing index.html has no effect until the server restarts. Editing any
  other JS/CSS under `public/` is picked up immediately.
- Script order in `index.html` is load-bearing (globals, not modules). If you
  delete a `<script>` tag, make sure nothing later still references its class.
- Never weaken or skip a test to go green. If a test covers code you removed,
  say so explicitly and tighten it rather than deleting the assertion.
- Do not reformat or restyle code you are not otherwise changing.
- Do not run `git commit`. Leave your work in the working tree.
- `package-lock.json` is committed with **CRLF** line endings. `npm install`
  rewrites it as LF, which turns a 60-line dependency change into a 7,700-line
  whole-file diff. After any `npm install`, restore it:
  `perl -pi -e 's/\r?\n/\r\n/' package-lock.json`
- Six source files are **also CRLF**: `public/index.html`,
  `public/tab-manager.js`, `public/file-editor.js`,
  `public/sidebar-renderer.js`, `routes/index.js`, `ws-handler.js`. A tool
  that rewrites a whole file (rather than patching in place) silently
  converts them to LF and turns a one-line edit into a whole-file diff.
  Check with `grep -c $'\r' <file>` and restore the same way.
- You are the developer. Never invoke `pi-host`, `pi-log`, or anything under
  `~/.claude/skills/pi-dev/` — you are the job those scripts run, so polling
  one deadlocks. Do the work directly.
