/**
 * TTSManager - Audio playback queue and voice selection for voice mode.
 * Supports two backends:
 *   - 'server': receives base64 WAV chunks via WebSocket from Kokoro daemon
 *   - 'browser': generates audio locally via kokoro-js in a Web Worker
 */
const DEFAULT_TTS_VOICE = 'af_heart';

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

  async loadVoices() {
    try {
      const token = localStorage.getItem('eve_session');
      const headers = token ? { 'x-session-token': token } : {};
      const res = await fetch('/api/tts/voices', { headers });
      if (!res.ok) return;
      this.voices = await res.json();
    } catch {
      // TTS daemon unavailable
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
      await this.audioContext.resume();
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

    this.browserBackend = new TtsBrowserBackend();
    this.browserBackend.init({
      dtype: 'q8',
      device: 'wasm',
      onProgress: (data) => {
        const pct = Math.round(data.progress || 0);
        console.log(`[TTS] Downloading model: ${pct}%`);
        this.app.voiceChatManager?._setPrompt(`Downloading TTS model: ${pct}%`);
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
