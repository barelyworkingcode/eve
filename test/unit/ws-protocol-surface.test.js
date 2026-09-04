/**
 * Frozen wire inventory (spec §8.3 / §1). 44 `case` labels plus the two
 * pre-switch `if (message.type === …)` guards (`auth`, `ping`) — 46 total.
 *
 * This list is hardcoded against the CURRENT SWITCH for phase 5 handoff 1.
 * From handoff 2 onward it also asserts against `messages.types()` from the
 * new registry (see spec §9c-T5) — do not add that assertion before the
 * registry exists. Adding, removing or renaming a client→server message type
 * must fail this test; that is the whole point of it.
 */
const fs = require('fs');
const path = require('path');

// The 46-element frozen array, committed once in this handoff and never
// reordered/edited except by an explicit, reviewed protocol change.
const FROZEN_TYPES = [
  'auth',
  'ping',
  'device_log',
  'create_session',
  'join_session',
  'user_input',
  'leave_session',
  'end_session',
  'delete_session',
  'rename_session',
  'set_session_folder',
  'stop_generation',
  'permission_response',
  'set_permission_mode',
  'list_directory',
  'read_file',
  'write_file',
  'rename_file',
  'move_file',
  'delete_file',
  'upload_file',
  'create_directory',
  'search_project',
  'search_cancel',
  'search_ai_summarize',
  'search_ai_stop',
  'watch_file',
  'unwatch_file',
  'module_read_file',
  'module_write_file',
  'module_invoke_ai',
  'module_ai_stop',
  'terminal_create',
  'terminal_input',
  'terminal_resize',
  'terminal_close',
  'terminal_list',
  'terminal_reconnect',
  'join_terminal',
  'leave_terminal',
  'terminal_templates',
  'voice_mode',
  'tts_speak',
  'tts_speak_cancel',
  'transcribe_audio',
  'read_plan_file',
];

describe('ws protocol surface (frozen)', () => {
  it('has exactly 46 types', () => {
    expect(FROZEN_TYPES.length).toBe(46);
    expect(new Set(FROZEN_TYPES).size).toBe(46); // no duplicates
  });

  it('matches every case label and pre-switch guard in ws-handler.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ws-handler.js'), 'utf8');

    const caseLabels = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    // The two pre-switch guards, matched the same way §1a of the spec describes them.
    const guardTypes = [...src.matchAll(/message\.type === '([a-z_]+)'/g)].map((m) => m[1]);

    const measured = new Set([...caseLabels, ...guardTypes]);

    expect(measured.size).toBe(46);
    expect([...measured].sort()).toEqual([...FROZEN_TYPES].sort());
  });
});
