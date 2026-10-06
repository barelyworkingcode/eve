// Chief of Staff: one server-wide thread that watches every agent session and
// speaks up when one needs the person. It reads relay's attention frames on a
// scoped, listen-only /ws; a model (chief-of-staff-model.js, tools off) only
// writes the wording of a post. eve decides what is worth a post, builds every
// card from relay data, and sends a person's instruction through relay's
// scoped POST so the message is marked and audited. Agent text is data: it
// reaches the model only inside the prompt's quoted region (see
// chief-of-staff-prompt.js) and never decides a send. Two model sessions keep
// that true across turns: the wake model reads agent text and can never send,
// the person model sees only the person's words and the quoted roster, and only
// its reply may send.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NullLogger } = require('./logger');
const prompt = require('./chief-of-staff-prompt');
const { HIDDEN_SEARCH_PREFIX } = require('./search-summarizer');
const { HIDDEN_COS_PREFIX } = require('./chief-of-staff-model');

const SCOPE = 'chief-of-staff';
const POSTS_FILE = 'chief-of-staff.jsonl';
const STATE_FILE = 'chief-of-staff-state.json';
const MAX_POSTS = 200;

const DEFAULTS = Object.freeze({ enabled: true, model: 'sonnet', projectId: null, dailyModelCalls: 100 });

const TRIGGER_STATES = new Set(['asking', 'errored', 'stalled']);
const NEED_YOU_STATES = TRIGGER_STATES;

const BATCH_QUIET_MS = 2000;
const BATCH_MAX_WAIT_MS = 10000;
const BATCH_SIZE = 10;
const LIST_REFRESH_MIN_MS = 5000;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const TURN_TIMEOUT_MS = 120000;
const PENDING_UNKNOWN_MAX = 50;
const PERSON_MAX = 2000;
const QUOTE_MAX = 500;
const LABEL_MAX = 80;

// Model failures that mean "this model must not run": keep posting templates.
const FATAL_MODEL_CODES = new Set(['launch_failed', 'tools_present', 'tools_unverified']);

const SEND_LINES = {
  session_not_found: () => 'That session is gone.',
  already_processing: (label) => `${label} is busy. Try again when it finishes.`,
  resume_required: (label) => `${label} isn't running. Open it to resume it.`,
  dropped_in: (label) => `You've dropped in to ${label}, so I didn't send.`,
  audit_unavailable: () => "Relay's audit log is off, so I can't send.",
};

function sendFailureLine(code, label) {
  const f = SEND_LINES[code];
  return f ? f(label) : `Relay refused the send (${code}).`;
}

// What a person is told when a message arrives while the model cannot run.
function offNotice(off) {
  switch (off.reason) {
    case 'disabled': return "I'm off in eve's settings, so I can't send.";
    case 'scope_refused': return "Relay won't let me read sessions, so I can't send.";
    case 'no_project':
    case 'project_unsuitable': return "No project can run me, so I can't send. Set chiefOfStaff.projectId.";
    case 'launch_failed': return `I couldn't start the model${off.detail ? `: ${off.detail}` : ''}, so I can't send.`;
    default: return "The model has tools, so I'm off and can't send. Alerts still post.";
  }
}

// settings.chiefOfStaff -> a complete, typed config. A wrong type is never
// fatal: warn naming the key and use the default for that key.
function parseChiefOfStaffSettings(raw, log) {
  const out = { ...DEFAULTS };
  const warn = (key, why) => log?.warn?.(`settings.json: chiefOfStaff.${key} ${why}; using ${JSON.stringify(DEFAULTS[key])}`);
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    log?.warn?.('settings.json: chiefOfStaff must be an object; using defaults');
    return out;
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled; else warn('enabled', 'must be true or false');
  }
  if (raw.model !== undefined) {
    if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim(); else warn('model', 'must be a non-empty string');
  }
  if (raw.projectId !== undefined && raw.projectId !== null) {
    if (typeof raw.projectId === 'string' && raw.projectId.trim()) out.projectId = raw.projectId.trim(); else warn('projectId', 'must be a project id string or null');
  }
  if (raw.dailyModelCalls !== undefined) {
    const n = raw.dailyModelCalls;
    if (Number.isInteger(n) && n >= 1 && n <= 10000) out.dailyModelCalls = n; else warn('dailyModelCalls', 'must be an integer from 1 to 10000');
  }
  return out;
}

function localDay(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function newPostId() {
  return `p-${crypto.randomBytes(6).toString('hex')}`;
}

function cut(s, n) {
  const str = typeof s === 'string' ? s : '';
  return str.length > n ? str.slice(0, n) : str;
}

// Atomic, private write: tmp + rename, 0600 (the notifier.js pattern).
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, text, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

class ChiefOfStaff {
  // createModel({countCall, previousSessionId, onSessionId}) -> ChiefOfStaffModel
  // (or any object with turn()). `model` may be passed ready-made instead.
  constructor({
    relayTransport, resolveProject, listProjects, createModel, model, dataDir,
    settings, log, now = () => Date.now(),
  } = {}) {
    this.relayTransport = relayTransport;
    this.resolveProject = resolveProject || (() => null);
    this.listProjects = listProjects || (() => []);
    this.settings = { ...DEFAULTS, ...(settings || {}) };
    this.log = log || new NullLogger();
    this.now = now;
    this.postsFile = path.join(dataDir, POSTS_FILE);
    this.stateFile = path.join(dataDir, STATE_FILE);

    this.posts = [];
    // modelSessionId is the wake model's; personSessionId the person model's.
    this.state = { day: localDay(new Date(now())), calls: 0, modelSessionId: null, personSessionId: null, limitNoticeDay: null };
    this._writeChain = Promise.resolve();

    this.roster = new Map();      // id -> row
    this._ownIds = { wake: null, person: null };
    this._waiting = new Map();    // sessionId -> trigger entry (newer replaces)
    this._people = [];            // person messages waiting for a turn
    this._inFlight = null;
    this._batchTimer = null;
    this._lastBusy = false;

    this.off = null;
    this.modelId = null;
    this._lastStatusJson = null;

    this._subscribers = new Set();
    this._started = false;
    this._stopped = false;
    this._ws = null;
    this._reconnectTimer = null;
    this._reconnectDelay = RECONNECT_MIN_MS;

    this._seeding = false;
    this._seedBuffer = [];
    this._unknown = new Map();    // id -> {state, turn} frames waiting for a list refresh
    this._refreshInFlight = null;
    this._lastRefreshAt = 0;
    this._refreshTimer = null;

    // `model` serves both roles when given ready-made (tests); createModel
    // builds one session each, so a wake can never share context with a person turn.
    this.model = model || null;
    this.personModel = null;
    this._createModel = createModel || null;
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (this._started) return;
    this._started = true;
    this._loadFiles();
    if (!this.settings.enabled) {
      this.off = { reason: 'disabled', detail: '' };
      this._emitStatus();
      return;
    }
    if (!this.model && this._createModel) {
      this.model = this._createModel({
        kind: 'wake',
        countCall: () => this.countCall(),
        previousSessionId: this.state.modelSessionId,
        onSessionId: (id) => this._setModelSession('wake', id),
      });
      this.personModel = this._createModel({
        kind: 'person',
        countCall: () => this.countCall(),
        previousSessionId: this.state.personSessionId,
        onSessionId: (id) => this._setModelSession('person', id),
      });
    }
    this._connect();
  }

  // Returns a promise that settles once queued post and state writes are on
  // disk, so a restart right after stop() loses nothing. It does not wait for
  // the model sessions' DELETEs.
  stop() {
    this._stopped = true;
    for (const t of [this._reconnectTimer, this._batchTimer, this._refreshTimer]) clearTimeout(t);
    this._reconnectTimer = this._batchTimer = this._refreshTimer = null;
    const ws = this._ws;
    this._ws = null;
    if (ws) { try { ws.close(); } catch { /* closing */ } }
    for (const m of new Set([this.model, this.personModel])) {
      try { Promise.resolve(m?.close?.()).catch(() => {}); } catch { /* closing */ }
    }
    return this._writeChain.then(() => {});
  }

  _loadFiles() {
    try {
      const lines = fs.readFileSync(this.postsFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(-MAX_POSTS)) {
        try {
          const p = JSON.parse(line);
          if (p && p.v === 1 && typeof p.id === 'string') this.posts.push(p);
        } catch { /* one bad line must not lose the rest */ }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Chief of Staff posts not read: ${err.message}`);
    }
    try {
      const s = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (s && typeof s === 'object') {
        if (typeof s.day === 'string') this.state.day = s.day;
        if (Number.isInteger(s.calls) && s.calls >= 0) this.state.calls = s.calls;
        if (typeof s.modelSessionId === 'string') this.state.modelSessionId = s.modelSessionId;
        if (typeof s.personSessionId === 'string') this.state.personSessionId = s.personSessionId;
        if (typeof s.limitNoticeDay === 'string') this.state.limitNoticeDay = s.limitNoticeDay;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.log.warn(`Chief of Staff state not read: ${err.message}`);
    }
    this._rollDay();
  }

  // ---- daily call counter ------------------------------------------------

  _rollDay() {
    const today = localDay(new Date(this.now()));
    if (this.state.day !== today) {
      this.state.day = today;
      this.state.calls = 0;
      this._persistState();
    }
  }

  // Called by the model before every send_message, bootstrap included.
  countCall() {
    this._rollDay();
    if (this.state.calls >= this.settings.dailyModelCalls) return false;
    this.state.calls += 1;
    this._persistState();
    this._emitStatus();
    return true;
  }

  _atLimit() {
    this._rollDay();
    return this.state.calls >= this.settings.dailyModelCalls;
  }

  _setModelSession(kind, id) {
    const own = typeof id === 'string' && id ? id : null;
    this._ownIds[kind] = own;
    if (own) this.roster.delete(own);
    if (kind === 'person') this.state.personSessionId = own; else this.state.modelSessionId = own;
    this._persistState();
  }

  _isOwnId(id) {
    return id === this._ownIds.wake || id === this._ownIds.person;
  }

  _persistState() {
    const text = `${JSON.stringify(this.state)}\n`;
    this._queueWrite(() => writeAtomic(this.stateFile, text), 'state');
  }

  _queueWrite(fn, what) {
    this._writeChain = this._writeChain.then(fn).catch((err) => {
      this.log.warn(`Chief of Staff ${what} not written: ${err.message}`);
    });
    return this._writeChain;
  }

  // ---- posts -------------------------------------------------------------

  _addPost(fields) {
    const post = { v: 1, id: newPostId(), at: new Date(this.now()).toISOString(), ...fields };
    post.byModel = fields.byModel === true;
    this.posts.push(post);
    if (this.posts.length > MAX_POSTS) this.posts.splice(0, this.posts.length - MAX_POSTS);
    const text = this.posts.map((p) => JSON.stringify(p)).join('\n') + '\n';
    this._queueWrite(() => writeAtomic(this.postsFile, text), 'posts');
    this._fanOut({ type: 'cos_post', post });
    return post;
  }

  _notice(body) {
    return this._addPost({ kind: 'notice', body, byModel: false });
  }

  // ---- status and browsers -----------------------------------------------

  getStatus() {
    let watching = 0;
    let needYou = 0;
    for (const row of this.roster.values()) {
      if (!row.state || row.state === 'ended') continue;
      watching += 1;
      if (NEED_YOU_STATES.has(row.state)) needYou += 1;
    }
    return {
      busy: this._isBusy(),
      watching,
      needYou,
      model: this.modelId,
      calls: { used: this.state.calls, max: this.settings.dailyModelCalls },
      off: this.off,
    };
  }

  getSnapshot() {
    return { posts: this.posts.slice(), status: this.getStatus() };
  }

  subscribe(ws) {
    // A repeat on the same socket still gets a snapshot, but no second listener.
    if (!this._subscribers.has(ws)) {
      this._subscribers.add(ws);
      ws.once?.('close', () => this._subscribers.delete(ws));
    }
    this._sendTo(ws, { type: 'cos_snapshot', ...this.getSnapshot() });
  }

  _sendTo(ws, frame) {
    try { ws.send(JSON.stringify(frame)); } catch { /* socket closing */ }
  }

  _fanOut(frame) {
    const json = JSON.stringify(frame);
    for (const ws of this._subscribers) {
      if (ws.readyState !== undefined && ws.readyState !== 1) {
        if (ws.readyState > 1) this._subscribers.delete(ws);
        continue;
      }
      try { ws.send(json); } catch { /* socket closing */ }
    }
  }

  _emitStatus() {
    const status = this.getStatus();
    const json = JSON.stringify(status);
    if (json === this._lastStatusJson) return;
    this._lastStatusJson = json;
    this._fanOut({ type: 'cos_status', status });
  }

  _isBusy() {
    return this._waiting.size > 0 || this._people.length > 0 || this._inFlight !== null;
  }

  _setOff(off) {
    const same = JSON.stringify(this.off) === JSON.stringify(off);
    this.off = off;
    if (!same) this._emitStatus();
  }

  // ---- roster and the scoped reader --------------------------------------

  _labelOf(row, id) {
    const name = row && typeof row.name === 'string' ? row.name.trim() : '';
    return cut(name, LABEL_MAX) || `Session ${String(id).slice(0, 8)}`;
  }

  _projectName(projectId) {
    const p = projectId ? this.resolveProject(projectId) : null;
    return (p && p.name) || '';
  }

  _rowFromListEntry(s) {
    const att = s.attention && typeof s.attention.state === 'string' ? s.attention : null;
    return {
      id: s.id,
      name: typeof s.name === 'string' ? s.name : '',
      projectId: s.projectId || '',
      model: typeof s.model === 'string' ? s.model : '',
      headless: s.headless === true,
      state: att ? att.state : null,
      since: att && typeof att.since === 'string' ? att.since : '',
    };
  }

  // Hidden sessions (the model's own, the search summariser's) are never watched.
  _isHidden(s) {
    const name = typeof s.name === 'string' ? s.name : '';
    return this._isOwnId(s.id) || name.startsWith(HIDDEN_COS_PREFIX) || name.startsWith(HIDDEN_SEARCH_PREFIX);
  }

  // Scoped GET /api/sessions. `seed` replaces the roster and posts nothing
  // for any state it finds (D4). `prune` replaces the membership but keeps the
  // known state of rows still listed. Otherwise it only adds unknown rows.
  async _fetchRoster({ seed, prune = false }) {
    const { status, data } = await this.relayTransport.fetch('GET', '/api/sessions', undefined, { scope: SCOPE });
    if (status === 403) {
      const err = new Error('relay refused the Chief of Staff scope');
      err.scopeRefused = true;
      throw err;
    }
    if (status < 200 || status >= 300) throw new Error(`session list answered ${status}`);
    const list = Array.isArray(data && data.sessions) ? data.sessions : Array.isArray(data) ? data : [];
    const seen = new Set();
    for (const s of list) {
      if (!s || typeof s.id !== 'string' || !s.id) continue;
      if (this._isHidden(s)) continue;
      seen.add(s.id);
      const fresh = this._rowFromListEntry(s);
      const known = this.roster.get(s.id);
      if (!known) {
        this.roster.set(s.id, fresh);
      } else if (seed) {
        this.roster.set(s.id, fresh);
      } else {
        known.name = fresh.name; known.projectId = fresh.projectId; known.model = fresh.model; known.headless = fresh.headless;
      }
    }
    if (seed || prune) {
      for (const id of [...this.roster.keys()]) {
        if (!seen.has(id)) { this.roster.delete(id); this._waiting.delete(id); }
      }
    }
  }

  _connect() {
    if (this._stopped) return;
    let ws;
    try {
      ws = this.relayTransport.createWebSocket('/ws', { scope: SCOPE });
    } catch (err) {
      this.log.warn(`Chief of Staff reader not opened: ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    let handled = false;

    ws.on('open', () => {
      this._seed(ws);
    });
    ws.on('message', (data) => {
      if (this._ws !== ws) return;
      let frame;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      this._onFrame(frame);
    });
    // A refused upgrade (TCP mode: 403 before any frame; or a 5xx) ends in
    // neither 'close' nor 'error' once req is destroyed, so it is handled here.
    ws.on('unexpected-response', (req, res) => {
      const code = res.statusCode;
      handled = true;
      try { res.resume(); req.destroy(); } catch { /* already gone */ }
      if (this._ws === ws) this._ws = null;
      if (code === 403) this._scopeRefused(); else this._scheduleReconnect();
    });
    ws.on('close', () => {
      if (handled) return;
      if (this._ws === ws) this._ws = null;
      this._scheduleReconnect();
    });
    // 'close' follows 'error' and drives the reconnect; a listener must exist.
    ws.on('error', () => {});
  }

  async _seed(ws) {
    this._seeding = true;
    this._seedBuffer = [];
    try {
      await this._fetchRoster({ seed: true });
      this._chooseProject();
    } catch (err) {
      this._seeding = false;
      this._seedBuffer = [];
      if (err.scopeRefused) { this._scopeRefused(); return; }
      this.log.warn(`Chief of Staff roster not read: ${err.message}`);
      try { ws.close(); } catch { /* closing */ }
      return;
    }
    this._seeding = false;
    // Backoff resets only once the list has been read; a list that keeps
    // failing keeps backing off.
    this._reconnectDelay = RECONNECT_MIN_MS;
    this.log.info?.(`Chief of Staff watching ${this.roster.size} sessions`);
    // Frames that arrived while the list was in flight are newer than it.
    const buffered = this._seedBuffer;
    this._seedBuffer = [];
    for (const f of buffered) this._onFrame(f);
    this._emitStatus();
  }

  _scopeRefused() {
    this.log.warn('Chief of Staff: relay refused the scoped reader; the thread is off');
    this._setOff({ reason: 'scope_refused', detail: '' });
    this.stop();
  }

  _scheduleReconnect() {
    if (this._stopped || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  // ---- frames and triggers -----------------------------------------------

  _onFrame(frame) {
    if (!frame || typeof frame.sessionId !== 'string' || !frame.sessionId) return;
    if (frame.type !== 'session_state' && frame.type !== 'turn_done' && frame.type !== 'session_ended') return;
    if (this._seeding) { this._seedBuffer.push(frame); return; }
    const id = frame.sessionId;
    if (this._isOwnId(id)) return;

    if (frame.type === 'session_ended') {
      this.roster.delete(id);
      this._waiting.delete(id);
      this._unknown.delete(id);
      this._emitStatus();
      return;
    }
    const row = this.roster.get(id);
    if (!row) { this._holdUnknown(frame); return; }
    if (frame.type === 'session_state') this._applyState(row, frame, false);
    else this._applyTurnDone(row, frame);
  }

  _applyState(row, frame, fromUnknown) {
    const next = typeof frame.state === 'string' ? frame.state : '';
    if (!next) return;
    const prev = fromUnknown ? null : row.state;
    row.state = next;
    row.since = typeof frame.since === 'string' ? frame.since : row.since;
    if (TRIGGER_STATES.has(next) && next !== prev) {
      this._enqueue(row.id, { kind: 'state', state: next, since: row.since, excerpt: '' });
    } else {
      // A session that left a trigger state has nothing waiting any more.
      const w = this._waiting.get(row.id);
      if (w && w.kind === 'state' && w.state !== next) this._waiting.delete(row.id);
    }
    this._emitStatus();
  }

  _applyTurnDone(row, frame) {
    const excerpt = typeof frame.excerpt === 'string' ? frame.excerpt : '';
    if (!prompt.isQuestion(excerpt)) return;
    this._enqueue(row.id, {
      kind: 'question', state: 'question',
      since: typeof frame.at === 'string' ? frame.at : '', excerpt: cut(excerpt, QUOTE_MAX),
    });
  }

  _holdUnknown(frame) {
    if (!this._unknown.has(frame.sessionId) && this._unknown.size >= PENDING_UNKNOWN_MAX) return;
    const slot = this._unknown.get(frame.sessionId) || {};
    if (frame.type === 'session_state') slot.state = frame; else slot.turn = frame;
    this._unknown.set(frame.sessionId, slot);
    this._scheduleUnknownRefresh();
  }

  // One list refresh at most every 5 s. A frame whose id is still unknown
  // after it is dropped (hidden sessions, failed launches).
  _scheduleUnknownRefresh() {
    if (this._refreshInFlight || this._refreshTimer || this._stopped) return;
    const wait = Math.max(0, this._lastRefreshAt + LIST_REFRESH_MIN_MS - this.now());
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._runUnknownRefresh();
    }, wait);
    this._refreshTimer.unref?.();
  }

  async _runUnknownRefresh() {
    this._lastRefreshAt = this.now();
    const pending = this._unknown;
    this._unknown = new Map();
    this._refreshInFlight = this._fetchRoster({ seed: false }).catch((err) => {
      if (err.scopeRefused) this._scopeRefused();
      else this.log.warn(`Chief of Staff roster refresh failed: ${err.message}`);
    });
    await this._refreshInFlight;
    this._refreshInFlight = null;
    for (const [id, slot] of pending) {
      const row = this.roster.get(id);
      if (!row) continue;
      if (slot.state) this._applyState(row, slot.state, true);
      if (slot.turn) this._applyTurnDone(row, slot.turn);
    }
    if (this._unknown.size > 0) this._scheduleUnknownRefresh();
  }

  // ---- queue and batching ------------------------------------------------

  _enqueue(sessionId, entry) {
    this._waiting.set(sessionId, { ...entry, sessionId, at: this.now() });
    this._emitStatus();
    this._pump();
  }

  _wakeReadyAt() {
    let oldest = Infinity;
    let newest = 0;
    for (const e of this._waiting.values()) {
      oldest = Math.min(oldest, e.at);
      newest = Math.max(newest, e.at);
    }
    return Math.min(newest + BATCH_QUIET_MS, oldest + BATCH_MAX_WAIT_MS);
  }

  _pump() {
    if (this._inFlight || this._stopped) { this._emitStatus(); return; }
    clearTimeout(this._batchTimer);
    this._batchTimer = null;
    if (this._people.length > 0) {
      const job = this._people.shift();
      this._runTurn(() => this._personTurn(job));
      return;
    }
    if (this._waiting.size > 0) {
      const readyAt = this._wakeReadyAt();
      const wait = readyAt - this.now();
      if (wait <= 0) {
        const batch = [...this._waiting.values()].sort((a, b) => a.at - b.at).slice(0, BATCH_SIZE);
        for (const e of batch) this._waiting.delete(e.sessionId);
        this._runTurn(() => this._wakeTurn(batch));
        return;
      }
      this._batchTimer = setTimeout(() => { this._batchTimer = null; this._pump(); }, wait);
      this._batchTimer.unref?.();
    }
    this._emitStatus();
  }

  _runTurn(fn) {
    const run = Promise.resolve().then(fn).catch((err) => {
      this.log.error(`Chief of Staff turn failed: ${err && err.message}`);
    }).then(() => {
      this._inFlight = null;
      this._pump();
    });
    this._inFlight = run;
    this._emitStatus();
  }

  // ---- model access ------------------------------------------------------

  // D5: the configured project, else the first local project whose policy
  // does not get in the way. Returns {project} or sets `off` and returns null.
  _chooseProject() {
    const projects = [...this.listProjects()];
    const model = this.settings.model;
    const allows = (p) => {
      const a = Array.isArray(p.allowedModels) ? p.allowedModels : [];
      return a.length === 0 || a.includes('*') || a.includes(model);
    };
    const suitable = (p) => !p.hostId && !p.permissionPolicy && allows(p);
    let project = null;
    let reason = null;
    if (this.settings.projectId) {
      project = projects.find((p) => p.id === this.settings.projectId) || null;
      if (!project) reason = 'no_project';
      else if (!suitable(project)) { reason = 'project_unsuitable'; project = null; }
    } else {
      project = projects.find(suitable) || null;
      if (!project) reason = 'no_project';
    }
    if (reason) {
      if (!this.off || !FATAL_MODEL_CODES.has(this.off.reason)) this._setOff({ reason, detail: '' });
      return null;
    }
    if (this.off && (this.off.reason === 'no_project' || this.off.reason === 'project_unsuitable')) this._setOff(null);
    return project;
  }

  _modelFor(kind) {
    return kind === 'person' ? (this.personModel || this.model) : this.model;
  }

  _modelBlocked(model) {
    return !model || (this.off && ['tools_present', 'tools_unverified', 'no_project', 'project_unsuitable'].includes(this.off.reason));
  }

  // Runs one model turn. Returns {text} or {error: <code>}; maps fatal
  // failures to `off` and never throws.
  async _modelTurn(kind, text) {
    if (this._atLimit()) return { error: 'limit' };
    const project = this._chooseProject();
    const model = this._modelFor(kind);
    if (!project || this._modelBlocked(model)) return { error: 'off' };
    try {
      const out = await model.turn(text, {
        projectId: project.id, directory: project.path, model: this.settings.model, timeoutMs: TURN_TIMEOUT_MS,
      });
      if (out && out.modelId) { this.modelId = out.modelId; }
      if (this.off && this.off.reason === 'launch_failed') this._setOff(null);
      this._emitStatus();
      return { text: out && typeof out.text === 'string' ? out.text : '' };
    } catch (err) {
      const code = (err && err.code) || 'turn_failed';
      this.log.warn(`Chief of Staff model turn failed: ${code}${err && err.message ? ` (${cut(err.message, 500)})` : ''}`);
      if (FATAL_MODEL_CODES.has(code)) this._setOff({ reason: code, detail: cut(err.message || '', 200) });
      this._emitStatus();
      return { error: code };
    }
  }

  _noteLimitOnce() {
    const day = this.state.day;
    if (this.state.limitNoticeDay === day) return;
    this.state.limitNoticeDay = day;
    this._persistState();
    this._notice(`I've reached today's limit of ${this.settings.dailyModelCalls} model calls. I'll write alerts myself until tomorrow.`);
  }

  // ---- wake turns --------------------------------------------------------

  _eventFor(entry) {
    const row = this.roster.get(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      label: this._labelOf(row, entry.sessionId),
      project: this._projectName(row && row.projectId),
      state: entry.state,
      since: entry.since,
      excerpt: entry.excerpt,
    };
  }

  _cardFor(event) {
    const row = this.roster.get(event.sessionId) || {};
    return {
      sessionId: event.sessionId,
      label: event.label,
      project: event.project,
      state: event.state,
      since: event.since,
      quote: cut(event.excerpt, QUOTE_MAX),
      headless: row.headless === true,
      model: row.model || '',
      actions: event.state === 'asking' || event.state === 'question'
        ? ['answer', 'drop_in', 'open'] : ['drop_in', 'open'],
    };
  }

  _stillValid(entry) {
    const row = this.roster.get(entry.sessionId);
    if (!row) return false;
    return entry.kind === 'state' ? row.state === entry.state : row.state === 'idle';
  }

  async _wakeTurn(batch) {
    const events = batch.filter((e) => this._stillValid(e)).map((e) => this._eventFor(e));
    if (events.length === 0) return;

    let modelPosts = new Map();
    const atLimit = this._atLimit();
    if (atLimit) {
      this._noteLimitOnce();
    } else {
      const res = await this._modelTurn('wake', prompt.wakePrompt(events));
      if (res.error === 'limit') this._noteLimitOnce();
      if (res.text !== undefined) {
        const parsed = prompt.parseWake(res.text, events.map((e) => e.sessionId));
        for (const p of parsed.posts || []) {
          if (p && p.headline && !modelPosts.has(p.sessionId)) modelPosts.set(p.sessionId, p);
        }
      }
    }
    for (const event of events) {
      const written = modelPosts.get(event.sessionId);
      const text = written || prompt.templatePost(event);
      this._addPost({
        kind: 'alert', headline: text.headline, body: text.body,
        card: this._cardFor(event), byModel: Boolean(written),
      });
    }
  }

  // ---- person turns and send ---------------------------------------------

  // A message typed in the thread. Returns once it is queued; the reply and
  // any send arrive as posts.
  submitPerson(rawText) {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (text.length < 1 || text.length > PERSON_MAX) {
      throw new Error(`Message must be 1 to ${PERSON_MAX} characters`);
    }
    this._addPost({ kind: 'person', text, byModel: false });
    if (!this.settings.enabled || (this.off && (this.off.reason === 'disabled' || this.off.reason === 'scope_refused'))) {
      this._notice(offNotice(this.off || { reason: 'disabled' }));
      return;
    }
    this._people.push({ text });
    this._pump();
  }

  async _personTurn(job) {
    if (this._atLimit()) {
      this._notice("I've reached today's limit, so I can't send until tomorrow.");
      return;
    }
    try {
      await this._fetchRoster({ seed: false, prune: true });
    } catch (err) {
      this.log.warn(`Chief of Staff roster refetch failed: ${err.message}`);
      this._notice("I couldn't read the sessions just now, so I didn't send. Try again.");
      return;
    }
    this._emitStatus();
    const rows = [...this.roster.values()].map((row) => ({
      sessionId: row.id,
      label: this._labelOf(row, row.id),
      project: this._projectName(row.projectId),
      state: row.state || 'unknown',
    }));
    const res = await this._modelTurn('person', prompt.personPrompt(job.text, rows));
    if (res.error === 'limit') {
      this._notice("I've reached today's limit, so I can't send until tomorrow.");
      return;
    }
    if (res.error === 'off') {
      this._notice(offNotice(this.off || { reason: 'no_project' }));
      return;
    }
    if (res.error) {
      this._notice(this.off && FATAL_MODEL_CODES.has(res.error)
        ? offNotice(this.off)
        : `I couldn't reach the model (${res.error}), so I didn't send. Try again.`);
      return;
    }
    const parsed = prompt.parsePerson(res.text, rows.map((r) => r.sessionId));
    if (parsed.reason === 'unknown-session') {
      // The reply may claim a send that eve refused; never post it.
      this._notice("I couldn't match that to a session, so I didn't send anything. Say which one.");
      return;
    }
    if (parsed.reply) this._addPost({ kind: 'reply', body: parsed.reply, byModel: true });
    else if (!parsed.send) this._notice("I couldn't make sense of my own answer, so I didn't send anything. Try again.");
    if (parsed.send) await this._send(parsed.send.sessionId, parsed.send.text);
  }

  // Scoped POST; relay stamps the origin, so the body never carries one.
  async _send(sessionId, text) {
    const row = this.roster.get(sessionId);
    const label = this._labelOf(row, sessionId);
    let status = 0;
    let data = null;
    try {
      ({ status, data } = await this.relayTransport.fetch(
        'POST', '/api/chief-of-staff/messages', { sessionId, text }, { scope: SCOPE },
      ));
    } catch (err) {
      this.log.warn(`Chief of Staff send failed: ${err.message}`);
      this._addPost({
        kind: 'send_failed', sessionId, label, error: 'Relay refused the send (unreachable).', byModel: false,
      });
      return;
    }
    if (status === 202) {
      this._addPost({ kind: 'sent', text, sessionId, label, origin: SCOPE, byModel: true });
      return;
    }
    const code = data && typeof data.error === 'string' ? data.error : `http_${status}`;
    this._addPost({ kind: 'send_failed', sessionId, label, error: sendFailureLine(code, label), byModel: false });
  }
}

module.exports = {
  ChiefOfStaff,
  parseChiefOfStaffSettings,
  sendFailureLine,
  DEFAULTS,
  POSTS_FILE,
  STATE_FILE,
};
