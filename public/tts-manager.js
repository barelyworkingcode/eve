/**
 * TTSManager - Audio playback queue and voice selection for voice mode.
 * Supports two backends:
 *   - 'server': receives base64 WAV chunks via WebSocket from Kokoro daemon
 *   - 'browser': generates audio locally via kokoro-js in a Web Worker
 */
const DEFAULT_TTS_VOICE = 'af_heart';

// Fallback voice list when server daemon is unavailable (browser TTS uses same IDs)
const KOKORO_VOICES = [
  { id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'F' },
  { id: 'af_bella', name: 'Bella', lang: 'American English', gender: 'F' },
  { id: 'af_nicole', name: 'Nicole', lang: 'American English', gender: 'F' },
  { id: 'af_nova', name: 'Nova', lang: 'American English', gender: 'F' },
  { id: 'af_sarah', name: 'Sarah', lang: 'American English', gender: 'F' },
  { id: 'af_sky', name: 'Sky', lang: 'American English', gender: 'F' },
  { id: 'am_adam', name: 'Adam', lang: 'American English', gender: 'M' },
  { id: 'am_echo', name: 'Echo', lang: 'American English', gender: 'M' },
  { id: 'am_eric', name: 'Eric', lang: 'American English', gender: 'M' },
  { id: 'am_michael', name: 'Michael', lang: 'American English', gender: 'M' },
  { id: 'bf_emma', name: 'Emma', lang: 'British English', gender: 'F' },
  { id: 'bf_lily', name: 'Lily', lang: 'British English', gender: 'F' },
  { id: 'bm_daniel', name: 'Daniel', lang: 'British English', gender: 'M' },
  { id: 'bm_george', name: 'George', lang: 'British English', gender: 'M' },
];

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

    this.backend = localStorage.getItem('eve-tts-backend') || 'server';
    this.browserBackend = null;
    this.browserBackendLoading = false;
  }

  init() {
    this._updateVoiceSelectVisibility();
    this.loadVoices();
    if (this.backend === 'browser') {
      this._ensureBrowserBackend();
    }
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

  setBackend(backend) {
    this.backend = backend;
    localStorage.setItem('eve-tts-backend', backend);
    if (backend === 'browser') {
      this._ensureBrowserBackend();
    }
  }

  /** Whether server-side TTS relay should be active. */
  get useServerTTS() {
    return this.backend !== 'browser';
  }

  /** Send voice_mode state to server if using server TTS backend. */
  syncVoiceMode(ws) {
    if (!this.useServerTTS) return;
    ws.send({ type: 'voice_mode', enabled: this.enabled, voice: this.voice });
  }

  async loadVoices() {
    try {
      const token = localStorage.getItem('eve_session');
      const headers = token ? { 'x-session-token': token } : {};
      const res = await fetch('/api/tts/voices', { headers });
      if (!res.ok) throw new Error('not ok');
      this.voices = await res.json();
    } catch {
      // Server daemon unavailable — use built-in list for browser backend
      if (this.voices.length === 0) {
        this.voices = KOKORO_VOICES;
      }
    }
    this._populateVoiceSelect();
  }

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

  // --- Audio playback (shared by both backends) ---

  async _ensureAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.audioContext.destination);
      this._levelBuffer = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch {
        // Autoplay policy — will resume on next user gesture
      }
    }
  }

  async enqueueAudio(base64Data) {
    try {
      await this._ensureAudioContext();
      const response = await fetch(`data:audio/wav;base64,${base64Data}`);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

      this.queue.push(audioBuffer);

      if (!this.isPlaying) {
        this._playNext();
      }
    } catch (err) {
      console.error('[TTS] Failed to enqueue audio:', err);
    }
  }

  _playNext() {
    if (this.queue.length === 0) {
      this.isPlaying = false;
      this._setSpeakingIndicator(false);
      this.app.voiceChatManager?.handleTTSEnd();
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

  // --- Browser backend (on-device TTS) ---

  _ensureBrowserBackend() {
    if (this.browserBackend || this.browserBackendLoading) return;
    this.browserBackendLoading = true;

    const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
    this.browserBackend = new TtsBrowserBackend();
    this.browserBackend.init({
      dtype: hasWebGPU ? 'fp32' : 'q8',
      device: hasWebGPU ? 'webgpu' : 'wasm',
      onProgress: (data) => {
        if (this.browserBackend?.ready) return;
        const pct = Math.round(data.progress || 0);
        this.app.voiceChatManager?._setPrompt(`Loading TTS model: ${pct}%`);
      },
      onReady: () => {
        this.browserBackendLoading = false;
        console.log('[TTS] Browser TTS ready');
      },
      onError: (msg) => {
        this.browserBackendLoading = false;
        console.error('[TTS] Browser backend failed:', msg);
        // Fall back to server
        this.backend = 'server';
        localStorage.setItem('eve-tts-backend', 'server');
      },
    });
  }

  /**
   * Generate and play TTS for text using the selected backend.
   * Called by relay-client when voice mode is active.
   */
  async speakText(text) {
    if (!text.trim()) return;

    if (this.backend === 'browser') {
      await this._speakViaBrowser(text);
    }
    // 'server' path is handled by relay-client → tts-service → enqueueAudio
  }

  async _speakViaBrowser(text) {
    if (!this.browserBackend?.ready) {
      this._ensureBrowserBackend();
      return;
    }

    // Clean text (strip markdown, thinking tags)
    const cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .replace(/[*_~`#>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n+/g, ' ')
      .trim();
    if (!cleaned) return;

    try {
      this.app.voiceChatManager?.handleTTSStart();
      const result = await this.browserBackend.generate(cleaned, this.voice);
      await this.enqueueAudio(result.audio);
    } catch (err) {
      console.error('[TTS] Browser generation failed:', err);
      this.app.voiceChatManager?.handleTTSEnd();
    }
  }

  /** Whether the browser backend is loaded and ready. */
  get browserReady() {
    return this.browserBackend?.ready || false;
  }
}
