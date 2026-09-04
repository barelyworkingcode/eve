const DEFAULT_TTS_VOICE = 'af_heart';

class TTSManager {
  constructor(container) {
    this.app = container.get('app');
    this.bus = container.get('bus');
    this._logger = container.get('logger');
    this.enabled = false;
    this.voice = localStorage.getItem('eve-voice-preset') || DEFAULT_TTS_VOICE;
    this.speed = parseFloat(localStorage.getItem('eve-voice-speed')) || 1.0;
    this.voices = [];
    this.audioContext = null;
    this.queue = [];
    this.isPlaying = false;
    this.currentSource = null;
    this.button = null;
    this.isNativeApp = IS_NATIVE_APP;
    this._ttsDoneReceived = true;

    // Native on-device TTS is unreliable on iOS 26.5.1 — an upstream library
    // bug crashes synthesis within ~1-2 utterances. The server backend gives
    // the same voice/quality and is rock-solid, so the native app defaults to
    // 'server'. On-device is opt-in: selected only if the user explicitly
    // chooses 'native' in Settings (persisted). 'server' is also
    // VoiceCrashGuard's post-crash fallback. Revisit the default if the bug
    // is fixed upstream/in iOS.
    this.preferredBackend = IS_NATIVE_APP
      ? (localStorage.getItem('eve-tts-backend') === 'native' ? 'native' : 'server')
      : 'server';
    // Always start on server — VoiceInitCoordinator switches to preferred when ready
    this.activeBackend = this._createBackend('server');
    this.log = this._logger.child(`TTS:${this.activeBackend.name}`);
    this.log.info(`Starting (preferred: ${this.preferredBackend})`);
  }

  get backend() {
    return this.activeBackend.name;
  }

  get useServerTTS() {
    return this.activeBackend.name === 'server';
  }

  /**
   * True while a native voice session owns audio playback (iOS). Server TTS
   * frames are forwarded to the native engine instead of Web Audio, so playback
   * survives the screen turning off. Scoped to voice sessions — read-aloud in a
   * text session still uses the Web-Audio path.
   */
  get _nativeAudioActive() {
    return IS_NATIVE_AUDIO && !!this.app.voiceChatManager?.usingNativeSession;
  }

  _createBackend(name) {
    switch (name) {
      case 'native': return new TtsNativeBackend();
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

    this.activeBackend.init(context);
  }

  switchBackend(name, { persist = true } = {}) {
    const prev = this.activeBackend.name;
    this.activeBackend.destroy();
    this.activeBackend = this._createBackend(name);
    if (persist) {
      localStorage.setItem('eve-tts-backend', name);
      this.preferredBackend = name;
    }
    this._initBackend();

    this.stop();

    const ws = this.app.wsClient;
    if (prev === 'server' && name !== 'server') {
      ws.send({ type: 'voice_mode', enabled: false });
    } else if (prev !== 'server' && name === 'server' && this.enabled) {
      this.syncVoiceMode(ws);
    }

    this.log = this._logger.child(`TTS:${name}`);
    this.log.info(`Switched from ${prev}`);
    this.bus.emit(EVT.VOICE_BACKEND_CHANGED);

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

  setSpeed(speed) {
    const s = Math.min(2.0, Math.max(0.5, parseFloat(speed) || 1.0));
    this.speed = s;
    localStorage.setItem('eve-voice-speed', String(s));
    this.log.info(`Playback speed → ${s}×`);
  }

  setBackend(name) {
    this.switchBackend(name);
    this.log.info(`Backend changed → ${name}`);
  }

  syncVoiceMode(ws) {
    this.activeBackend.syncVoiceMode?.(ws, this.enabled, this.voice, this.speed);
  }

  async loadVoices() {
    try {
      this.voices = await this.activeBackend.loadVoices();
    } catch {
      // Don't surface this to the user here — speakText()'s own catch
      // surfaces the failure at the point of use.
      this.log.warn('Server TTS daemon unavailable — using static voice list');
      if (this.voices.length === 0) {
        this.voices = KOKORO_VOICES;
      }
    }
    this._populateVoiceSelect();
  }

  async speakText(text) {
    if (!text.trim()) return;

    const cleaned = this._cleanTextForTTS(text);
    if (!cleaned) return;


    try {
      this.log.debug(`Speaking via ${this.backend} (voice: ${this.voice}):`, cleaned);
      const result = await this.activeBackend.speakText(cleaned, this.voice, this.speed);
      if (result?.audio) {
        await this.enqueueAudio(result.audio);
      }
      // null result = server backend, whose audio arrives separately via the
      // WS tts_audio frame → enqueueServerAudioBuffer, not this return value.
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

  async enqueueAudio(base64Data) {
    this.log.debug(`Playing audio (${Math.round(base64Data.length * 3 / 4 / 1024)}kb, queue: ${this.queue.length})`);
    const binary = atob(base64Data);
    const arrayBuffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(arrayBuffer);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await this._enqueueArrayBuffer(arrayBuffer);
  }

  enqueueServerAudioBuffer(arrayBuffer) {
    // Stale frames from a barged-in reply can still be in the WS pipe after the
    // client stopped the turn; playing one would talk over the user.
    if (this.app.voiceChatManager?._suppressTTSFrames) return;
    this._ttsDoneReceived = false;
    if (this._nativeAudioActive) {
      // Per-sentence chunks are small, so the base64 re-encode cost is negligible.
      this.app.voiceChatManager.nativeAudio.enqueueTTS(this._arrayBufferToBase64(arrayBuffer));
      return;
    }
    this.log.debug(`Playing audio (${Math.round(arrayBuffer.byteLength / 1024)}kb, queue: ${this.queue.length})`);
    this._enqueueArrayBuffer(arrayBuffer);
  }

  _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(binary);
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
    // Without this, the daemon keeps synthesizing sentences after the user hits stop.
    this.activeBackend.cancelSpeak?.(this.app.wsClient);
    if (this._nativeAudioActive) this.app.voiceChatManager.nativeAudio.stopPlayback();
    this.queue = [];
    this._ttsDoneReceived = true;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch { /* already stopped */ }
      this.currentSource = null;
    }
    this.isPlaying = false;
    this._finishPlayback();
  }

  markTTSDone() {
    this._ttsDoneReceived = true;
    if (this._nativeAudioActive) {
      // Native drives the real end-of-playback (onPlaybackEnded → handleTTSEnd)
      // once its queue drains; until then it keeps the mic muted so an
      // inter-chunk gap doesn't end the turn early.
      this.app.voiceChatManager.nativeAudio.endTTSTurn();
      return;
    }
    if (!this.isPlaying && this.queue.length === 0) {
      this._finishPlayback();
    }
  }

  _finishPlayback() {
    this._setSpeakingIndicator(false);
    this.app.voiceChatManager?.handleTTSEnd();
    this.bus.emit(EVT.TTS_PLAYBACK_ENDED);
  }

  getAudioLevel() {
    if (!this.analyser || !this.isPlaying || !this._levelBuffer) return 0;
    this.analyser.getByteFrequencyData(this._levelBuffer);
    let sum = 0;
    for (let i = 0; i < this._levelBuffer.length; i++) sum += this._levelBuffer[i];
    return Math.min((sum / this._levelBuffer.length) / 128, 1);
  }

  _setSpeakingIndicator(speaking) {
    const btn = this.button;
    if (btn) {
      btn.classList.toggle('tts-speaking', speaking);
    }
  }

  syncButtonState() {
    this.button?.classList.toggle('btn-voice-mode--active', this.enabled);
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
    // Voice select lives in the pull-down drawer and is always visible there.
  }
}
