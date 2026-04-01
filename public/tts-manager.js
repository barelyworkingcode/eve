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
  constructor(app) {
    this.app = app;
    this.enabled = localStorage.getItem('eve-voice-mode') === 'true';
    this.voice = localStorage.getItem('eve-voice-preset') || DEFAULT_TTS_VOICE;
    this.voices = [];
    this.audioContext = null;
    this.queue = [];
    this.isPlaying = false;
    this.currentSource = null;
    this.isNativeApp = IS_NATIVE_APP;
    this._idleTimer = null;

    const backendName = IS_NATIVE_APP ? 'native' : (localStorage.getItem('eve-tts-backend') || (IS_SAFARI ? 'server' : 'browser'));
    this.activeBackend = this._createBackend(backendName);
    console.log(`[TTS] Using ${backendName} backend`);
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

    // Pre-warm AudioContext on first user gesture to satisfy autoplay policy
    const warmUp = () => {
      this._ensureAudioContext();
      document.removeEventListener('click', warmUp);
      document.removeEventListener('touchstart', warmUp);
      document.removeEventListener('keydown', warmUp);
    };
    document.addEventListener('click', warmUp);
    document.addEventListener('touchstart', warmUp);
    document.addEventListener('keydown', warmUp);
  }

  _initBackend() {
    const context = {
      app: this.app,
      onProgress: (data) => {
        if (this.activeBackend.ready) return;
        const pct = Math.round(data.progress || 0);
        this.app.voiceChatManager?._setPrompt(`Loading TTS model: ${pct}%`);
      },
      onReady: () => {
        console.log(`[TTS] ${this.backend} backend ready`);
      },
      onError: (msg) => {
        console.error(`[TTS] ${this.backend} backend failed:`, msg);
        this.app.messageRenderer?.appendSystemMessage('On-device TTS failed to load — falling back to server.', 'warning');
        this.switchBackend('server');
      },
    };

    if (this.activeBackend.name === 'browser') {
      // Use WebGPU with fp32 when available, otherwise WASM with q4 quantization.
      // Now works on Safari — replaced kokoro-js (broken on Safari) with direct onnxruntime-web.
      const useWebGPU = !!navigator.gpu;
      context.dtype = useWebGPU ? 'fp32' : 'q4';
      context.device = useWebGPU ? 'webgpu' : 'wasm';
    }

    this.activeBackend.init(context);
  }

  switchBackend(name) {
    const prev = this.activeBackend.name;
    this._clearIdleTimer();
    this.activeBackend.destroy();
    this.activeBackend = this._createBackend(name);
    localStorage.setItem('eve-tts-backend', name);
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

    console.log(`[TTS] Switched backend: ${prev} → ${name}`);

    // Reload voices from new backend
    this.loadVoices();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    localStorage.setItem('eve-voice-mode', enabled ? 'true' : 'false');
    if (!enabled) this.stop();
    this._updateVoiceSelectVisibility();
  }

  setVoice(voiceId) {
    this.voice = voiceId;
    localStorage.setItem('eve-voice-preset', voiceId);
  }

  setBackend(name) {
    this.switchBackend(name);
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
      // Server unavailable — try switching to browser (not on Safari)
      if (this.backend === 'server' && !IS_SAFARI) {
        console.warn('[TTS] Server daemon unavailable — switching to on-device TTS');
        this.switchBackend('browser');
      } else if (this.backend === 'server' && IS_SAFARI) {
        console.warn('[TTS] Server daemon unavailable. On-device TTS is not supported on Safari.');
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
      console.log(`[TTS] Speaking via ${this.backend} (voice: ${this.voice}, ${cleaned.length} chars)`);
      const result = await this.activeBackend.speakText(cleaned, this.voice);
      if (result?.audio) {
        this.app.voiceChatManager?.handleTTSStart();
        await this.enqueueAudio(result.audio);
      }
      // null result = server backend (audio arrives via WS tts_audio → enqueueAudio)
      //             = native backend (plugin handles playback directly)
    } catch (err) {
      console.warn('[TTS] Speech generation failed:', err.message);
      this.app.voiceChatManager?.handleError('Speech failed: ' + err.message);
    }
  }

  _cleanTextForTTS(text) {
    return text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .replace(/[*_~`#>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n+/g, ' ')
      .trim();
  }

  // --- Idle worker management ---

  _startIdleTimer() {
    this._clearIdleTimer();
    if (this.activeBackend.name !== 'browser' || !this.activeBackend.destroyWorker) return;
    this._idleTimer = setTimeout(() => {
      console.log(`[TTS] Browser worker idle for ${TTS_IDLE_TIMEOUT_MS / 1000}s — terminating to free memory`);
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

  async _ensureAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.audioContext.destination);
      this._levelBuffer = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
  }

  async enqueueAudio(base64Data) {
    try {
      await this._ensureAudioContext();
      const binary = atob(base64Data);
      const arrayBuffer = new ArrayBuffer(binary.length);
      const bytes = new Uint8Array(arrayBuffer);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      this.queue.push(audioBuffer);

      if (!this.isPlaying) {
        this._playNext();
      }
    } catch (err) {
      console.error('[TTS] Failed to enqueue audio:', err, 'audioContext state:', this.audioContext?.state);
      this.app.voiceChatManager?.handleError('Audio playback failed');
    }
  }

  _playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this._setSpeakingIndicator(false);
      this.app.voiceChatManager?.handleTTSEnd();
      this._startIdleTimer();
      return;
    }

    this.isPlaying = true;
    this._setSpeakingIndicator(true);

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
    this.queue = [];
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch { /* already stopped */ }
      this.currentSource = null;
    }
    this.isPlaying = false;
    this._setSpeakingIndicator(false);
    this.app.voiceChatManager?.handleTTSEnd();
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
