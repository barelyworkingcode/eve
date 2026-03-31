/**
 * SttBrowserBackend - On-device STT using Whisper via transformers.js Web Worker.
 * Manages worker lifecycle, model loading, and transcription requests.
 */
class SttBrowserBackend {
  constructor() {
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
    this._onProgress = options.onProgress || null;
    this._onReady = options.onReady || null;
    this._onError = options.onError || null;

    this.worker = new Worker('stt-worker.js', { type: 'module' });
    this.worker.onmessage = (e) => this._handleMessage(e.data);
    this.worker.onerror = (e) => {
      console.error('[SttBrowser] Worker error:', e.message);
      this.loading = false;
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

  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
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
        console.log('[SttBrowser] Model loaded');
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
          console.error('[SttBrowser] Worker error:', msg.message);
          this._onError?.(msg.message);
        }
        break;
      }
    }
  }
}
