/**
 * STTManager - Microphone recording and speech-to-text.
 * Supports two backends:
 *   - 'server': sends audio via WebSocket to Eve backend → Whisper daemon
 *   - 'browser': transcribes locally via transformers.js Whisper in a Web Worker
 */
class STTManager {
  constructor(app) {
    this.app = app;
    this.isRecording = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.recordingStartTime = null;
    this.timerInterval = null;
    this.available = null; // null = unknown, true/false after check

    this.backend = localStorage.getItem('eve-stt-backend') || 'server';
    this.browserBackend = null;
    this.browserBackendLoading = false;
  }

  async init() {
    await this.checkAvailability();
    if (this.backend === 'browser') {
      this._ensureBrowserBackend();
    }
  }

  async checkAvailability() {
    try {
      const token = localStorage.getItem('eve_session');
      const headers = token ? { 'x-session-token': token } : {};
      const res = await fetch('/api/stt/status', { headers });
      if (res.ok) {
        const data = await res.json();
        this.available = data.available;
      } else {
        this.available = false;
      }
    } catch {
      this.available = false;
    }
    // Auto-switch to browser backend if server daemon is unavailable
    if (!this.available && this.backend === 'server') {
      this.backend = 'browser';
      localStorage.setItem('eve-stt-backend', 'browser');
      this._ensureBrowserBackend();
    }
    if (this.backend === 'browser') this.available = true;
    this._updateButtonVisibility();
  }

  setBackend(backend) {
    this.backend = backend;
    localStorage.setItem('eve-stt-backend', backend);
    if (backend === 'browser') {
      this.available = true;
      this._updateButtonVisibility();
      this._ensureBrowserBackend();
    }
  }

  get browserReady() {
    return this.browserBackend?.ready || false;
  }

  toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  async startRecording() {
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

  /**
   * Transcribe a Float32Array (16kHz mono) from VAD using the browser backend.
   * Falls back to server if browser backend not ready.
   */
  async transcribeFloat32(audio) {
    if (this.backend === 'browser') {
      if (!this.browserBackend?.ready) {
        console.log('[STT] Browser model still loading, skipping');
        return;
      }
      try {
        const result = await this.browserBackend.transcribe(audio);
        this.handleTranscriptionResult(result.text);
      } catch (err) {
        console.error('[STT] Browser transcription failed:', err);
      }
    } else {
      this._transcribeViaServer(audio);
    }
  }

  /** Encode Float32Array as WAV base64 and send to server. */
  _transcribeViaServer(audio) {
    const base64Wav = VadManager.audioToBase64Wav(audio);
    this.app.wsClient.send({ type: 'transcribe_audio', audio: base64Wav });
  }

  async _processRecording() {
    const mimeType = this.mediaRecorder ? this.mediaRecorder.mimeType : 'audio/webm';
    const blob = new Blob(this.audioChunks, { type: mimeType });
    this.audioChunks = [];

    if (this.backend === 'browser' && this.browserBackend?.ready) {
      // Decode blob to Float32Array and transcribe locally
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const audioCtx = new OfflineAudioContext(1, 1, 16000);
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
        // Resample to 16kHz mono
        const offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(offlineCtx.destination);
        source.start();
        const rendered = await offlineCtx.startRendering();
        const float32 = rendered.getChannelData(0);
        this._showTranscribingIndicator();
        const result = await this.browserBackend.transcribe(float32);
        this.handleTranscriptionResult(result.text);
      } catch (err) {
        console.error('[STT] Browser transcription of recording failed:', err);
        this._hideTranscribingIndicator();
      }
      return;
    }

    // Server path: convert blob to base64 and send via WebSocket
    const reader = new FileReader();
    reader.onloadend = () => {
      if (!reader.result) {
        this.app.messageRenderer.appendSystemMessage('Failed to read audio recording.', 'error');
        return;
      }
      const base64 = reader.result.split(',')[1];
      this.app.wsClient.send({
        type: 'transcribe_audio',
        audio: base64,
      });
      this._showTranscribingIndicator();
    };
    reader.onerror = () => {
      console.error('[STT] FileReader error:', reader.error);
      this.app.messageRenderer.appendSystemMessage('Failed to process audio recording.', 'error');
    };
    reader.readAsDataURL(blob);
  }

  handleTranscriptionResult(text) {
    this._hideTranscribingIndicator();

    if (!text || !text.trim()) return;

    // Route to voice chat manager if active
    if (this.app.voiceChatManager?.isVoiceSession) {
      this.app.voiceChatManager.handleTranscription(text.trim());
      return;
    }

    const textarea = this.app.elements.userInput;

    // Append to existing text (in case user typed something)
    const existing = textarea.value;
    const separator = existing && !existing.endsWith(' ') ? ' ' : '';
    textarea.value = existing + separator + text.trim();
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

  // --- Browser backend ---

  _ensureBrowserBackend() {
    if (this.browserBackend || this.browserBackendLoading) return;
    this.browserBackendLoading = true;

    const hasWebGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
    this.browserBackend = new SttBrowserBackend();
    this.browserBackend.init({
      model: 'onnx-community/whisper-small',
      dtype: hasWebGPU ? 'fp32' : 'q8',
      device: hasWebGPU ? 'webgpu' : 'wasm',
      onProgress: (data) => {
        if (this.browserBackend?.ready) return;
        const pct = Math.round(data.progress || 0);
        this.app.voiceChatManager?._setPrompt(`Loading STT model: ${pct}%`);
      },
      onReady: () => {
        this.browserBackendLoading = false;
        console.log('[STT] Browser STT ready');
        if (this.app.voiceChatManager?.isVoiceSession) {
          this.app.voiceChatManager._setPrompt('Listening...');
        }
      },
      onError: (msg) => {
        this.browserBackendLoading = false;
        console.error('[STT] Browser backend failed:', msg);
        this.backend = 'server';
        localStorage.setItem('eve-stt-backend', 'server');
      },
    });
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
