// Browser init script, not a Node module: the e2e `context` fixture and the
// visual capture's own context inject it before any app script runs.
//
// A real AudioContext opens the host's audio output device while it is being
// constructed, and blocks the page's main thread until the device answers.
// On a host whose audio stack is unresponsive that block lasts ~20s, so the
// first click (TTSManager's warm-up) or a restored voice session stalls the
// page past the test's own timeouts. No e2e test asserts on audio output
// (voice.spec.js, which does, launches its own browser), so the suite swaps in
// a context that never touches the device: an OfflineAudioContext, which
// builds the same node graph without an output, reporting itself as running.
(() => {
  class HermeticAudioContext extends OfflineAudioContext {
    constructor(options = {}) {
      super({ numberOfChannels: 2, length: 1, sampleRate: options.sampleRate || 44100 });
      this._hermeticState = 'running';
    }

    get state() { return this._hermeticState; }
    get baseLatency() { return 0; }
    get outputLatency() { return 0; }

    resume() { this._hermeticState = 'running'; return Promise.resolve(); }
    suspend() { this._hermeticState = 'suspended'; return Promise.resolve(); }
    close() { this._hermeticState = 'closed'; return Promise.resolve(); }
  }

  window.AudioContext = HermeticAudioContext;
  window.webkitAudioContext = HermeticAudioContext;
})();
