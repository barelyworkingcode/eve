const nodePath = require('path');
const WebSocket = require('ws');

const KINDS = ['sessions', 'tasks', 'terminals'];
const SWEEP_WAIT_MS = 10000;
const WS_READY_MS = 10000;
const FETCH_TIMEOUT_MS = 15000;
const TERMINAL_LIST_MS = 10000;
const CLOSE_TERMINAL_WAIT_MS = 5000;

function isUnder(dir, root) {
  return !!dir && (dir === root || dir.startsWith(root + '/'));
}

function classify({ sessions, tasks, worldTaskIds, terminals }, projects) {
  const projectIds = new Set(projects.map(p => p.id));
  const taskIds = new Set(worldTaskIds);
  const item = (id, name, world) => ({ id, name: name || '', world });
  return {
    sessions: sessions.map(s => item(s.id, s.name, projectIds.has(s.projectId))),
    tasks: tasks.map(t => item(t.id, t.name, taskIds.has(t.id))),
    terminals: terminals.map(t => item(t.id, t.name, projects.some(p => isUnder(t.directory, p.path)))),
  };
}

function mapSnapshot(snap, fn) {
  const out = {};
  for (const k of KINDS) out[k] = fn(snap[k], k);
  return out;
}

function added(before, after) {
  return mapSnapshot(after, (items, k) => {
    const seen = new Set(before[k].map(i => i.id));
    return items.filter(i => !seen.has(i.id));
  });
}

const onlyWorld = snap => mapSnapshot(snap, items => items.filter(i => i.world));
const onlyOutside = snap => mapSnapshot(snap, items => items.filter(i => !i.world));
const countOf = snap => KINDS.reduce((n, k) => n + snap[k].length, 0);

class EveApi {
  // The token is a signed-in owner's session token, sent as X-Session-Token
  // and in the WS auth frame. It is never logged.
  constructor(baseUrl, { token = null } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.wsUrl = this.baseUrl.replace(/^http/, 'ws');
    this.token = token;
  }

  async _json(method, path, { token = this.token } = {}) {
    const headers = token ? { 'X-Session-Token': token } : {};
    const res = await fetch(this.baseUrl + path, { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}`);
    return text ? JSON.parse(text) : null;
  }

  async _array(path) {
    const data = await this._json('GET', path);
    if (!Array.isArray(data)) throw new Error(`GET ${path} did not answer an array`);
    return data;
  }

  async worldProjects(worldEntries) {
    const all = await this._array('/api/projects');
    return worldEntries.map(entry => {
      const matches = all.filter(p => p.name === entry.name);
      if (matches.length !== 1) {
        throw new Error(matches.length ? `project "${entry.name}" appears ${matches.length} times` : `project "${entry.name}" is missing`);
      }
      const { id, name, path } = matches[0];
      if (typeof path !== 'string' || !nodePath.isAbsolute(path)) {
        throw new Error(`project "${entry.name}" has no absolute path`);
      }
      return { key: entry.key, id, name, path };
    });
  }

  // Sends a token only when given one, whatever this client holds, so a
  // caller can see what an unauthenticated browser sees.
  async authStatus(token) {
    const status = await this._json('GET', '/api/auth/status', { token: token || null });
    if (!status || typeof status !== 'object') throw new Error('GET /api/auth/status did not answer an object');
    return status;
  }

  // This is subtle: eve answers auth_success before its upstream relay socket
  // is open, and drops anything sent before then. A terminal_list reply is the
  // only proof the upstream is live, so it is re-asked until one arrives.
  _connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const waiters = [];
      let poll = null;
      const fail = (err) => { clearInterval(poll); clearTimeout(timer); ws.terminate(); reject(err); };
      const timer = setTimeout(() => fail(new Error('eve WebSocket never reached relay')), WS_READY_MS);
      const conn = {
        send: msg => ws.send(JSON.stringify(msg)),
        close: () => ws.close(),
        terminals: () => new Promise((res, rej) => {
          const waiter = {
            res: (list) => { clearTimeout(waiter.timer); res(list); },
            rej: (err) => { clearTimeout(waiter.timer); rej(err); },
          };
          waiter.timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            rej(new Error(`no terminal_list reply within ${TERMINAL_LIST_MS / 1000}s`));
          }, TERMINAL_LIST_MS);
          waiters.push(waiter);
          conn.send({ type: 'terminal_list' });
        }),
      };
      ws.on('close', () => { for (const w of waiters.splice(0)) w.rej(new Error('eve WebSocket closed')); });
      ws.on('open', () => conn.send({ type: 'auth', token: this.token }));
      ws.on('error', err => fail(new Error(`eve WebSocket: ${err.message}`)));
      ws.on('message', (data) => {
        let frame;
        try { frame = JSON.parse(data.toString()); } catch { return; }
        for (const msg of frame.type === '__batch' ? frame.msgs : [frame]) {
          if (msg.type === 'auth_failed') return fail(new Error('eve refused WebSocket auth'));
          if (msg.type === 'error' && !poll) return fail(new Error(`eve: ${msg.message}`));
          if (msg.type === 'auth_success') {
            poll = setInterval(() => conn.send({ type: 'terminal_list' }), 500);
            conn.send({ type: 'terminal_list' });
          } else if (msg.type === 'terminal_list') {
            if (poll !== true) {
              clearInterval(poll);
              clearTimeout(timer);
              poll = true;
              resolve(conn);
            }
            const next = waiters.shift();
            if (next) next.res(msg.terminals || []);
          }
        }
      });
    });
  }

  async _terminals() {
    const conn = await this._connect();
    try { return await conn.terminals(); } finally { conn.close(); }
  }

  async snapshot(projects) {
    const [sessions, tasks, terminals] = await Promise.all([
      this._array('/api/sessions'), this._array('/api/tasks'), this._terminals(),
    ]);
    const worldTaskIds = [];
    for (const p of projects) {
      const own = await this._array(`/api/tasks?projectId=${encodeURIComponent(p.id)}`);
      worldTaskIds.push(...own.map(t => t.id));
    }
    return classify({ sessions, tasks, worldTaskIds, terminals }, projects);
  }

  async sweep(projects) {
    const world = onlyWorld(await this.snapshot(projects));
    const conn = await this._connect();
    try {
      for (const s of world.sessions) conn.send({ type: 'delete_session', sessionId: s.id });
      for (const t of world.terminals) conn.send({ type: 'terminal_close', terminalId: t.id });
      await conn.terminals();
    } finally {
      conn.close();
    }
    for (const t of world.tasks) await this._json('DELETE', `/api/tasks/${encodeURIComponent(t.id)}`);

    const deadline = performance.now() + SWEEP_WAIT_MS;
    for (;;) {
      const left = onlyWorld(await this.snapshot(projects));
      if (countOf(left) === 0) break;
      if (performance.now() > deadline) {
        const names = KINDS.flatMap(k => left[k].map(i => `${k.slice(0, -1)} "${i.name}"`));
        throw new Error(`sweep left ${names.join(', ')}`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return { sessions: world.sessions.length, tasks: world.tasks.length, terminals: world.terminals.length };
  }

  async closeTerminal(terminalId) {
    const conn = await this._connect();
    try {
      conn.send({ type: 'terminal_close', terminalId });
      const deadline = performance.now() + CLOSE_TERMINAL_WAIT_MS;
      while ((await conn.terminals()).some(t => t.id === terminalId)) {
        if (performance.now() > deadline) throw new Error(`terminal still open ${CLOSE_TERMINAL_WAIT_MS / 1000}s after terminal_close`);
        await new Promise(r => setTimeout(r, 500));
      }
    } finally {
      conn.close();
    }
  }
}

module.exports = { EveApi, classify, added, onlyWorld, onlyOutside };
