/**
 * VadManager - Voice Activity Detection using Silero VAD via @ricky0123/vad-web.
 * Provides Float32Array audio at 16kHz to the STT pipeline.
 */
class VadManager {
  constructor() {
    this.micVAD = null;
    this.isListening = false;
    this._destroying = false;
  }

  /**
   * Initialize and start the VAD. Mic permission is requested here.
   * @param {Object} callbacks
   * @param {Function} callbacks.onSpeechStart - Called when user starts speaking
   * @param {Function} callbacks.onSpeechEnd - Called with Float32Array audio (16kHz mono)
   * @param {Function} [callbacks.onVADMisfire] - Called on false positive (too short)
   * @param {Function} [callbacks.onError] - Called if initialization fails
   */
  async start(callbacks) {
    if (this.micVAD) return;
    this._destroying = false;
    if (typeof vad === 'undefined' || !vad.MicVAD) {
      console.error('[VAD] vad-web library not loaded');
      callbacks.onError?.(new Error('Voice detection library failed to load'));
      return;
    }

    try {
      console.log('[VAD] Initializing Silero VAD...');
      this.micVAD = await vad.MicVAD.new({
        positiveSpeechThreshold: 0.45,
        negativeSpeechThreshold: 0.25,
        minSpeechFrames: 2,
        preSpeechPadFrames: 10,
        redemptionFrames: 20, // ~650ms at 30fps before declaring end of speech
        baseAssetPath: '/vad-web/',
        onnxWASMBasePath: '/vad-onnx/',

        onSpeechStart: () => {
          if (this._destroying) return;
          callbacks.onSpeechStart?.();
        },

        onSpeechEnd: (audio) => {
          if (this._destroying) return;
          callbacks.onSpeechEnd?.(audio);
        },

        onVADMisfire: () => {
          if (this._destroying) return;
          callbacks.onVADMisfire?.();
        },
      });

      this.micVAD.start();
      this.isListening = true;
      console.log('[VAD] Started — listening for speech');
    } catch (err) {
      console.error('[VAD] Failed to initialize:', err);
      callbacks.onError?.(err);
    }
  }

  pause() {
    if (this.micVAD && this.isListening) {
      this.micVAD.pause();
      this.isListening = false;
    }
  }

  resume() {
    if (this.micVAD && !this.isListening) {
      this.micVAD.start();
      this.isListening = true;
    }
  }

  destroy() {
    this._destroying = true;
    if (this.micVAD) {
      this.micVAD.destroy();
      this.micVAD = null;
    }
    this.isListening = false;
  }

  /**
   * Encode a Float32Array (16kHz mono) as a WAV and return base64.
   */
  static audioToBase64Wav(float32Audio) {
    const sampleRate = 16000;
    const bytesPerSample = 2;
    const dataLength = float32Audio.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    let offset = 44;
    for (let i = 0; i < float32Audio.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Audio[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }

    // Chunked String.fromCharCode for performance on large buffers
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 8192) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    }
    return btoa(chunks.join(''));
  }
}
