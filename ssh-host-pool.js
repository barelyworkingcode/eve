'use strict';

/**
 * Eve's side of ../relay/docs/ssh-hosts.md decision 7: one long-lived
 * remote-fs-agent.js process per host, reached over `ssh_argv + ['-T', '--',
 * <node launcher>]`. HostAgent owns the child process, the request/response
 * correlation, and reconnection; HostPool is a hostId -> HostAgent cache so
 * every file/search/watch operation on the same host shares one connection
 * (which itself rides relay's ControlMaster for the actual TCP session).
 */

const { spawn: defaultSpawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { nodeLauncher } = require('./ssh-command');

const REQUEST_TIMEOUT_MS = 30000;
const HELLO_TIMEOUT_MS = 10000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const AGENT_SOURCE = fs.readFileSync(path.join(__dirname, 'remote-fs-agent.js'), 'utf8');

class HostAgent extends EventEmitter {
  constructor({ host, spawnFn, agentSource, log } = {}) {
    super();
    this.host = host;
    this.status = 'connecting';
    this._spawnFn = spawnFn || defaultSpawn;
    this._agentSource = agentSource || AGENT_SOURCE;
    this.log = log || null;

    this._proc = null;
    this._buf = '';
    this._pending = new Map(); // id -> { resolve, reject, timer, onChunk }
    this._nextId = 1;
    this._reconnectDelay = RECONNECT_MIN_MS;
    this._reconnectTimer = null;
    this._closed = false;
    // Ref-counted so two browser connections watching the same root don't
    // race to unwatch it out from under each other.
    this._watchRefs = new Map(); // root -> count

    this._connect();
  }

  _setStatus(status, error) {
    if (this.status === status && !error) return;
    this.status = status;
    this.emit('status', { hostId: this.host.id, name: this.host.name, status, error: error || undefined });
  }

  _connect() {
    if (this._closed) return;
    this._setStatus('connecting');

    const argv = [...(this.host.ssh_argv || []), '-T', '--', nodeLauncher(this._agentSource)];
    let proc;
    try {
      proc = this._spawnFn(argv[0], argv.slice(1));
    } catch (err) {
      this._handleExit(`spawn failed: ${err.message}`);
      return;
    }
    this._proc = proc;
    this._buf = '';

    proc.stdout.on('data', (chunk) => this._onData(chunk));
    // ssh diagnostics (host key prompts refused by BatchMode, DNS failures)
    // land here; not part of the wire protocol, so best-effort logging only.
    proc.stderr.on('data', (chunk) => this.log?.debug?.(`[${this.host.name}] stderr: ${chunk.toString('utf8').trim()}`));
    proc.on('error', (err) => this._handleExit(err.message));
    proc.on('exit', () => this._handleExit(`host "${this.host.name}" unreachable`));

    this._request('hello', { version: 1 }, HELLO_TIMEOUT_MS).then(() => {
      if (this._proc !== proc) return; // superseded by a later reconnect
      this._reconnectDelay = RECONNECT_MIN_MS;
      this._setStatus('connected');
      // A reconnect drops the agent's in-memory watcher state; re-arm
      // whatever roots still have callers watching them.
      for (const root of this._watchRefs.keys()) {
        this._request('watch', { root }).catch(() => {});
      }
    }).catch((err) => {
      if (this._proc !== proc) return;
      this._setStatus('unreachable', err.message);
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString('utf8');
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg.event === 'change') {
      this.emit('change', { root: msg.root, path: msg.path });
      return;
    }
    const pending = this._pending.get(msg.id);
    if (!pending) return;

    if (msg.chunk !== undefined) {
      try { pending.onChunk?.(Buffer.from(msg.chunk, 'base64')); } catch (err) { this.log?.error?.(err.message); }
      return; // not terminal — a stream reply ends with an {ok} frame
    }

    clearTimeout(pending.timer);
    this._pending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg);
    } else {
      pending.reject(Object.assign(new Error(msg.error || 'agent error'), { code: msg.code }));
    }
  }

  _handleExit(reason) {
    this._proc = null;
    const err = new Error(`host "${this.host.name}" unreachable`);
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pending.clear();
    if (this._closed) return;
    this._setStatus('unreachable', reason);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closed || this._reconnectTimer) return;
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(delay * 2, RECONNECT_MAX_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay).unref();
  }

  _request(op, params = {}, timeoutMs = REQUEST_TIMEOUT_MS, onChunk) {
    if (!this._proc) {
      return Promise.reject(new Error(`host "${this.host.name}" unreachable`));
    }
    const id = this._nextId++;
    const payload = { id, op, ...params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`host "${this.host.name}" request timed out`));
      }, timeoutMs).unref();
      this._pending.set(id, { resolve, reject, timer, onChunk });
      try {
        this._proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  request(op, params) {
    return this._request(op, params);
  }

  stream(op, params, onChunk) {
    return this._request(op, params, REQUEST_TIMEOUT_MS, onChunk);
  }

  async watch(root) {
    const count = this._watchRefs.get(root) || 0;
    this._watchRefs.set(root, count + 1);
    if (count === 0) {
      await this.request('watch', { root });
    }
  }

  async unwatch(root) {
    const count = this._watchRefs.get(root) || 0;
    if (count <= 1) {
      this._watchRefs.delete(root);
      if (count === 1) {
        try { await this.request('unwatch', { root }); } catch { /* best-effort teardown */ }
      }
    } else {
      this._watchRefs.set(root, count - 1);
    }
  }

  // Deliberate shutdown (host removed, or the operator asked to disconnect):
  // unlike _handleExit, this must NOT schedule a reconnect.
  disconnect() {
    this._closed = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    const err = new Error(`host "${this.host.name}" unreachable`);
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this._pending.clear();
    if (this._proc) {
      try { this._proc.kill(); } catch { /* already dead */ }
      this._proc = null;
    }
  }
}

class HostPool extends EventEmitter {
  constructor({ resolveHost, spawnFn, log } = {}) {
    super();
    this.resolveHost = resolveHost;
    this.spawnFn = spawnFn;
    this.log = log;
    this.agents = new Map();
  }

  // Lazily spawns on first access for a given host id and caches the
  // HostAgent for the life of the process (or until disconnect()/remove()).
  // Returns null if resolveHost doesn't recognize the id (host was deleted).
  get(hostId) {
    let agent = this.agents.get(hostId);
    if (agent) return agent;

    const host = this.resolveHost ? this.resolveHost(hostId) : null;
    if (!host) return null;

    agent = new HostAgent({ host, spawnFn: this.spawnFn, log: this.log });
    agent.on('status', (evt) => this.emit('status', evt));
    agent.on('change', (evt) => this.emit('change', { hostId, ...evt }));
    this.agents.set(hostId, agent);
    // The constructor above already ran _connect(), which sets 'connecting'
    // synchronously — before the listener just attached could ever see it.
    // Relay the agent's current status once by hand so a subscriber wired
    // through get() (rather than watching the agent directly) never misses
    // that first transition.
    this.emit('status', { hostId, name: agent.host.name, status: agent.status });
    return agent;
  }

  // Current status of every host this pool has ever spawned an agent for —
  // "known" here means "eve has touched it", not "relay has it configured".
  statuses() {
    const out = [];
    for (const [hostId, agent] of this.agents) {
      out.push({ hostId, name: agent.host.name, status: agent.status });
    }
    return out;
  }

  // Tears the agent down and drops it from the cache so a later get() spawns
  // fresh rather than resuming a deliberately-closed connection.
  disconnect(hostId) {
    const agent = this.agents.get(hostId);
    if (!agent) return;
    agent.disconnect();
    this.agents.delete(hostId);
  }

  disconnectAll() {
    for (const hostId of [...this.agents.keys()]) this.disconnect(hostId);
  }
}

module.exports = { HostPool, HostAgent };
