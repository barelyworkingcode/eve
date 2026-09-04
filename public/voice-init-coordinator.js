/**
 * VoiceInitCoordinator - starts TTS/STT on server for immediate availability, then
 * preloads the user's preferred on-device backend in shadow instances and switches
 * the real managers over once ready.
 */
class VoiceInitCoordinator {
  constructor(container) {
    this.bus = container.get('bus');
    this.log = container.get('logger').child('VoiceInit');
    this.container = container;

    this._toastId = 'voice-init';
    this._ttsTarget = null;
    this._sttTarget = null;
    this._ttsShadow = null;
    this._sttShadow = null;
    this._ttsReady = false;
    this._sttReady = false;
    this._ttsProgress = 0;
    this._sttProgress = 0;
    this._serializeNativeLoads = false;
  }

  init() {
    this.evaluate();
  }

  // called on startup and when the settings dialog closes
  evaluate() {
    const tts = this.container.get('ttsManager');
    const stt = this.container.get('sttManager');

    const ttsTarget = tts.preferredBackend !== 'server' ? tts.preferredBackend : null;
    const sttTarget = stt.preferredBackend !== 'server' ? stt.preferredBackend : null;

    if (this._ttsShadow && this._ttsTarget !== ttsTarget) {
      this._ttsShadow.destroy();
      this._ttsShadow = null;
      this._ttsReady = false;
      this._ttsProgress = 0;
    }

    if (this._sttShadow && this._sttTarget !== sttTarget) {
      this._sttShadow.destroy();
      this._sttShadow = null;
      this._sttReady = false;
      this._sttProgress = 0;
    }

    this._ttsTarget = ttsTarget;
    this._sttTarget = sttTarget;

    if (!ttsTarget && !sttTarget) {
      this.bus.emit(EVT.TOAST_DISMISS, { id: this._toastId });
      return;
    }

    // the real manager may have already switched on its own (e.g. fallback logic)
    if (ttsTarget && tts.backend === ttsTarget && tts.activeBackend.ready) {
      this._ttsReady = true;
    }
    if (sttTarget && stt.backend === sttTarget && stt.activeBackend.ready) {
      this._sttReady = true;
    }

    if (this._isDone()) {
      this._finalize();
      return;
    }

    this.bus.emit(EVT.TOAST_SHOW, {
      id: this._toastId,
      message: 'Preparing on-device voice models…',
      type: 'info',
      progress: 0,
      persistent: true,
    });

    // Native model downloads run in the app process, so loading both at once can
    // exhaust memory and crash the app on constrained iOS devices; when both
    // targets are native, defer STT until TTS settles.
    this._serializeNativeLoads = ttsTarget === 'native' && sttTarget === 'native';

    if (ttsTarget && !this._ttsReady && !this._ttsShadow) {
      this._preloadTTS(ttsTarget);
    }
    if (!this._serializeNativeLoads) {
      this._startSTTPreload();
    }
  }

  _startSTTPreload() {
    if (this._sttTarget && !this._sttReady && !this._sttShadow) {
      this._preloadSTT(this._sttTarget);
    }
  }

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
        if (which === 'tts') {
          this._ttsReady = true;
          if (this._serializeNativeLoads) this._startSTTPreload();
        } else {
          this._sttReady = true;
        }
        this._checkAllReady();
      },
      onError: (msg) => {
        this.log.error(`${which.toUpperCase()} preload failed:`, msg);
        if (which === 'tts') {
          this._ttsTarget = null;
          this._ttsShadow?.destroy();
          this._ttsShadow = null;
          if (this._serializeNativeLoads) this._startSTTPreload();
        } else {
          this._sttTarget = null;
          this._sttShadow?.destroy();
          this._sttShadow = null;
        }
        this._checkAllReady();
      },
    };

    return context;
  }

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
    this._ttsShadow?.destroy();
    this._sttShadow?.destroy();
    this._ttsShadow = null;
    this._sttShadow = null;

    const tts = this.container.get('ttsManager');
    const stt = this.container.get('sttManager');

    this.bus.emit(EVT.TOAST_UPDATE, {
      id: this._toastId,
      message: 'Ready — switching to on-device',
      progress: 100,
      type: 'success',
    });

    // Models are already cached from preload, so this re-init is fast.
    if (this._ttsTarget && tts.backend !== this._ttsTarget) {
      tts.switchBackend(this._ttsTarget, { persist: true });
    }
    if (this._sttTarget && stt.backend !== this._sttTarget) {
      stt.switchBackend(this._sttTarget, { persist: true });
    }

    setTimeout(() => {
      this.bus.emit(EVT.TOAST_DISMISS, { id: this._toastId });
    }, 1500);
  }
}
