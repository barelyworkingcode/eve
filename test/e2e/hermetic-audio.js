// Browser init script, not a Node module: the e2e `context` fixture and the
// visual capture's own context inject it before any app script runs.
//
// A real AudioContext opens the host's audio output device while it is being
// constructed, and blocks the page's main thread until the device answers.
// On a host whose audio stack is unresponsive that block lasts ~20s, so the
// first click (TTSManager's warm-up) or a restored voice session stalls the
// page past the test's own timeouts. No e2e test asserts on audio output, so
// the suite swaps in a context that never touches the device: an
// OfflineAudioContext reporting itself as running.
//
// Deliberately partial. There is no mic path (createMediaStreamSource and
// friends don't exist on an OfflineAudioContext, so STT/VAD setup throws) and
// playback never finishes (nothing renders, so a source's onended never
// fires). A test that needs either must use real audio, as test:voice does.
(() => {
  class HermeticAudioContext extends OfflineAudioContext {
    constructor(options = {}) {
      super({ numberOfChannels: 2, length: 1, sampleRate: options.sampleRate || 44100 });
      this._hermeticState = 'running';
    }

    get state() { return this._hermeticState; }
    get baseLatency() { return 0; }
    get outputLatency() { return 0; }

    resume() { return this._setState('running'); }
    suspend() { return this._setState('suspended'); }
    close() { this._hermeticState = 'closed'; return Promise.resolve(); }

    _setState(next) {
      if (this._hermeticState === 'closed') {
        return Promise.reject(new DOMException('AudioContext is closed', 'InvalidStateError'));
      }
      this._hermeticState = next;
      return Promise.resolve();
    }
  }

  window.AudioContext = HermeticAudioContext;
  window.webkitAudioContext = HermeticAudioContext;
})();
