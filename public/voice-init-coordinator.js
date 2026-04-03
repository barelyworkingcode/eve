/**
 * VoiceInitCoordinator - Manages the "start on server, preload desired backend, switch when ready" strategy.
 *
 * All TTS/STT modes start on server for immediate availability. If the user prefers a non-server
 * backend (browser or native), the coordinator creates shadow backend instances to preload models
 * in the background. When ready, it destroys the shadows and switches the real managers.
 *
 * Progress is reported via a single persistent toast that tracks both TTS and STT combined.
 * Re-evaluates on settings dialog close to handle preference changes.
 */
class VoiceInitCoordinator {
  constructor(container) {
    this.bus = container.get('bus');
    this.container = container;

    this._toastId = 'voice-init';
    this._ttsTarget = null;   // 'browser' | 'native' | null
    this._sttTarget = null;
    this._ttsShadow = null;   // shadow backend instance
    this._sttShadow = null;
    this._ttsReady = false;
    this._sttReady = false;
    this._ttsProgress = 0;
    this._sttProgress = 0;
  }

  init() {
    this.evaluate();
  }

  /**
   * Evaluate current preferences and start/abort preloading as needed.
   * Called on startup and when settings dialog closes.
   */
  evaluate() {
    const tts = this.container.get('ttsManager');
    const stt = this.container.get('sttManager');

    const ttsTarget = tts.preferredBackend !== 'server' ? tts.preferredBackend : null;
    const sttTarget = stt.preferredBackend !== 'server' ? stt.preferredBackend : null;

    // Abort stale TTS shadow if target changed
    if (this._ttsShadow && this._ttsTarget !== ttsTarget) {
      this._ttsShadow.destroy();
      this._ttsShadow = null;
      this._ttsReady = false;
      this._ttsProgress = 0;
    }

    // Abort stale STT shadow if target changed
    if (this._sttShadow && this._sttTarget !== sttTarget) {
      this._sttShadow.destroy();
      this._sttShadow = null;
      this._sttReady = false;
      this._sttProgress = 0;
    }

    this._ttsTarget = ttsTarget;
    this._sttTarget = sttTarget;

    // Nothing to preload — dismiss any existing toast and return
    if (!ttsTarget && !sttTarget) {
      this.bus.emit(EVT.TOAST_DISMISS, { id: this._toastId });
      return;
    }

    // If the real manager already switched (e.g. fallback logic), mark as ready
    if (ttsTarget && tts.backend === ttsTarget && tts.activeBackend.ready) {
      this._ttsReady = true;
    }
    if (sttTarget && stt.backend === sttTarget && stt.activeBackend.ready) {
      this._sttReady = true;
    }

    // Check if already done
    if (this._isDone()) {
      this._finalize();
      return;
    }

    // Show toast
    this.bus.emit(EVT.TOAST_SHOW, {
      id: this._toastId,
      message: 'Preparing on-device voice models…',
      type: 'info',
      progress: 0,
      persistent: true,
    });

    // Start shadow preloading for targets not yet ready/loading
    if (ttsTarget && !this._ttsReady && !this._ttsShadow) {
      this._preloadTTS(ttsTarget);
    }
    if (sttTarget && !this._sttReady && !this._sttShadow) {
      this._preloadSTT(sttTarget);
    }
  }

  // --- Shadow preloading ---

  _preloadTTS(target) {
    const shadow = this._createBackend('tts', target);
    if (!shadow) return;

    this._ttsShadow = shadow;
    const context = this._buildContext('tts', target);
    shadow.init(context);
  }

  _preloadSTT(target) {
    const shadow = this._createBackend('stt', target);
    if (!shadow) return;

    this._sttShadow = shadow;
    const context = this._buildContext('stt', target);
    shadow.init(context);
  }

  _createBackend(which, target) {
    if (target === 'browser') {
      return which === 'tts' ? new TtsBrowserBackend() : new SttBrowserBackend();
    }
    if (target === 'native') {
      return which === 'tts' ? new TtsNativeBackend() : new SttNativeBackend();
    }
    return null;
  }

  _buildContext(which, target) {
    const context = {
      onProgress: (data) => {
        const pct = Math.round(data.progress || 0);
        if (which === 'tts') this._ttsProgress = pct;
        else this._sttProgress = pct;
        this._updateToast();
      },
      onReady: () => {
        if (which === 'tts') this._ttsReady = true;
        else this._sttReady = true;
        this._checkAllReady();
      },
      onError: (msg) => {
        console.error(`[VoiceInit] ${which.toUpperCase()} preload failed:`, msg);
        if (which === 'tts') {
          this._ttsTarget = null;
          this._ttsShadow?.destroy();
          this._ttsShadow = null;
        } else {
          this._sttTarget = null;
          this._sttShadow?.destroy();
          this._sttShadow = null;
        }
        this._checkAllReady();
      },
    };

    // Browser-specific init options
    if (target === 'browser') {
      const hasWebGPU = !!navigator.gpu;
      if (which === 'tts') {
        context.dtype = hasWebGPU ? 'fp32' : 'q4';
        context.device = hasWebGPU ? 'webgpu' : 'wasm';
      } else {
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        context.model = isMobile ? 'onnx-community/whisper-base' : 'onnx-community/whisper-small';
        context.dtype = hasWebGPU ? 'fp32' : 'q8';
        context.device = hasWebGPU ? 'webgpu' : 'wasm';
      }
    }

    return context;
  }

  // --- Progress & completion ---

  _updateToast() {
    const hasTTS = !!this._ttsTarget;
    const hasSTT = !!this._sttTarget;
    if (!hasTTS && !hasSTT) return;

    let combined;
    if (hasTTS && hasSTT) {
      combined = Math.round((this._ttsProgress + this._sttProgress) / 2);
    } else {
      combined = hasTTS ? this._ttsProgress : this._sttProgress;
    }

    const message = combined >= 95
      ? 'Compiling models…'
      : `Downloading voice models… ${combined}%`;

    this.bus.emit(EVT.TOAST_UPDATE, {
      id: this._toastId,
      message,
      progress: combined,
    });
  }

  _isDone() {
    const ttsOk = !this._ttsTarget || this._ttsReady;
    const sttOk = !this._sttTarget || this._sttReady;
    return ttsOk && sttOk;
  }

  _checkAllReady() {
    if (!this._isDone()) {
      this._updateToast();
      return;
    }
    this._finalize();
  }

  _finalize() {
    // Destroy shadow backends (free workers/memory)
    this._ttsShadow?.destroy();
    this._sttShadow?.destroy();
    this._ttsShadow = null;
    this._sttShadow = null;

    const tts = this.container.get('ttsManager');
    const stt = this.container.get('sttManager');

    // Show success toast
    this.bus.emit(EVT.TOAST_UPDATE, {
      id: this._toastId,
      message: 'Ready — switching to on-device',
      progress: 100,
      type: 'success',
    });

    // Switch real managers to preferred backends (models are cached, re-init is fast)
    if (this._ttsTarget && tts.backend !== this._ttsTarget) {
      tts.switchBackend(this._ttsTarget, { persist: true });
    }
    if (this._sttTarget && stt.backend !== this._sttTarget) {
      stt.switchBackend(this._sttTarget, { persist: true });
    }

    // Auto-dismiss toast after 1.5s
    setTimeout(() => {
      this.bus.emit(EVT.TOAST_DISMISS, { id: this._toastId });
    }, 1500);
  }
}
