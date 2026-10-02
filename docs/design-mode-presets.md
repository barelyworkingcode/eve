# S3b-1 · Mode presets and the Action Button

Slice S3b-1 of Epic #34 (#145), on S1 ([design-today-s1.md](design-today-s1.md)), the Settings sheet and S3a. Intent: `design/homework/index.html`, "Action Button opens voice in the current mode" and "Ask without choosing anything".

## User story

As the owner, I want each mode to name the chat preset Ask starts with and the voice preset the Action Button opens, so a question or a voice thread in Home or Work starts the way I set it up, on my phone and my Mac alike, without a per-device favourite.

## Rules

**Storage.** A chat template carries `preset_for` at relay and `presetFor` in eve: a list of `home` or `work`, never `both`.
- A template whose `mode` is `voice` and lists M is M's voice preset; any other template that lists M is M's Ask preset.
- A project holds at most one Ask and one voice preset per mode. Relay refuses more with 400; eve's dialog never sends that.
- It is a label, never a grant: nothing in relay reads it to decide access.
- `normalizeProject` filters to `home`/`work`, deduplicates, and reads a missing field as `[]`.

**A mode's presets.** The mode's project is the local project whose `defaultFor` includes the mode; failing that, the only local project visible in the mode; otherwise none. Presets are read from that project only. A preset on any other project is inert until that project becomes the mode's project.

**Template editor.** Edit Project → Templates → a template's form has one row under Startup Mode, labelled "Ask preset in" (Text) or "Voice preset in" (Voice). Buttons `project-template-preset-home` and `project-template-preset-work` (`aria-pressed`, no checkbox) cover the modes the project's mode includes. Pressing M on one template clears M from the other templates of the same kind. List rows show badges ("Home Ask", "Work voice"). Changing the project's mode drops presets for a mode it no longer includes. The PUT body sends `preset_for` only when non-empty. Under `(pointer: coarse)` the buttons are at least 44×44.

**Settings, Modes.** Under each `settings-default-<mode>` row that names a project, `settings-presets-<mode>` reads `Ask: <name> · Voice: <name>`, with `none` for a missing one. A mode with no project has no row.

**Ask.** In the mode's project with an Ask preset, `create_session` carries the preset's `model` and non-empty `systemPrompt`, then `applyChatDefaults`; `eve-ask-model` is neither read nor written. If the preset's model is not allowed in the project, the status says so and Send is disabled. Elsewhere Ask is unchanged from S1.

**Action Button.** `#/voice-chat` with nothing to resume launches the mode's voice preset through `shellLauncher.launchTemplate`, once per burst of presses. A blank model gives the existing toast. With no mode project it toasts "Set a default <Mode> project in Relay to use the Action Button." With a project but no voice preset it toasts "No <Mode> voice preset. Pick one in Edit Project → Templates." and opens the launcher on its Voice Chat form.

**Resume.** Instead of launching, `#/voice-chat` resumes a voice thread that is the one on screen, or a session of type voice whose project is visible in the current mode and whose last activity is within the window. Last activity is the latest of `lastMessageAt`, `createdAt` and the device's `SessionRecents` `lastOpenedAt`; with several, the most recent wins. **A voice thread resumes only while strictly younger than 30 minutes: at 29:59 it resumes, at 30:00 it does not.** Older threads and threads in the other mode are left alone. A failed join falls back to the launch.

**The star goes.** Launcher cards have no favourite star. `getFavoriteTemplate`, `setFavoriteTemplate` and `FAVORITE_TEMPLATE_ENABLED` are gone; a stored `favoriteTemplate` stays in `eve-settings`, ignored.

## Decisions

1. **Storage is a field on the chat template, edited in eve.** Relay stores templates and eve already edits them; a Relay-edited field would need a Relay form, an IPC path and a journey for the same result. Phone and Mac agree because both read relay.
2. **"Younger than 30 minutes" is last activity**, not creation. The on-screen voice thread always resumes. "Live" means listed by relay, not provider-alive: an idle provider restarts on the next message.
3. **A thread talked to for more than 30 minutes, then left for another tab, counts from its open**, not its last message.
4. **A mode's presets live on its project.** Changing the default changes the presets with it.
5. **No favourite migration.** The favourite was per device and the preset is per mode; mapping one onto the other guesses the mode. The toast says where to pick a preset.
6. **A disallowed Ask-preset model blocks Ask** with a line naming why, instead of silently using another model.

## Code

`public/core/mode-presets.js` is pure (UMD, like `core/task-schedule.js`): `MODES`, `RESUME_MS`, `label`, `other`, `normalize`, `kind`, `projectFor`, `presetsOf`, `forMode`, `withPreset`, `askFrame`, `lastActive`, `resumable`. Ask (`today/parts/ask-part.js`), Settings (`_buildModes`), the template editor (`project-dialog.js`) and `app.js` (`_handleHashRoute`, `_launchModeVoice`) use it. S3b-2 ("Ask in <other mode>") reuses `other`, `projectFor`, `presetsOf` and `askFrame`; their signatures are frozen.

## Tests

Unit `test/unit/mode-presets.test.js`; cloud spec `test/e2e/goals/mode-presets.spec.js`; journeys `mode-presets` and `voice-deep-link`. The iOS Action Button on a phone and the 30-minute boundary in real time are not unattended-verifiable; Playwright seeds the times.
