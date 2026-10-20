'use strict';

// Independent, listen-only inventory. No outside text enters the managed ledger.
const SCOPE = { scope: 'chief-of-staff' };
const ROOT = '/api/chief-of-staff/outside-sessions';
const ROW_FIELDS = ['id', 'name', 'projectId', 'hostId', 'machine', 'directory', 'branch', 'state', 'since', 'updatedAt', 'source', 'outside', 'readOnly', 'tmuxSession', 'viewable', 'viewReason', 'endedAt'];
const MACHINE_FIELDS = ['hostId', 'machine', 'status', 'lastProbeAt', 'error'];
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pick = (row, fields) => Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));

class ChiefOfStaffOutside {
  constructor({ relayTransport, onSnapshot, resolveProject }) {
    this.transport = relayTransport;
    this.resolveProject = resolveProject || (() => null);
    // Row id -> Claude session id, ended rows only. Server-only: pick() keeps it out of every row,
    // so no snapshot, frame, list(), detail() or tool result carries it. Replaced with each accepted snapshot.
    this.claudeIds = new Map();
    this.resuming = new Set();
    this.onSnapshot = onSnapshot;
    this.snapshot = { revision: -1, probeIntervalMs: 15000, sessions: [], machines: [] };
    this.stopped = true;
    this.delay = 2000;
    this.generation = 0;
    // Last turn of each ended row, read once per endedAt. Browser frames only; list() never carries it.
    this.turns = new Map();
    this.filling = false;
    this.fillQueued = false;
  }

  browserSnapshot() {
    const snap = this.getSnapshot();
    snap.sessions = snap.sessions.map(r => {
      const turn = r.state === 'ended' ? this.turns.get(r.id) : undefined;
      return turn && turn.endedAt === r.endedAt ? { ...r, lastExcerpt: turn.text } : r;
    });
    return snap;
  }

  // One pass at a time; a snapshot that lands mid-pass queues one more. Reads run sequentially.
  async _fillTurns() {
    if (this.filling) { this.fillQueued = true; return; }
    this.filling = true;
    const generation = this.generation;
    let stored = false;
    try {
      do {
        this.fillQueued = false;
        const ended = this.snapshot.sessions.filter(r => r.state === 'ended');
        const ids = new Set(ended.map(r => r.id));
        for (const id of [...this.turns.keys()]) if (!ids.has(id)) this.turns.delete(id);
        for (const row of ended) {
          const have = this.turns.get(row.id);
          if (have && have.endedAt === row.endedAt) continue;
          let text;
          try { text = (await this.detail(row.id)).lastExcerpt; } catch { continue; }
          if (this.stopped || generation !== this.generation) return;
          this.turns.set(row.id, { endedAt: row.endedAt, text });
          stored = true;
        }
      } while (this.fillQueued);
    } finally {
      this.filling = false;
      // An abandoned pass (stop) must not swallow a pass queued by a restarted reader.
      if (this.fillQueued && !this.stopped && generation !== this.generation) { this.fillQueued = false; this._fillTurns(); }
    }
    if (stored && !this.stopped && generation === this.generation) this.onSnapshot?.(this.browserSnapshot());
  }

  getSnapshot() {
    return { ...this.snapshot, sessions: this.snapshot.sessions.map(r => ({ ...r })), machines: this.snapshot.machines.map(r => ({ ...r })) };
  }

  _snapshotOf(data) {
    if (!data || !Number.isInteger(data.revision) || !Array.isArray(data.sessions) || !Array.isArray(data.machines)) return null;
    const sessions = new Map();
    for (const row of data.sessions) {
      if (typeof row?.id !== 'string' || !row.id.startsWith('outside:') || row.outside !== true || row.readOnly !== true) continue;
      sessions.set(row.id, pick(row, ROW_FIELDS));
    }
    return { revision: data.revision, probeIntervalMs: data.probeIntervalMs || 15000,
      sessions: [...sessions.values()], machines: data.machines.filter(r => r && typeof r === 'object').map(r => pick(r, MACHINE_FIELDS)) };
  }

  _claudeIdsOf(data) {
    const ids = new Map();
    for (const row of data.sessions) {
      if (row?.state === 'ended' && typeof row.id === 'string' && typeof row.claudeSessionId === 'string') ids.set(row.id, row.claudeSessionId);
    }
    return ids;
  }

  _replace(data, reseed = false) {
    const snapshot = this._snapshotOf(data);
    if (!snapshot || (!reseed && snapshot.revision <= this.snapshot.revision)) return false;
    this.snapshot = snapshot;
    this.claudeIds = this._claudeIdsOf(data);
    this.onSnapshot?.(this.browserSnapshot());
    if (snapshot.sessions.some(r => r.state === 'ended') || this.turns.size) this._fillTurns();
    return true;
  }

  async list() {
    const generation = this.generation;
    const { status, data } = await this.transport.fetch('GET', ROOT, undefined, SCOPE);
    // Older Relay versions have no outside inventory; managed reads still work.
    if (status === 404) return [];
    const snapshot = this._snapshotOf(data);
    if (status !== 200 || !snapshot) throw Object.assign(new Error('Outside sessions are unavailable.'), { code: 'outside_status_unavailable', status });
    if (generation === this.generation) this._replace(data);
    // Return this completed read even during a Relay restart/revision reseed.
    return snapshot.sessions.map(r => ({ ...r }));
  }

  async detail(id) {
    if (!id.startsWith('outside:')) throw new Error('Invalid outside identity.');
    const { status, data } = await this.transport.fetch('GET', `${ROOT}/${encodeURIComponent(id)}`, undefined, SCOPE);
    if (status !== 200 || !data?.session || data.session.id !== id || data.session.outside !== true || data.session.readOnly !== true) {
      throw Object.assign(new Error(status === 404 ? 'That outside session is gone.' : 'Outside status is unavailable.'),
        { status: status === 404 ? 404 : 502, code: status === 404 ? 'outside_session_not_found' : 'outside_status_unavailable' });
    }
    return { session: pick(data.session, ROW_FIELDS), lastTurn: {
      text: String(data.lastTurn?.text || '').slice(-8192), at: String(data.lastTurn?.at || ''), complete: data.lastTurn?.complete === true,
    }, lastExcerpt: String(data.lastExcerpt || '').slice(-500) };
  }

  // Resume an ended row in a new managed terminal on the same conversation. Never throws.
  // The browser sends only the row id; the conversation id is eve's own, and it becomes a CLI argument.
  async resume(id, { cols, rows }) {
    const refuse = (status, error, message) => ({ status, body: { error, message } });
    const unavailable = (message) => refuse(409, 'outside_resume_unavailable', message);
    const row = this.snapshot.sessions.find(r => r.id === id);
    if (!row) return refuse(404, 'outside_session_not_found', 'That session is no longer in the list.');
    if (row.state !== 'ended') return refuse(409, 'outside_session_live', 'This session is still running. Only an ended session can be resumed.');
    const project = row.projectId ? this.resolveProject(row.projectId) : null;
    if (!project) return unavailable("Not in a project, so it can't be resumed.");
    if (row.hostId || project.hostId) return unavailable("On a host, so it can't be resumed here.");
    const claudeSessionId = this.claudeIds.get(id);
    if (typeof claudeSessionId !== 'string' || !CLAUDE_SESSION_ID.test(claudeSessionId)) {
      return unavailable("Relay gave no conversation id, so it can't be resumed.");
    }
    if (this.resuming.has(id)) return refuse(409, 'outside_resume_busy', 'This session is already being resumed.');
    this.resuming.add(id);
    try {
      const { status, data } = await this.transport.fetch('POST', '/api/terminals', {
        templateId: 'claude-code', name: `${row.name} (resumed)`, directory: row.directory,
        projectId: row.projectId, cols, rows, extraArgs: ['--resume', claudeSessionId],
      });
      if (status >= 200 && status < 300) {
        return data?.terminalId ? { status: 201, body: { terminal: data } }
          : refuse(502, 'resume_failed', 'Relay did not return a terminal.');
      }
      return refuse(status, data?.code || 'resume_failed', data?.error || `Relay answered ${status}.`);
    } catch {
      return { status: 502, body: { error: 'Service unavailable' } };
    } finally {
      this.resuming.delete(id);
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this._connect();
  }

  _connect() {
    if (this.stopped) return;
    const generation = ++this.generation;
    let ws;
    try { ws = this.transport.createWebSocket('/ws/outside-sessions', SCOPE); } catch { this._retry(); return; }
    this.ws = ws;
    let seeded = false;
    ws.on('message', bytes => {
      if (this.stopped || generation !== this.generation) return;
      try {
        const data = JSON.parse(bytes.toString());
        if (data.type !== 'outside_sessions') return;
        if (!this._replace(data, !seeded)) return;
        seeded = true;
        this.delay = 2000;
      } catch { /* Invalid data never becomes a row or a log entry. */ }
    });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._retry();
    });
  }

  _retry() {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this._connect(); }, this.delay);
    this.timer.unref?.();
    this.delay = Math.min(30000, this.delay * 2);
  }

  stop() {
    this.stopped = true;
    ++this.generation;
    this.turns.clear();
    clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

module.exports = { ChiefOfStaffOutside };
