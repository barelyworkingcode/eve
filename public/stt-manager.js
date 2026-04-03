/**
 * STTManager - Microphone recording and speech-to-text orchestrator.
 * Delegates transcription to a pluggable backend (browser, server, or native).
 * Owns shared concerns: mic recording, audio levels, UI indicators, result routing.
 */
class STTManager {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.bus = container.get('bus');
    this.isRecording = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.recordingStartTime = null;
    this.timerInterval = null;
    this.available = null; // null = unknown, true/false after check
    this.isNativeApp = IS_NATIVE_APP;

    const backendName = IS_NATIVE_APP ? 'native' : (localStorage.getItem('eve-stt-backend') || (IS_SAFARI ? 'server' : 'browser'));
    this.activeBackend = this._createBackend(backendName);
    console.log(`[STT] Using ${backendName} backend`);
  }

  get backend() {
    return this.activeBackend.name;
  }

  get browserReady() {
    return this.activeBackend.name === 'browser' && this.activeBackend.ready;
  }

  _createBackend(name) {
    switch (name) {
      case 'native': return new SttNativeBackend();
      case 'browser': return new SttBrowserBackend();
      case 'server':
      default: return new SttServerBackend();
    }
  }

  async init() {
    this._initBackend();
    await this.checkAvailability();
  }

  _initBackend() {
    const context = {
      app: this.app,
      wsClient: this.app.wsClient,
      onProgress: (data) => {
        if (this.activeBackend.ready) return;
        const pct = Math.round(data.progress || 0);
        this.app._sttLoadPct = pct;
        this.app.voiceChatManager?._setPrompt(`Loading STT model: ${pct}%`);
      },
      onReady: () => {
        console.log(`[STT] ${this.backend} backend ready`);
        this.bus.emit(EVT.VOICE_BACKEND_CHANGED);
      },
      onError: (msg) => {
        console.error(`[STT] ${this.backend} backend failed:`, msg);
        this.app.messageRenderer?.appendSystemMessage(`On-device STT failed to load — falling back to server.`, 'warning');
        this.switchBackend('server', { persist: false });
      },
    };

    if (this.activeBackend.name === 'browser') {
      const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      context.model = isMobile ? 'onnx-community/whisper-base' : 'onnx-community/whisper-small';
      context.dtype = hasWebGPU ? 'fp32' : 'q8';
      context.device = hasWebGPU ? 'webgpu' : 'wasm';
    }

    this.activeBackend.init(context);
  }

  async checkAvailability() {
    this.available = await this.activeBackend.isAvailable();
    // Auto-switch to browser if server is unavailable (not on Safari — memory issues)
    if (!this.available && this.backend === 'server' && !IS_SAFARI) {
      console.warn('[STT] Server daemon unavailable — falling back to on-device STT (runtime only)');
      this.switchBackend('browser', { persist: false });
      this.available = true;
    }
    if (this.backend === 'browser') this.available = true;
    this._updateButtonVisibility();
  }

  switchBackend(name, { persist = true } = {}) {
    const prev = this.activeBackend.name;
    this.activeBackend.destroy();
    this.activeBackend = this._createBackend(name);
    if (persist) localStorage.setItem('eve-stt-backend', name);
    this._initBackend();
    this._updateButtonVisibility();
    console.log(`[STT] Switched backend: ${prev} → ${name}`);
    this.bus.emit(EVT.VOICE_BACKEND_CHANGED);
  }

  setBackend(name) {
    this.switchBackend(name);
    this.available = true;
    this._updateButtonVisibility();
  }

  toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  // --- Recording (native delegates to backend, browser/server use shared MediaRecorder) ---

  async startRecording() {
    if (this.activeBackend.startRecording) {
      try {
        await this.activeBackend.startRecording((text) => this.handleTranscriptionResult(text));
        this.isRecording = true;
        this.recordingStartTime = Date.now();
        this._startTimer();
        this._updateUI();
      } catch (err) {
        console.error('[STT] Native recording failed:', err);
        this.app.messageRenderer.appendSystemMessage('Native STT failed: ' + err.message, 'error');
      }
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      // Set up analyser for real-time audio levels (reuse AudioContext)
      if (!this.micContext) {
        this.micContext = new (window.AudioContext || window.webkitAudioContext)();
        this.micAnalyser = this.micContext.createAnalyser();
        this.micAnalyser.fftSize = 256;
        this._levelBuffer = new Uint8Array(this.micAnalyser.frequencyBinCount);
      }
      if (this.micContext.state === 'suspended') await this.micContext.resume();
      this._micSource = this.micContext.createMediaStreamSource(this.stream);
      this._micSource.connect(this.micAnalyser);

      // Prefer webm/opus for small size; fall back to whatever is available
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const options = mimeType ? { mimeType } : {};
      this.mediaRecorder = new MediaRecorder(this.stream, options);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };

      this.mediaRecorder.onstop = () => {
        this._processRecording();
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this._startTimer();
      this._updateUI();
    } catch (err) {
      console.error('[STT] Microphone access denied:', err);
      this.app.messageRenderer.appendSystemMessage(
        'Microphone access denied. Check browser permissions.', 'error'
      );
    }
  }

  stopRecording() {
    if (this.activeBackend.stopRecording) {
      this.activeBackend.stopRecording();
      this.isRecording = false;
      this._stopTimer();
      this._updateUI();
      return;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this._micSource) {
      this._micSource.disconnect();
      this._micSource = null;
    }
    this.isRecording = false;
    this._stopTimer();
    this._updateUI();
  }

  // --- Transcription ---

  /**
   * Transcribe Float32Array audio from VAD. Delegates to active backend.
   */
  async transcribeFloat32(audio) {
    if (!this.activeBackend.ready) {
      console.warn('[STT] Backend not ready, audio discarded');
      this.app.voiceChatManager?.handleError('STT model still loading — please wait');
      return;
    }
    try {
      const result = await this.activeBackend.transcribe(audio);
      if (result?.text) this.handleTranscriptionResult(result.text);
      // null result = server backend (result arrives via WS → handleTranscriptionResult)
    } catch (err) {
      console.error('[STT] Transcription failed:', err);
      this.app.voiceChatManager?.handleError('Transcription failed');
    }
  }

  /**
   * Process a push-to-talk recording. Validates then delegates to backend.
   */
  async _processRecording() {
    const mimeType = this.mediaRecorder ? this.mediaRecorder.mimeType : 'audio/webm';
    const blob = new Blob(this.audioChunks, { type: mimeType });
    this.audioChunks = [];

    // Skip empty or very short recordings — MediaRecorder produces invalid containers
    const duration = this.recordingStartTime ? Date.now() - this.recordingStartTime : 0;
    if (blob.size < 100) {
      console.warn(`[STT] Empty recording (${blob.size} bytes), skipping`);
      this.app.voiceChatManager?.handleError('No audio captured');
      return;
    }
    if (duration < 300) {
      console.warn(`[STT] Recording too short (${duration}ms, ${blob.size} bytes), skipping`);
      this.app.voiceChatManager?.handleError('Recording too short — hold longer');
      if (!this.app.voiceChatManager?.isVoiceSession) {
        this.app.messageRenderer.appendSystemMessage('Recording too short. Hold the button longer to record.', 'warning');
      }
      return;
    }

    try {
      this._showTranscribingIndicator();
      const result = await this.activeBackend.transcribeBlob(blob);
      if (result?.text) {
        this.handleTranscriptionResult(result.text);
      }
      // null result = server backend (WS response triggers handleTranscriptionResult)
    } catch (err) {
      console.error('[STT] Recording transcription failed:', err);
      this._hideTranscribingIndicator();
      this.app.voiceChatManager?.handleError('Transcription failed');
      if (!this.app.voiceChatManager?.isVoiceSession) {
        this.app.messageRenderer.appendSystemMessage('Transcription failed. Please try again.', 'error');
      }
    }
  }

  // --- Result handling (shared across all backends) ---

  handleTranscriptionResult(text) {
    this._hideTranscribingIndicator();

    if (!text || !text.trim()) return;

    // Filter Whisper artifacts — non-speech annotations like [BLANK_AUDIO], [Crickets chirping], (silence), etc.
    const cleaned = text.trim();
    if (/^\[.*\]$/.test(cleaned) || /^\(.*\)$/.test(cleaned)) {
      console.warn('[STT] Filtered Whisper artifact:', cleaned);
      return;
    }

    // Filter Whisper hallucinations on background noise — short repetitive phrases it produces
    // when processing non-speech audio (fan noise, keyboard clicks, ambient sounds)
    const lower = cleaned.toLowerCase();
    const HALLUCINATIONS = [
      'thank you', 'thanks for watching', 'thanks for listening',
      'you', 'bye', 'the end', 'hmm', 'mm',
      'subscribe', 'like and subscribe',
    ];
    if (HALLUCINATIONS.includes(lower) || lower.replace(/\./g, '').trim().length < 2) {
      console.warn('[STT] Filtered likely hallucination:', cleaned);
      return;
    }

    // Route to voice chat manager if active
    if (this.app.voiceChatManager?.isVoiceSession) {
      this.app.voiceChatManager.handleTranscription(cleaned);
      return;
    }

    const textarea = this.app.elements.userInput;

    // Append to existing text (in case user typed something)
    const existing = textarea.value;
    const separator = existing && !existing.endsWith(' ') ? ' ' : '';
    textarea.value = existing + separator + cleaned;
    this.app.autoResizeTextarea();
    textarea.focus();

    // Auto-submit if voice mode (TTS) is active
    if (this.app.ttsManager.enabled && this.app.currentSessionId) {
      setTimeout(() => {
        this.app.handleSubmit(new Event('submit'));
      }, 300);
    }
  }

  handleTranscriptionError(error) {
    this._hideTranscribingIndicator();
    console.error('[STT] Transcription error:', error);
    this.app.messageRenderer.appendSystemMessage(
      `Transcription failed: ${error}`, 'error'
    );
  }

  /** Returns 0-1 normalized audio level from mic, or 0 if not recording. */
  getAudioLevel() {
    if (!this.micAnalyser || !this._levelBuffer) return 0;
    this.micAnalyser.getByteFrequencyData(this._levelBuffer);
    let sum = 0;
    for (let i = 0; i < this._levelBuffer.length; i++) sum += this._levelBuffer[i];
    return Math.min((sum / this._levelBuffer.length) / 128, 1);
  }

  // --- UI helpers ---

  _updateButtonVisibility() {
    const btn = this.app.elements.micBtn;
    if (btn) {
      btn.classList.toggle('hidden', !this.available);
    }
  }

  _updateUI() {
    const btn = this.app.elements.micBtn;
    if (btn) {
      btn.classList.toggle('btn-mic--recording', this.isRecording);
      btn.title = this.isRecording ? 'Stop recording' : 'Dictate (Speech-to-Text)';
    }
  }

  _startTimer() {
    const btn = this.app.elements.micBtn;
    if (!btn) return;

    this.timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      btn.title = `Recording... ${mins}:${secs.toString().padStart(2, '0')}`;
    }, 1000);
  }

  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  _showTranscribingIndicator() {
    const btn = this.app.elements.micBtn;
    if (btn) {
      btn.classList.add('btn-mic--transcribing');
      btn.title = 'Transcribing...';
    }
  }

  _hideTranscribingIndicator() {
    const btn = this.app.elements.micBtn;
    if (btn) {
      btn.classList.remove('btn-mic--transcribing');
      btn.title = 'Dictate (Speech-to-Text)';
    }
  }
}
