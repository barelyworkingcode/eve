'use strict';

// Independent, listen-only inventory. No outside text enters the managed ledger.
const SCOPE = { scope: 'chief-of-staff' };
const ROOT = '/api/chief-of-staff/outside-sessions';
const ROW_FIELDS = ['id', 'name', 'projectId', 'hostId', 'machine', 'directory', 'branch', 'state', 'since', 'updatedAt', 'source', 'outside', 'readOnly', 'tmuxSession', 'viewable', 'viewReason'];
const MACHINE_FIELDS = ['hostId', 'machine', 'status', 'lastProbeAt', 'error'];
const pick = (row, fields) => Object.fromEntries(fields.filter(k => row[k] !== undefined).map(k => [k, row[k]]));

class ChiefOfStaffOutside {
  constructor({ relayTransport, onSnapshot }) {
    this.transport = relayTransport;
    this.onSnapshot = onSnapshot;
    this.snapshot = { revision: -1, probeIntervalMs: 15000, sessions: [], machines: [] };
    this.stopped = true;
    this.delay = 2000;
    this.generation = 0;
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

  _replace(data, reseed = false) {
    const snapshot = this._snapshotOf(data);
    if (!snapshot || (!reseed && snapshot.revision <= this.snapshot.revision)) return false;
    this.snapshot = snapshot;
    this.onSnapshot?.(this.getSnapshot());
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
    clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

module.exports = { ChiefOfStaffOutside };
