/**
 * TtsNativeBackend - Native TTS via Capacitor EveVoice plugin.
 * Uses the Kokoro voice IDs — same as server/browser backends.
 */

// Shared fallback voice list (also used by TtsServerBackend when daemon is offline)
const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'F' },
  { id: 'af_bella', name: 'Bella', lang: 'American English', gender: 'F' },
  { id: 'af_nicole', name: 'Nicole', lang: 'American English', gender: 'F' },
  { id: 'af_nova', name: 'Nova', lang: 'American English', gender: 'F' },
  { id: 'af_sarah', name: 'Sarah', lang: 'American English', gender: 'F' },
  { id: 'af_sky', name: 'Sky', lang: 'American English', gender: 'F' },
  { id: 'am_adam', name: 'Adam', lang: 'American English', gender: 'M' },
  { id: 'am_echo', name: 'Echo', lang: 'American English', gender: 'M' },
  { id: 'am_eric', name: 'Eric', lang: 'American English', gender: 'M' },
  { id: 'am_michael', name: 'Michael', lang: 'American English', gender: 'M' },
  { id: 'bf_emma', name: 'Emma', lang: 'British English', gender: 'F' },
  { id: 'bf_lily', name: 'Lily', lang: 'British English', gender: 'F' },
  { id: 'bm_daniel', name: 'Daniel', lang: 'British English', gender: 'M' },
  { id: 'bm_george', name: 'George', lang: 'British English', gender: 'M' },
];

class TtsNativeBackend {
  constructor() {
    this.name = 'native';
    this.onDevice = true;
    
    this.ready = false;
    this.loading = false;
  }

  async init(context) {
    this.loading = true;
    this.log = context.log || new NullLogger();

    // Mark the load durable *before* it begins: the native Kokoro download runs
    // in the app process, so an out-of-memory load can kill the whole app before
    // any catch below runs. If the marker survives a relaunch, VoiceCrashGuard
    // reverts the backend to 'server' instead of crash-looping. See voice-crash-guard.js.
    VoiceCrashGuard.beginLoad('tts');
    try {
      // loadModels is shared between STT and TTS — idempotent if already loaded.
      this.log.info('Loading models via EveVoice plugin...');
      await window.Capacitor.nativePromise('EveVoice', 'loadModels', {});
      this.ready = true;
      this.loading = false;
      VoiceCrashGuard.endLoad('tts');
      this.log.info('Models loaded');
      context.onReady?.();
    } catch (err) {
      this.loading = false;
      VoiceCrashGuard.endLoad('tts');
      this.log.error('Model loading failed:', err.message);
      context.onError?.(err.message);
    }
  }

  /**
   * Speak text via the native Capacitor plugin.
   * Returns { audio: base64, duration } — same contract as TtsBrowserBackend.
   * JS handles playback via AudioContext (standard path).
   */
  async speakText(text, voice) {
    const result = await window.Capacitor.nativePromise('EveVoice', 'speak', { text, voice });
    return { audio: result.audio, duration: result.duration };
  }

  /**
   * Return the static voice list — native uses the same Kokoro voice IDs.
   */
  async loadVoices() {
    return KOKORO_VOICES;
  }

  async isAvailable() {
    return true;
  }

  destroy() {}
}
