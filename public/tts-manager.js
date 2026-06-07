/**
 * TTSManager - Audio playback and voice mode orchestrator.
 * Delegates speech generation and voice loading to a pluggable backend (browser, server, or native).
 * Owns shared concerns: audio playback queue, AudioContext, voice select UI, speaking indicator.
 *
 * Idle worker management: browser backend worker is terminated after 5 minutes of inactivity,
 * then lazily re-created on next speakText() call.
 */
const DEFAULT_TTS_VOICE = 'af_heart';
const TTS_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class TTSManager {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.bus = container.get('bus');
    this._logger = container.get('logger');
    this.enabled = false;
    this.voice = localStorage.getItem('eve-voice-preset') || DEFAULT_TTS_VOICE;
    this.voices = [];
    this.audioContext = null;
    this.queue = [];
    this.isPlaying = false;
    this.currentSource = null;
    this.isNativeApp = IS_NATIVE_APP;
    this._idleTimer = null;
    this._ttsDoneReceived = true;

    // Native on-device Kokoro is unreliable on iOS 26.5.1 — an upstream
    // FluidAudio/CoreML BNNS segfault crashes synthesis within ~1-2 utterances.
    // The server backend is the same Kokoro-82M model/voice/quality (served by
    // the local daemon) and rock-solid, so the native app defaults to 'server'.
    // On-device is opt-in: selected only if the user explicitly chooses 'native'
    // in Settings (persisted). 'server' is also VoiceCrashGuard's post-crash
    // fallback. Revisit the default if the BNNS bug is fixed upstream/in iOS.
    this.preferredBackend = IS_NATIVE_APP
      ? (localStorage.getItem('eve-tts-backend') === 'native' ? 'native' : 'server')
      : (localStorage.getItem('eve-tts-backend') || (IS_SAFARI ? 'server' : 'browser'));
    // Always start on server — VoiceInitCoordinator switches to preferred when ready
    this.activeBackend = this._createBackend('server');
    this.log = this._logger.child(`TTS:${this.activeBackend.name}`);
    this.log.info(`Starting (preferred: ${this.preferredBackend})`);
  }

  get backend() {
    return this.activeBackend.name;
  }

  get browserReady() {
    return this.activeBackend.name === 'browser' && this.activeBackend.ready;
  }

  /** Whether server-side TTS relay should be active. */
  get useServerTTS() {
    return this.activeBackend.name === 'server';
  }

  _createBackend(name) {
    switch (name) {
      case 'native': return new TtsNativeBackend();
      case 'browser': return new TtsBrowserBackend();
      case 'server':
      default: return new TtsServerBackend();
    }
  }

  init() {
    this._initBackend();
    this._updateVoiceSelectVisibility();
    this.loadVoices();
    this.log.info(`Init — enabled: ${this.enabled}, voice: ${this.voice || 'default'}, backend: ${this.backend}`);

    // Unlock audio output on the first user gesture (iOS autoplay policy).
    // Per-trigger unlockAudio() calls (play button, voice toggle) handle the
    // case where iOS re-suspends the context after this one-shot warm-up.
    const warmUp = () => {
      this.unlockAudio();
      document.removeEventListener('click', warmUp, true);
      document.removeEventListener('touchstart', warmUp, true);
      document.removeEventListener('keydown', warmUp, true);
    };
    document.addEventListener('click', warmUp, true);
    document.addEventListener('touchstart', warmUp, true);
    document.addEventListener('keydown', warmUp, true);
  }

  _initBackend() {
    const context = {
      app: this.app,
      log: this.log,
      onProgress: (data) => {
        if (this.activeBackend.ready) return;
        const pct = Math.round(data.progress || 0);
        this.app.voiceChatManager?._setPrompt(`Loading TTS model: ${pct}%`);
      },
      onReady: () => {
        this.log.info('Backend ready');
        this.bus.emit(EVT.VOICE_BACKEND_CHANGED);
      },
      onError: (msg) => {
        this.log.error('Backend failed:', msg);
        this.app.messageRenderer?.appendSystemMessage('On-device TTS failed to load — falling back to server.', 'warning');
        this.switchBackend('server', { persist: false });
      },
    };

    if (this.activeBackend.name === 'browser') {
      // WebGPU + fp32 for capable devices, q4/wasm fallback.
      // Mobile Safari can't handle on-device TTS (memory limits) — uses native or server backend.
      const useWebGPU = !!navigator.gpu;
      context.dtype = useWebGPU ? 'fp32' : 'q4';
      context.device = useWebGPU ? 'webgpu' : 'wasm';
    }

    this.activeBackend.init(context);
  }

  switchBackend(name, { persist = true } = {}) {
    const prev = this.activeBackend.name;
    this._clearIdleTimer();
    this.activeBackend.destroy();
    this.activeBackend = this._createBackend(name);
    if (persist) {
      localStorage.setItem('eve-tts-backend', name);
      this.preferredBackend = name;
    }
    this._initBackend();

    // Stop current playback — old backend's audio shouldn't keep playing
    this.stop();

    // Sync server voice mode: disable if leaving server, enable if joining server
    const ws = this.app.wsClient;
    if (prev === 'server' && name !== 'server') {
      ws.send({ type: 'voice_mode', enabled: false });
    } else if (prev !== 'server' && name === 'server' && this.enabled) {
      this.syncVoiceMode(ws);
    }

    this.log = this._logger.child(`TTS:${name}`);
    this.log.info(`Switched from ${prev}`);
    this.bus.emit(EVT.VOICE_BACKEND_CHANGED);

    // Reload voices from new backend
    this.loadVoices();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.stop();
    this._updateVoiceSelectVisibility();
    this.log.info(enabled ? `Active — voice: ${this.voice || 'default'}, backend: ${this.backend}` : 'Disabled');
  }

  setVoice(voiceId) {
    this.voice = voiceId;
    localStorage.setItem('eve-voice-preset', voiceId);
    if (this.enabled) this.log.info(`Voice changed → ${voiceId}`);
  }

  setBackend(name) {
    this.switchBackend(name);
    this.log.info(`Backend changed → ${name}`);
  }

  /** Send voice_mode state to server if using server TTS backend. */
  syncVoiceMode(ws) {
    this.activeBackend.syncVoiceMode?.(ws, this.enabled, this.voice);
  }

  // --- Voice loading (delegated to backend) ---

  async loadVoices() {
    try {
      this.voices = await this.activeBackend.loadVoices();
    } catch {
      // Server unavailable — fall back to browser at runtime (not on Safari).
      // Don't persist: user's explicit choice should survive reload.
      if (this.backend === 'server' && !IS_SAFARI) {
        this.log.warn('Server daemon unavailable — falling back to on-device TTS (runtime only)');
        this.switchBackend('browser', { persist: false });
      } else if (this.backend === 'server' && IS_SAFARI) {
        this.log.warn('Server daemon unavailable. On-device TTS is not supported on Safari.');
        this.app.messageRenderer?.appendSystemMessage(
          'TTS unavailable: Kokoro daemon is offline and on-device TTS is not yet supported on Safari.', 'error'
        );
      }
      // Fall back to static voice list
      if (this.voices.length === 0) {
        this.voices = KOKORO_VOICES;
      }
    }
    this._populateVoiceSelect();
  }

  // --- Speech generation (delegated to backend) ---

  /**
   * Generate and play TTS for text using the active backend.
   */
  async speakText(text) {
    if (!text.trim()) return;

    const cleaned = this._cleanTextForTTS(text);
    if (!cleaned) return;

    this._clearIdleTimer();

    try {
      this.log.debug(`Speaking via ${this.backend} (voice: ${this.voice}):`, cleaned);
      const result = await this.activeBackend.speakText(cleaned, this.voice);
      if (result?.audio) {
        await this.enqueueAudio(result.audio);
      }
      // null result = server backend (audio arrives via WS tts_audio → enqueueAudio)
      //             = native backend (plugin handles playback directly)
    } catch (err) {
      this.log.warn('Speech generation failed:', err.message);
      this.app.voiceChatManager?.handleError('Speech failed: ' + err.message);
    }
  }

  _cleanTextForTTS(text) {
    return text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_~`#>]/g, '')
      .replace(/\n+/g, ' ')
      .trim();
  }

  // --- Idle worker management ---

  _startIdleTimer() {
    this._clearIdleTimer();
    if (this.activeBackend.name !== 'browser' || !this.activeBackend.destroyWorker) return;
    this._idleTimer = setTimeout(() => {
      this.log.info(`Browser worker idle for ${TTS_IDLE_TIMEOUT_MS / 1000}s — terminating to free memory`);
      this.activeBackend.destroyWorker();
    }, TTS_IDLE_TIMEOUT_MS);
  }

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  // --- Audio playback queue (shared by all backends) ---

  /** Create the AudioContext + analyser if needed (synchronous, no resume). */
  _createAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.audioContext.destination);
      this._levelBuffer = new Uint8Array(this.analyser.frequencyBinCount);
    }
  }

  async _ensureAudioContext() {
    this._createAudioContext();
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  /**
   * Unlock audio output from within a user gesture. iOS Safari keeps Web Audio
   * muted until a buffer is actually started during a real tap (resuming the
   * context alone is not enough) and re-suspends it when the tab backgrounds.
   * Desktop Safari/Chrome don't need this, but it's harmless there. Must be
   * called synchronously from the tap that triggers TTS (play button, voice-mode
   * toggle) — before the async audio generation, so output is live when the
   * generated audio arrives.
   */
  unlockAudio() {
    try {
      this._createAudioContext();
      if (this.audioContext.state === 'suspended') this.audioContext.resume();
      const src = this.audioContext.createBufferSource();
      src.buffer = this.audioContext.createBuffer(1, 1, 22050);
      src.connect(this.audioContext.destination);
      src.start(0);
    } catch (err) {
      this.log.warn('Audio unlock failed:', err.message);
    }
  }

  /** Enqueue base64-encoded WAV (on-device backends return audio this way). */
  async enqueueAudio(base64Data) {
    this.log.debug(`Playing audio (${Math.round(base64Data.length * 3 / 4 / 1024)}kb, queue: ${this.queue.length})`);
    const binary = atob(base64Data);
    const arrayBuffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await this._enqueueArrayBuffer(arrayBuffer);
  }

  /**
   * Enqueue raw WAV bytes from a server TTS binary WS frame. Skips the
   * base64/atob step (the server no longer inflates audio into JSON).
   */
  enqueueServerAudioBuffer(arrayBuffer) {
    this.log.debug(`Playing audio (${Math.round(arrayBuffer.byteLength / 1024)}kb, queue: ${this.queue.length})`);
    this._ttsDoneReceived = false;
    this._enqueueArrayBuffer(arrayBuffer);
  }

  async _enqueueArrayBuffer(arrayBuffer) {
    try {
      await this._ensureAudioContext();
      if (this.audioContext.state !== 'running') {
        this.log.warn('AudioContext suspended (waiting for user interaction) — dropping audio chunk');
        return;
      }
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      this.queue.push(audioBuffer);

      if (!this.isPlaying) {
        this._playNext();
      }
    } catch (err) {
      this.log.error('Failed to enqueue audio:', err, 'audioContext state:', this.audioContext?.state);
      this.app.voiceChatManager?.handleError('Audio playback failed');
    }
  }

  _playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      if (this._ttsDoneReceived) this._finishPlayback();
      // else: more chunks may arrive from server, stay in speaking state
      return;
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this._setSpeakingIndicator(true);
      this.app.voiceChatManager?.handleTTSStart();
    }

    const audioBuffer = this.queue.shift();
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.analyser);
    source.onended = () => {
      this.currentSource = null;
      this._playNext();
    };
    this.currentSource = source;
    source.start(0);
  }

  stop() {
    // Tell the server to stop streaming read-aloud chunks (server backend only;
    // a no-op bump for other backends). Without this the daemon keeps
    // synthesizing sentences after the user hits stop.
    this.activeBackend.cancelSpeak?.(this.app.wsClient);
    this.queue = [];
    this._ttsDoneReceived = true;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch { /* already stopped */ }
      this.currentSource = null;
    }
    this.isPlaying = false;
    this._finishPlayback();
  }

  /** Signal that the server has sent all TTS chunks for this response. */
  markTTSDone() {
    this._ttsDoneReceived = true;
    if (!this.isPlaying && this.queue.length === 0) {
      this._finishPlayback();
    }
  }

  _finishPlayback() {
    this._setSpeakingIndicator(false);
    this.app.voiceChatManager?.handleTTSEnd();
    this.bus.emit(EVT.TTS_PLAYBACK_ENDED);
    this._startIdleTimer();
  }

  /** Returns 0-1 normalized audio level from playback, or 0 if not playing. */
  getAudioLevel() {
    if (!this.analyser || !this.isPlaying || !this._levelBuffer) return 0;
    this.analyser.getByteFrequencyData(this._levelBuffer);
    let sum = 0;
    for (let i = 0; i < this._levelBuffer.length; i++) sum += this._levelBuffer[i];
    return Math.min((sum / this._levelBuffer.length) / 128, 1);
  }

  _setSpeakingIndicator(speaking) {
    const btn = this.app.elements.voiceModeBtn;
    if (btn) {
      btn.classList.toggle('tts-speaking', speaking);
    }
  }

  // --- Voice select UI (shared) ---

  _populateVoiceSelect() {
    const select = this.app.elements.voiceSelect;
    if (!select) return;

    select.innerHTML = '';

    if (this.voices.length === 0) {
      const opt = document.createElement('option');
      opt.value = this.voice;
      opt.textContent = this.voice;
      select.appendChild(opt);
      return;
    }

    const groups = {};
    for (const v of this.voices) {
      if (!groups[v.lang]) groups[v.lang] = [];
      groups[v.lang].push(v);
    }

    for (const [lang, voices] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = lang;
      for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = `${v.name} (${v.gender})`;
        if (v.id === this.voice) opt.selected = true;
        optgroup.appendChild(opt);
      }
      select.appendChild(optgroup);
    }
  }

  _updateVoiceSelectVisibility() {
    // Voice select is now in the pull-down drawer, always visible there
  }
}
