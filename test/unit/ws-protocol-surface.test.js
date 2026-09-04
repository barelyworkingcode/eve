/**
 * Frozen wire-type inventory: 46 client message types. If a change forces
 * an edit to this file to stay green, production is wrong — fix
 * production, not this test.
 */
const fs = require('fs');
const path = require('path');
const { messages } = require('../../ws/message-registry');

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
    expect(new Set(FROZEN_TYPES).size).toBe(46);
  });

  it('matches every case label, pre-switch guard, and registered descriptor', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'ws-handler.js'), 'utf8');

    const caseLabels = [...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
    const guardTypes = [...src.matchAll(/message\.type === '([a-z_]+)'/g)].map((m) => m[1]);
    // A migrated type's `case` label can be gone from the switch and live only as a
    // registered descriptor; union it in so the dispatch surface stays 46 either way.
    const registered = messages.types();

    const measured = new Set([...caseLabels, ...guardTypes, ...registered]);

    expect(measured.size).toBe(46);
    expect([...measured].sort()).toEqual([...FROZEN_TYPES].sort());
  });

  it('every registered descriptor type is a member of the frozen surface', () => {
    for (const t of messages.types()) expect(FROZEN_TYPES).toContain(t);
  });
});
