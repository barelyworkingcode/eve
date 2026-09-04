/**
 * Frozen wire inventory (spec §8.3 / §1). 44 `case` labels plus the two
 * pre-switch `if (message.type === …)` guards (`auth`, `ping`) — 46 total.
 *
 * This list is hardcoded against the CURRENT SWITCH for phase 5 handoff 1.
 * This file is frozen: if a later handoff has to edit it to stay green,
 * production is wrong — fix production, not this test. Adding, removing or
 * renaming a client→server message type must fail this test; that is the
 * whole point of it.
 */
const fs = require('fs');
const path = require('path');
const { messages } = require('../../ws/message-registry');

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

  it('matches every case label, pre-switch guard, and registered descriptor', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ws-handler.js'), 'utf8');

    const caseLabels = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    // The two pre-switch guards, matched the same way §1a of the spec describes them.
    const guardTypes = [...src.matchAll(/message\.type === '([a-z_]+)'/g)].map((m) => m[1]);
    // From handoff 2 onward, a migrated type's `case` label is gone from the
    // switch fallback and lives only as a registered descriptor — union in
    // messages.types() so the total dispatch surface stays 46 across the
    // whole migration, not just while everything is still in the switch.
    const registered = messages.types();

    const measured = new Set([...caseLabels, ...guardTypes, ...registered]);

    expect(measured.size).toBe(46);
    expect([...measured].sort()).toEqual([...FROZEN_TYPES].sort());
  });

  it('every registered descriptor type is a member of the frozen surface', () => {
    for (const t of messages.types()) expect(FROZEN_TYPES).toContain(t);
  });
});
