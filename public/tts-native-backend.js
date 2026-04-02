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
    this.requiresModelLoad = true;
    this.clientSideTTS = true;
    this.ready = false;
    this.loading = false;
  }

  async init(context) {
    this.loading = true;

    try {
      // loadModels is shared between STT and TTS — idempotent if already loaded.
      console.log('[TTS:native] Loading models via EveVoice plugin...');
      await window.Capacitor.nativePromise('EveVoice', 'loadModels', {});
      this.ready = true;
      this.loading = false;
      console.log('[TTS:native] Models loaded');
      context.onReady?.();
    } catch (err) {
      this.loading = false;
      console.error('[TTS:native] Model loading failed:', err.message);
      context.onError?.(err.message);
    }
  }

  /**
   * Speak text via the native Capacitor plugin.
   * Returns void — native plugin handles playback directly.
   */
  async speakText(text, voice) {
    await window.Capacitor.nativePromise('EveVoice', 'speak', { text, voice });
    return null;
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
