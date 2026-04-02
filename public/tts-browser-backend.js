/**
 * TtsBrowserBackend - On-device TTS using kokoro-js via Web Worker.
 * Manages worker lifecycle, model loading, and audio generation.
 *
 * Lazy initialization: worker is only created on first speakText() call.
 * Idle teardown: worker is terminated after IDLE_TIMEOUT_MS of inactivity,
 * then re-created on next use.
 */
class TtsBrowserBackend {
  constructor() {
    this.name = 'browser';
    this.requiresModelLoad = true;
    this.clientSideTTS = true;
    this.worker = null;
    this.ready = false;
    this.loading = false;
    this._pendingCallbacks = new Map();
    this._nextId = 0;
    this._onProgress = null;
    this._onReady = null;
    this._onError = null;
    this._initOptions = null;
    this._readyPromiseResolvers = [];
  }

  /**
   * Store init options for lazy worker creation.
   * Worker is NOT created here — deferred to first speakText() call.
   * @param {Object} options
   * @param {string} [options.dtype='q4'] - Model quantization (q4, q8, fp32)
   * @param {string} [options.device='wasm'] - Backend (wasm, webgpu)
   * @param {Function} [options.onProgress] - Called with { progress, file }
   * @param {Function} [options.onReady] - Called when model loaded
   * @param {Function} [options.onError] - Called with error message
   */
  init(options = {}) {
    this._initOptions = options;
    this._onProgress = options.onProgress || null;
    this._onReady = options.onReady || null;
    this._onError = options.onError || null;
    // Start loading immediately (eager init for startup overlay)
    this._ensureWorker();
  }

  /**
   * Ensure the worker is running and model is loaded. Creates worker on first call.
   * Returns a promise that resolves when the backend is ready.
   */
  async _ensureWorker() {
    if (this.ready) return;

    if (this.loading) {
      // Already loading — wait for it
      return new Promise((resolve) => this._readyPromiseResolvers.push(resolve));
    }

    this.loading = true;
    const opts = this._initOptions || {};
    console.log(`[TTS:browser] Loading on-device model (dtype=${opts.dtype || 'q4'}, device=${opts.device || 'wasm'})...`);

    this.worker = new Worker('tts-worker.js', { type: 'module' });
    this.worker.onmessage = (e) => this._handleMessage(e.data);
    this.worker.onerror = (e) => {
      console.error('[TTS:browser] Worker error:', e.message);
      this.loading = false;
      this._onError?.(e.message);
    };

    this.worker.postMessage({
      type: 'init',
      dtype: opts.dtype || 'q4',
      device: opts.device || 'wasm',
    });

    return new Promise((resolve) => this._readyPromiseResolvers.push(resolve));
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

  /**
   * Generate audio for text. Ensures worker is loaded first (lazy init).
   * Returns { audio: base64, duration }.
   */
  async speakText(text, voice) {
    await this._ensureWorker();
    return this.generate(text, voice);
  }

  async loadVoices() {
    return KOKORO_VOICES; // Browser uses same voice IDs as native/server
  }

  async isAvailable() {
    return true;
  }

  /**
   * Terminate the worker but keep the backend alive for re-init.
   * Called by TTSManager on idle timeout.
   */
  destroyWorker() {
    if (this.worker) {
      console.log('[TTS:browser] Terminating idle worker');
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.loading = false;
    for (const [, cb] of this._pendingCallbacks) {
      cb.reject(new Error('TTS worker terminated'));
    }
    this._pendingCallbacks.clear();
  }

  destroy() {
    this.destroyWorker();
    this._initOptions = null;
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'init_progress':
        this._onProgress?.({ progress: msg.progress, file: msg.file });
        break;

      case 'ready':
        this.ready = true;
        this.loading = false;
        console.log('[TTS:browser] On-device model loaded and ready');
        this._onReady?.();
        // Resolve all waiting promises
        for (const resolve of this._readyPromiseResolvers) resolve();
        this._readyPromiseResolvers = [];
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
          console.error('[TTS:browser] Worker error:', msg.message);
          this._onError?.(msg.message);
        }
        break;
      }
    }
  }
}
