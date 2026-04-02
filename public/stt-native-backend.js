/**
 * SttNativeBackend - Native STT via Capacitor EveVoice plugin.
 * Audio capture and transcription are handled entirely by the native plugin.
 * Results arrive via Capacitor event listeners managed by this backend.
 */
class SttNativeBackend {
  constructor() {
    this.name = 'native';
    this.onDevice = true;
    
    this.ready = false;
    this.loading = false;
    this._listener = null;
    this._onTranscription = null;
  }

  async init(context) {
    this._app = context.app;
    this.loading = true;

    try {
      console.log('[STT:native] Loading models via EveVoice plugin...');
      await window.Capacitor.nativePromise('EveVoice', 'loadModels', {});
      this.ready = true;
      this.loading = false;
      console.log('[STT:native] Models loaded');
      context.onReady?.();
    } catch (err) {
      this.loading = false;
      console.error('[STT:native] Model loading failed:', err.message);
      context.onError?.(err.message);
    }
  }

  /**
   * Not used in native mode — VAD + STT are handled entirely by the native plugin.
   */
  transcribe() {
    return null;
  }

  /**
   * Not used in native mode — recording is handled by startRecording/stopRecording.
   */
  transcribeBlob() {
    return null;
  }

  /**
   * Start native recording via Capacitor plugin.
   * Models are already loaded from init() — no need to call loadModels again.
   * @param {Function} onTranscription - Called with transcribed text
   */
  async startRecording(onTranscription) {
    this._onTranscription = onTranscription;
    const cap = window.Capacitor;
    this._listener = await cap.addListener('EveVoice', 'transcription', (data) => {
      if (data.isFinal && data.text?.trim()) {
        this._onTranscription?.(data.text.trim());
      }
    });
    await cap.nativePromise('EveVoice', 'startListening', {});
  }

  stopRecording() {
    const cap = window.Capacitor;
    cap?.nativePromise('EveVoice', 'stopListening', {}).catch(() => {});
    this._listener?.remove?.();
    this._listener = null;
  }

  async isAvailable() {
    return true;
  }

  destroy() {
    this.stopRecording();
    this._app = null;
  }
}
