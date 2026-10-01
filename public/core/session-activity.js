/**
 * Per-thread activity (running / waiting / failed) derived from the frames eve
 * receives from relay. Inbound frames only: relay delivers a thread's frames to
 * its joined viewers, so a thread this browser has not joined has no state here,
 * and `live` (the provider process is alive) is never read as "running".
 * In memory: a reload, a disconnect or a re-join forgets it rather than guess.
 *
 * Priority when several apply: waiting > running > failed > idle.
 */
class SessionActivity {
  constructor(bus) {
    this.bus = bus;
    this._turn = new Map();      // sessionId -> 'running' | 'failed'
    this._reason = new Map();    // sessionId -> failure text
    this._permissions = new Map(); // permissionId -> sessionId (the response carries no session)
  }

  statusOf(sessionId) {
    for (const sid of this._permissions.values()) if (sid === sessionId) return 'waiting';
    return this._turn.get(sessionId) || 'idle';
  }

  reasonOf(sessionId) {
    return this._reason.get(sessionId) || '';
  }

  observe(frame) {
    const id = frame && frame.sessionId;
    switch (frame && frame.type) {
      case 'user_message':
      case 'llm_event':
        if (id) this._set(id, () => { this._turn.set(id, 'running'); this._reason.delete(id); });
        break;
      case 'message_complete':
        if (id) this._set(id, () => { this._turn.delete(id); });
        break;
      case 'error':
        // An error with no session cannot be pinned on a thread; resume_required
        // is answered by eve itself and is not a failed turn.
        if (id && frame.code !== 'resume_required') {
          this._set(id, () => { this._turn.set(id, 'failed'); this._reason.set(id, frame.message || 'The turn failed.'); });
        }
        break;
      case 'process_exited':
        if (id) {
          this._set(id, () => {
            if (this._turn.get(id) === 'running') {
              this._turn.set(id, 'failed');
              this._reason.set(id, 'The model process exited during the turn.');
            }
          });
        }
        break;
      case 'permission_request':
        if (id && frame.permissionId) this._set(id, () => { this._permissions.set(frame.permissionId, id); });
        break;
      case 'session_joined':
      case 'session_ended':
        if (id) this._clear(id);
        break;
      default:
    }
  }

  permissionAnswered(permissionId) {
    const id = this._permissions.get(permissionId);
    if (id === undefined) return;
    this._set(id, () => { this._permissions.delete(permissionId); });
  }

  reset() {
    const ids = new Set([...this._turn.keys(), ...this._permissions.values()]);
    this._turn.clear();
    this._reason.clear();
    this._permissions.clear();
    for (const id of ids) this._emit(id);
  }

  _clear(id) {
    this._set(id, () => {
      this._turn.delete(id);
      this._reason.delete(id);
      for (const [pid, sid] of this._permissions) if (sid === id) this._permissions.delete(pid);
    });
  }

  // Emit only when the visible status or failure text changed.
  _set(id, mutate) {
    const before = `${this.statusOf(id)}|${this.reasonOf(id)}`;
    mutate();
    if (`${this.statusOf(id)}|${this.reasonOf(id)}` !== before) this._emit(id);
  }

  _emit(sessionId) {
    if (this.bus) this.bus.emit(EVT.SESSION_ACTIVITY, { sessionId });
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = SessionActivity;
