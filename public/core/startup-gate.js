/**
 * The one startup gate. The server pushes `{type:'state'}` frames over the
 * socket: `starting` until eve has the snapshot and relay is up, then `ready`.
 * Tab restore, the cold deep link and Ask all wait here instead of on their own
 * checks. The stall timer is the only timer; its limit is fixed on purpose.
 */
class StartupGate {
  constructor({ bus }) {
    this.bus = bus;
    this._ready = false;
    this._everReady = false;
    this._stalled = false;
    this._timer = null;
    this._hooks = [];
    this._waiters = [];
    this._arm();
  }

  get ready() { return this._ready; }
  get everReady() { return this._everReady; }
  get stalled() { return this._stalled; }

  // hook(frame) runs on each ready frame, in registration order, before `ready` turns true.
  onReady(hook) { this._hooks.push(hook); }

  whenReady() {
    if (this._ready) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  receive(frame) {
    if (!frame || frame.type !== 'state') return;
    if (frame.state === 'starting') {
      this._leaveReady();
    } else if (frame.state === 'ready') {
      this._becomeReady(frame);
    }
  }

  // The socket ended or was replaced: nothing is ready until the new socket says so.
  reset() { this._leaveReady(); }

  _leaveReady() {
    const was = this._ready;
    this._ready = false;
    this._arm();
    if (was) this._emit();
  }

  _becomeReady(frame) {
    for (const hook of this._hooks) {
      try { hook(frame); } catch (err) {
        // A failing hook must not hold the page in "Starting…"; surface it as a page error.
        queueMicrotask(() => { throw err; });
      }
    }
    clearTimeout(this._timer);
    this._timer = null;
    this._ready = true;
    this._everReady = true;
    this._stalled = false;
    this._emit();
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) resolve();
  }

  // Armed once when the gate leaves ready; a reconnect does not restart it.
  _arm() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._ready || this._stalled) return;
      this._stalled = true;
      this._emit();
    }, StartupGate.STALL_MS);
    this._timer.unref?.();
  }

  _emit() {
    this.bus?.emit(EVT.STARTUP_STATE, { state: this._ready ? 'ready' : 'starting', stalled: this._stalled });
  }

  // '' = hidden. First match wins.
  static bannerText({ browser, relay, ready, everReady, stalled }) {
    if (stalled) return "eve isn't responding.";
    if (!browser && everReady) return 'Reconnecting…';
    if (!ready) return 'Starting…';
    if (!browser || !relay) return 'Reconnecting…';
    return '';
  }
}
StartupGate.STALL_MS = 120000;

if (typeof module !== 'undefined' && module.exports) module.exports = StartupGate;
