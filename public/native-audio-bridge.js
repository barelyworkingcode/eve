/**
 * NativeAudioBridge - thin JS wrapper over the native EveAudioBridge Capacitor
 * plugin (iOS). When IS_NATIVE_AUDIO, the native AVAudioEngine owns the mic and
 * speaker so a voice conversation keeps running with the screen off.
 *
 * Calls go through window.Capacitor.nativePromise(...) — an internal (non-public)
 * Capacitor API also used by the on-device backends.
 */
class NativeAudioBridge {
  static EVENTS = [
    'onSessionStarted', 'onSessionStopped', 'onListening', 'onSpeechStart',
    'onSpeechEnd', 'onUtterance', 'onSpeaking', 'onPlaybackEnded', 'onLevel',
    'onInterruption', 'onRouteChange', 'onVADMisfire', 'onError', 'onDiagLog',
  ];

  constructor(logger) {
    this.log = logger;
    this.available = IS_NATIVE_AUDIO;
    this._plugin = window.Capacitor?.Plugins?.EveAudioBridge || null;
  }

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

  startSession(mode) { return this._call('startSession', { mode }); }
  stopSession() { return this._call('stopSession'); }
  setMode(mode) { return this._call('setMode', { mode }); }

  startCapture() { return this._call('startCapture'); }
  stopCapture() { return this._call('stopCapture'); }

  // base64 is a server TTS WAV chunk
  enqueueTTS(base64) { return this._call('enqueueTTS', { audio: base64 }); }
  endTTSTurn() { return this._call('endTTSTurn'); }
  stopPlayback() { return this._call('stopPlayback'); }

  playEarcon(name) { return this._call('playEarcon', { name }); }
  startThinkingCue() { return this._call('startThinkingCue'); }
  stopThinkingCue() { return this._call('stopThinkingCue'); }
  haptic(style = 'light') { return this._call('haptic', { style }); }

  getStatus() { return this._call('getStatus'); }

  // VAD/barge-in thresholds live in the native engine, not here
  setTuning(opts = {}) { return this._call('setTuning', opts); }

  // native duck levels track this value
  setAmbientVolume(volume) { return this._call('setAmbientVolume', { volume }); }

  // checks whether a running native AVAudioEngine keeps the WebView alive
  // while the phone is locked
  startKeepaliveProbe() { return this._call('startKeepaliveProbe'); }
  stopKeepaliveProbe() { return this._call('stopKeepaliveProbe'); }

  // drains the native ring buffer, including lines emitted before onDiagLog
  // was subscribed (e.g. the cold-start trace)
  dumpLogs() { return this._call('dumpLogs'); }

  // persists in native UserDefaults across restarts (default off)
  setDiagLogging(enabled) { return this._call('setDiagLogging', { enabled: !!enabled }); }
  getDiagLogging() { return this._call('getDiagLogging'); }

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
