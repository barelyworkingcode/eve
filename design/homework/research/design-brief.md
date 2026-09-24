# Home|Work next: design brief for mockup authors

## Thesis
Home|Work is one window onto the intelligence on your own Mac. It opens to your day, answers with sources you can check, runs your routines overnight and keeps your coding agents in view, on whichever screen is nearest. Quiet: no dashboards, no knobs. Heavy machinery (models, tools, grants, audit, hosts) lives in the Relay desktop app.

## Principles
1. Open to the day, not to a tool. A blinking cursor, not a launcher.
2. One thread, any surface. Typed, spoken, scheduled or continued elsewhere: it's a *thread*. Never say "session", "shell launcher", "web chat".
3. Context is a room. Home and Work are modes; Relay enforces what each can reach. The UI only decides where new things start.
4. Show your work in one line. Sources first, tool activity collapsed to one honest line, refusals shown.
5. Earn every pixel. Anything used less than weekly lives in ⌘K or in Relay.

## Nouns
Thread (chat/voice/research/routine run) · Agent (a live terminal: Claude Code, pi, shell) · Project (a folder, local or on a host) · Routine (scheduled prompt) · Mode (Home or Work) · Preset (model + system prompt).

## Spaces (same in both modes)
- **Today**: Ask box focused · Morning brief (a routine's output) · Needs you (permission asks, failed routines, exited agents) · Continue (recent threads, handoff "from iPad 12 min ago") · Running agents · Changes (Work only).
- **Threads**: every conversation in the current mode, auto-titled, pinned first, grouped by day, searchable.
- **Projects**: one page per project: threads, agents, changes, files. The Work workbench. Hidden in Home until a second project exists.
- **Routines**: scheduled prompts written as sentences ("Every weekday at 07:00 · Morning brief · ran 07:00, ok") with last result.
- ⌘K everywhere. Settings is tiny: appearance (Auto/Light/Dark), text size, voice, modes (work hours, default presets), "Advanced… opens Relay on your Mac".

## Mode
The wordmark "Home | Work" is the switch (segmented, in kit.css `.modeswitch`). Work accent = cool blue `--work`; Home accent = warm orange `--home` (add class `mode-home` on body). Threads keep the mode they started in. A refused tool call offers "Ask in Work".

## Layout by device
- Wide ≥1100 (desktop, iPad landscape): left rail (mode switch, 4 spaces, pinned projects, ⌘K, Settings) + content.
- Regular 700–1099 (iPad portrait): slide-over sidebar, one reading column ~720pt.
- Compact <700 (iPhone): bottom tab bar: Today · Threads · (+) Capture · Projects. Push navigation, no tabs. Hold-to-talk prominent.
- Coarse pointer → 44pt targets at any width.

## Signature interactions
- Research answers: sources row appears first (domain monogram chips, never remote favicons), inline [n] citation chips with hover/tap excerpt; a citation with no fetched source renders hollow.
- One working line: "Searched 3 · read 5 · checking calendar" beside a streaming caret; expands to raw tool blocks.
- Permission asks render as a card inside the thread (tool, target, one-line reason, Allow / Allow always in this project / Deny). Never a modal; never dismissed by a backdrop tap.
- "Make this a routine" at the end of a thread; confirmation reads the sentence back.
- "Stayed on this Mac" mark on answers from local models with no open-world tool.
- Quick capture: one field; shrinks into a chip "Filed to Reminders · Home".
- Voice: hold mic to dictate into any thread; hands-free orb continues the same thread.

## Visual language
Use `mockups/kit.css` (read it fully). Warm neutral canvas, white cards, SF system font, pill controls, generous whitespace, one accent per mode. Dark variant: add class `dark` on body. Reference mockup: `mockups/01-today-desktop-work.html` / `.png` — match its density and polish.

## Mockup conventions
- One HTML file per screen in `mockups/`, `<meta name="frame" content="desktop|ipad|ipad-portrait|phone">` (desktop 1440x900, ipad 1194x834, ipad-portrait 834x1194, phone 393x852). Link `kit.css`; put screen-specific CSS in a `<style>` block.
- Inline SVG icons only; no network resources, no images from the web.
- 2–4 yellow `.note` annotations per screen (with `<b>n · title</b>`) explaining the non-obvious design decision. Keep them off important content.
- Content must be neutral and realistic: company "Acme", people "Dana", "Sam", "Priya", host "devbox". No real names, hosts or paths.
- Render with `node design/homework/tools/render-mockups.js <prefix>` from the eve repo root, then Read the PNG and iterate until it looks shipped, not sketched. Check clipping, overflow, alignment, and that notes don't hide key content.
