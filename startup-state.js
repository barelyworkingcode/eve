// One per browser socket. Tells the page whether eve is ready: socket
// authenticated, relay upstream open, and the projects + sessions snapshot
// answered. See docs/api.md, the `state` frame.
class StartupState {
  constructor({ loadSnapshot, send, log }) {
    this._loadSnapshot = loadSnapshot;
    this._send = send;
    this._log = log;
    this._state = 'starting';
    this._announced = false;
    this._upstream = false;
    this._closed = false;
    this._generation = 0;
    this._loading = false;
  }

  get state() { return this._state; }

  announce() {
    if (this._announced || this._closed) return;
    this._announced = true;
    this._emit({ type: 'state', state: 'starting' });
    this._maybeLoad();
  }

  upstreamOpen() {
    this._upstream = true;
    this._maybeLoad();
  }

  upstreamClosed() {
    this._upstream = false;
    this._generation++;
    this._loading = false;
    if (this._state === 'ready' && !this._closed) {
      this._state = 'starting';
      this._emit({ type: 'state', state: 'starting' });
    }
  }

  close() {
    this._closed = true;
    this._generation++;
    this._loading = false;
  }

  _maybeLoad() {
    if (!this._announced || !this._upstream || this._closed || this._loading || this._state === 'ready') return;
    this._loading = true;
    const generation = this._generation;
    this._loadSnapshot().then((snapshot) => {
      if (generation !== this._generation || this._closed || !this._announced || !this._upstream) return;
      this._loading = false;
      this._state = 'ready';
      this._emit({ type: 'state', state: 'ready', projects: snapshot.projects, sessions: snapshot.sessions });
    }, (err) => {
      if (generation !== this._generation) return;
      this._loading = false;
      this._log?.warn('Startup snapshot failed', { op: 'startup.snapshot', error: err?.message });
    });
  }

  _emit(frame) {
    this._log?.info(`Startup state: ${frame.state}`, { op: 'startup.state', state: frame.state });
    this._send(frame);
  }
}

module.exports = StartupState;
