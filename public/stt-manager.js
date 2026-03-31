/**
 * STTManager - Microphone recording and speech-to-text via Whisper daemon.
 * Records audio in the browser, sends base64 to Eve backend, receives transcribed text.
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
  }

  async init() {
    await this.checkAvailability();
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
    this._updateButtonVisibility();
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

  async _processRecording() {
    const mimeType = this.mediaRecorder ? this.mediaRecorder.mimeType : 'audio/webm';
    const blob = new Blob(this.audioChunks, { type: mimeType });
    this.audioChunks = [];

    // Convert blob to base64
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

  // -- UI helpers --

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
    // Reuse the mic button to show transcribing state
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
