/**
 * NativeAudioBridge - thin JS wrapper over the native EveAudioBridge Capacitor
 * plugin (iOS). When IS_NATIVE_AUDIO, the native AVAudioEngine owns the mic and
 * speaker so a voice conversation keeps running with the screen off; JS stays
 * the orchestrator (WebSocket, transcribe_audio, forwarding TTS frames, UI).
 *
 * Methods are invoked with window.Capacitor.nativePromise(...) — the same valid
 * Capacitor 8 internal API the on-device backends use (tts-native-backend.js).
 * Native → JS events arrive via Capacitor.Plugins.EveAudioBridge.addListener.
 *
 * No-op (available === false) on every non-native surface, so callers can guard
 * on `IS_NATIVE_AUDIO` and never branch on platform internals.
 */
class NativeAudioBridge {
  static EVENTS = [
    'onSessionStarted', 'onSessionStopped', 'onListening', 'onSpeechStart',
    'onSpeechEnd', 'onUtterance', 'onSpeaking', 'onPlaybackEnded', 'onLevel',
    'onInterruption', 'onRouteChange', 'onVADMisfire', 'onError',
  ];

  constructor(logger) {
    this.log = logger;
    this.available = IS_NATIVE_AUDIO;
    this._plugin = window.Capacitor?.Plugins?.EveAudioBridge || null;
  }

  /** Subscribe to native events. `handlers` maps event name → callback(data). */
  init(handlers) {
    if (!this.available || !this._plugin) return;
    for (const ev of NativeAudioBridge.EVENTS) {
      this._plugin.addListener(ev, (data) => {
        try { handlers[ev]?.(data || {}); }
        catch (err) { this.log?.error(`native ${ev} handler failed:`, err); }
      });
    }
    this.log?.info('Native audio bridge wired');
  }

  // mode: 'handsfree' | 'ptt'
  startSession(mode) { return this._call('startSession', { mode }); }
  stopSession() { return this._call('stopSession'); }
  setMode(mode) { return this._call('setMode', { mode }); }

  // push-to-talk
  startCapture() { return this._call('startCapture'); }
  stopCapture() { return this._call('stopCapture'); }

  // playback — base64 is a server TTS WAV chunk
  enqueueTTS(base64) { return this._call('enqueueTTS', { audio: base64 }); }
  endTTSTurn() { return this._call('endTTSTurn'); }
  stopPlayback() { return this._call('stopPlayback'); }

  // eyes-free feedback
  playEarcon(name) { return this._call('playEarcon', { name }); }
  haptic(style = 'light') { return this._call('haptic', { style }); }

  getStatus() { return this._call('getStatus'); }

  // diagnostic: silent background-audio hold (see voice-bg-spike.js)
  startKeepaliveProbe() { return this._call('startKeepaliveProbe'); }
  stopKeepaliveProbe() { return this._call('stopKeepaliveProbe'); }

  _call(method, args = {}) {
    if (!this.available) return Promise.resolve();
    return window.Capacitor.nativePromise('EveAudioBridge', method, args)
      .catch((err) => { this.log?.warn(`native ${method} failed:`, err?.message || err); });
  }
}

// Export for Node-side tests; harmless in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NativeAudioBridge;
}
