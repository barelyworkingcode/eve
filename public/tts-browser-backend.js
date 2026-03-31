/**
 * TtsBrowserBackend - On-device TTS using kokoro-js via Web Worker.
 * Manages worker lifecycle, model loading, and audio generation.
 */
class TtsBrowserBackend {
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
   * Initialize the TTS worker and load the model.
   * @param {Object} options
   * @param {string} [options.dtype='q8'] - Model quantization (q8, fp32, q4)
   * @param {string} [options.device='wasm'] - Backend (wasm, webgpu)
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

    this.worker = new Worker('tts-worker.js', { type: 'module' });
    this.worker.onmessage = (e) => this._handleMessage(e.data);
    this.worker.onerror = (e) => {
      console.error('[TtsBrowser] Worker error:', e.message);
      this.loading = false;
      this._onError?.(e.message);
    };

    this.worker.postMessage({
      type: 'init',
      dtype: options.dtype || 'q8',
      device: options.device || 'wasm',
    });
  }

  generate(text, voice = 'af_heart') {
    return new Promise((resolve, reject) => {
      if (!this.ready) {
        reject(new Error('TTS not ready'));
        return;
      }
      const id = this._nextId++;
      this._pendingCallbacks.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'generate', text, voice, id });
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
      cb.reject(new Error('TTS destroyed'));
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
        console.log('[TtsBrowser] Model loaded');
        this._onReady?.();
        break;

      case 'audio': {
        const cb = this._pendingCallbacks.get(msg.id);
        if (cb) {
          this._pendingCallbacks.delete(msg.id);
          cb.resolve({ audio: msg.audio, duration: msg.duration });
        }
        break;
      }

      case 'error': {
        const errCb = this._pendingCallbacks.get(msg.id);
        if (errCb) {
          this._pendingCallbacks.delete(msg.id);
          errCb.reject(new Error(msg.message));
        } else {
          console.error('[TtsBrowser] Worker error:', msg.message);
          this._onError?.(msg.message);
        }
        break;
      }
    }
  }
}
