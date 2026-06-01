/**
 * SttBrowserBackend - On-device STT using Whisper via transformers.js Web Worker.
 * Manages worker lifecycle, model loading, and transcription requests.
 */
class SttBrowserBackend {
  constructor() {
    this.name = 'browser';
    this.onDevice = true;
    
    this.worker = null;
    this.ready = false;
    this.loading = false;
    this._pendingCallbacks = new Map();
    this._nextId = 0;
    this._onProgress = null;
    this._onReady = null;
    this._onError = null;
  }

  /**
   * Initialize the STT worker and load the Whisper model.
   * @param {Object} options
   * @param {string} [options.model] - HuggingFace model ID
   * @param {string} [options.dtype] - Quantization (q8, fp32)
   * @param {string} [options.device] - Backend (wasm, webgpu)
   * @param {Function} [options.onProgress] - Called with { progress, file }
   * @param {Function} [options.onReady] - Called when model loaded
   * @param {Function} [options.onError] - Called with error message
   */
  async init(options = {}) {
    if (this.ready || this.loading) return;
    this.loading = true;
    this.log = options.log || new NullLogger();
    this._onProgress = options.onProgress || null;
    this._onReady = options.onReady || null;
    this._onError = options.onError || null;

    // Mark the load as in-progress *before* the memory-heavy model load. If Safari
    // OOM-crashes the tab here, the marker survives and VoiceCrashGuard reverts to
    // server on the next load. Cleared on ready or on any caught error below.
    VoiceCrashGuard.beginLoad('stt');

    this.worker = new Worker('stt-worker.js', { type: 'module' });
    this.worker.onmessage = (e) => this._handleMessage(e.data);
    this.worker.onerror = (e) => {
      this.log.error('Worker error:', e.message);
      this.loading = false;
      VoiceCrashGuard.endLoad('stt'); // caught failure, not a crash — let the choice stand
      this._onError?.(e.message);
    };

    this.worker.postMessage({
      type: 'init',
      model: options.model,
      dtype: options.dtype,
      device: options.device,
    });
  }

  /**
   * Transcribe audio. Accepts Float32Array (16kHz mono) directly from VAD.
   * Returns a promise resolving to { text }.
   */
  transcribe(audio) {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error('STT not ready'));
        return;
      }
      const id = this._nextId++;
      this._pendingCallbacks.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'transcribe', audio, id }, [audio.buffer]);
    });
  }

  /**
   * Transcribe a push-to-talk recording blob by decoding to Float32Array.
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
    const float32 = rendered.getChannelData(0);
    return this.transcribe(float32);
  }

  async isAvailable() {
    return true; // Browser backend is always available (model loads on demand)
  }

  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    VoiceCrashGuard.endLoad('stt'); // clean teardown — a crash never reaches here
    this.ready = false;
    this.loading = false;
    for (const [, cb] of this._pendingCallbacks) {
      cb.reject(new Error('STT destroyed'));
    }
    this._pendingCallbacks.clear();
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'init_progress':
        this._onProgress?.({ progress: msg.progress, file: msg.file });
        break;

      case 'ready':
        this.ready = true;
        this.loading = false;
        VoiceCrashGuard.endLoad('stt'); // load completed without crashing
        this.log.info('Model loaded');
        this._onReady?.();
        break;

      case 'transcription': {
        const cb = this._pendingCallbacks.get(msg.id);
        if (cb) {
          this._pendingCallbacks.delete(msg.id);
          cb.resolve({ text: msg.text });
        }
        break;
      }

      case 'error': {
        const errCb = this._pendingCallbacks.get(msg.id);
        if (errCb) {
          this._pendingCallbacks.delete(msg.id);
          errCb.reject(new Error(msg.message));
        } else {
          this.log.error('Worker error:', msg.message);
          VoiceCrashGuard.endLoad('stt'); // caught failure, not a crash
          this._onError?.(msg.message);
        }
        break;
      }
    }
  }
}
