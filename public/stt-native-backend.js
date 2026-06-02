/**
 * SttNativeBackend - Native STT via Capacitor EveVoice plugin.
 * Follows the same pattern as SttBrowserBackend:
 *   - transcribe(audio) accepts Float32Array, returns { text }
 *   - transcribeBlob(blob) decodes to Float32 then calls transcribe()
 * Audio capture and VAD are handled by JS — this backend only transcribes.
 */
class SttNativeBackend {
  constructor() {
    this.name = 'native';
    this.onDevice = true;

    this.ready = false;
    this.loading = false;
  }

  async init(context) {
    this.loading = true;
    this.log = context.log || new NullLogger();

    // Mark the load durable *before* it begins: the native Parakeet download runs
    // in the app process, so an out-of-memory load can kill the whole app before
    // any catch below runs. If the marker survives a relaunch, VoiceCrashGuard
    // reverts the backend to 'server' instead of crash-looping. See voice-crash-guard.js.
    VoiceCrashGuard.beginLoad('stt');
    try {
      this.log.info('Loading models via EveVoice plugin...');
      await window.Capacitor.nativePromise('EveVoice', 'loadSTTModels', {});
      this.ready = true;
      this.loading = false;
      VoiceCrashGuard.endLoad('stt');
      this.log.info('Models loaded');
      context.onReady?.();
    } catch (err) {
      this.loading = false;
      VoiceCrashGuard.endLoad('stt');
      this.log.error('Model loading failed:', err.message);
      context.onError?.(err.message);
    }
  }

  /**
   * Transcribe Float32Array audio (16kHz mono) via native ASR engine.
   * Returns { text } — same contract as SttBrowserBackend.transcribe().
   */
  async transcribe(audio) {
    if (!this.ready) throw new Error('STT not ready');

    // Encode Float32Array as base64 for Capacitor bridge
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);

    const result = await window.Capacitor.nativePromise('EveVoice', 'transcribe', { audio: base64 });
    return { text: result.text };
  }

  /**
   * Transcribe a push-to-talk recording blob by decoding to Float32Array.
   * Same approach as SttBrowserBackend.transcribeBlob().
   */
  async transcribeBlob(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new OfflineAudioContext(1, 1, 16000);
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start();
    const rendered = await offlineCtx.startRendering();
    return this.transcribe(rendered.getChannelData(0));
  }

  async isAvailable() {
    return true;
  }

  destroy() {}
}
