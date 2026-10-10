class STTManager {
  constructor(container) {
    this.app = container.get('app');
    this.bus = container.get('bus');
    this._logger = container.get('logger');
    this.isRecording = false;
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.stream = null;
    this.recordingStartTime = null;
    this.timerInterval = null;
    this.available = null;
    this.isNativeApp = IS_NATIVE_APP;
    this.button = null; // assigned by the STT feature's render closure, which runs after boot()

    // Native on-device STT shares the same iOS-26.5.1 platform instability as
    // native TTS, so the native app defaults to the reliable server backend.
    // On-device is opt-in: selected only if the user explicitly chooses
    // 'native' in Settings (persisted). 'server' is also VoiceCrashGuard's
    // post-crash fallback.
    this.preferredBackend = IS_NATIVE_APP
      ? (localStorage.getItem('eve-stt-backend') === 'native' ? 'native' : 'server')
      : 'server';
    // Always start on server — VoiceInitCoordinator switches to preferred when ready
    this.activeBackend = this._createBackend('server');
    this.log = this._logger.child(`STT:${this.activeBackend.name}`);
    this.log.info(`Starting (preferred: ${this.preferredBackend})`);
  }

  get backend() {
    return this.activeBackend.name;
  }

  _createBackend(name) {
    switch (name) {
      case 'native': return new SttNativeBackend();
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
      log: this.log,
      onProgress: (data) => {
        if (this.activeBackend.ready) return;
        const pct = Math.round(data.progress || 0);
        this.app.voiceChatManager?._setPrompt(`Loading STT model: ${pct}%`);
      },
      onReady: () => {
        this.log.info('Backend ready');
        this.bus.emit(EVT.VOICE_BACKEND_CHANGED);
      },
      onError: (msg) => {
        this.log.error('Backend failed:', msg);
        this.app.messageRenderer?.appendSystemMessage(`On-device STT failed to load — falling back to server.`, 'warning');
        this.switchBackend('server', { persist: false });
      },
    };

    this.activeBackend.init(context);
  }

  async checkAvailability() {
    this.available = await this.activeBackend.isAvailable();
    if (!this.available) this.log.warn('Server STT daemon unavailable — mic disabled');
    this._updateButtonVisibility();
  }

  switchBackend(name, { persist = true } = {}) {
    const prev = this.activeBackend.name;
    this.activeBackend.destroy();
    this.activeBackend = this._createBackend(name);
    if (persist) {
      localStorage.setItem('eve-stt-backend', name);
      this.preferredBackend = name;
    }
    this._initBackend();
    this._updateButtonVisibility();
    this.log = this._logger.child(`STT:${name}`);
    this.log.info(`Switched from ${prev}`);
    this.bus.emit(EVT.VOICE_BACKEND_CHANGED);
  }

  setBackend(name) {
    this.switchBackend(name);
    this.available = true;
    this._updateButtonVisibility();
    this.log.info(`Backend changed → ${name}`);
  }

  toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  /**
   * `onFinal` takes over the result: it skips the textarea and is called once
   * with the cleaned text, or null when there is nothing to send (too short,
   * filtered, failed). `onPartial` gets the words heard so far while recording
   * (server backend only). Both are optional; with neither, the result goes to
   * the textarea as dictation.
   */
  async startRecording({ onPartial, onFinal } = {}) {
    this._finishTalk(null); // a holder from before gets its answer: nothing
    if (onFinal) {
      this._talk = {
        onPartial, onFinal,
        utteranceId: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        partialSentAt: 0, // 0 = no partial in flight
        stopped: false,
        finalPending: false,
        finalTimer: null,
      };
    }
    if (this.activeBackend.startRecording) {
      try {
        await this.activeBackend.startRecording((text) => this.handleTranscriptionResult(text));
        this.isRecording = true;
        this.recordingStartTime = Date.now();
        this._startTimer();
        this._updateUI();
      } catch (err) {
        this.log.error('Native recording failed:', err);
        this.app.messageRenderer.appendSystemMessage('Native STT failed: ' + err.message, 'error');
        this._finishTalk(null);
      }
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];

      if (!this.micContext) {
        this.micContext = new (window.AudioContext || window.webkitAudioContext)();
        this.micAnalyser = this.micContext.createAnalyser();
        this.micAnalyser.fftSize = 256;
        this._levelBuffer = new Uint8Array(this.micAnalyser.frequencyBinCount);
      }
      if (this.micContext.state === 'suspended') await this.micContext.resume();
      this._micSource = this.micContext.createMediaStreamSource(this.stream);
      this._micSource.connect(this.micAnalyser);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      const options = mimeType ? { mimeType } : {};
      this.mediaRecorder = new MediaRecorder(this.stream, options);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
        this._sendPartial();
      };

      this.mediaRecorder.onstop = () => {
        this._processRecording();
      };

      // A 1 s timeslice makes the recorder hand over chunks while it records,
      // which is what live words are built from.
      if (this._talk?.onPartial) this.mediaRecorder.start(1000);
      else this.mediaRecorder.start();
      this.isRecording = true;
      this.recordingStartTime = Date.now();
      this._startTimer();
      this._updateUI();
      this.log.info(`Recording started — backend: ${this.backend}`);
    } catch (err) {
      this.log.error('Microphone access denied:', err);
      this.app.messageRenderer.appendSystemMessage(
        'Microphone access denied. Check browser permissions.', 'error'
      );
      this._finishTalk(null);
    }
  }

  // Sends the recording so far for live words, unless one is still out. The
  // answer (or an error, or the 8 s allowance running out) frees the slot.
  _sendPartial() {
    const talk = this._talk;
    if (!talk?.onPartial || talk.stopped || talk.finalPending) return;
    if (talk.partialSentAt && Date.now() - talk.partialSentAt < 8000) return;
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;
    const blob = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType || 'audio/webm' });
    if (blob.size < 100) return;
    talk.partialSentAt = Date.now();
    Promise.resolve(this.activeBackend.transcribeBlob(blob, { partial: true, utteranceId: talk.utteranceId }))
      .catch((err) => {
        this.log.debug('Partial transcription not sent:', err.message);
        talk.partialSentAt = 0;
      });
  }

  _endTalk() {
    if (this._talk?.finalTimer) clearTimeout(this._talk.finalTimer);
    this._talk = null;
  }

  // Hands the final text (or null) to the holder's onFinal, once.
  _finishTalk(text) {
    const talk = this._talk;
    if (!talk) return;
    this._endTalk();
    try { talk.onFinal(text); } catch (err) { this.log.error('onFinal failed:', err); }
  }

  stopRecording() {
    this.log.info('Recording stopped');
    if (this._talk) this._talk.stopped = true;
    if (this.activeBackend.stopRecording) {
      this.activeBackend.stopRecording();
      if (this._talk) this._awaitFinal();
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

  async transcribeFloat32(audio) {
    if (!this.activeBackend.ready) {
      this.log.warn('Backend not ready, audio discarded');
      this.app.voiceChatManager?.handleError('STT model still loading — please wait');
      return;
    }
    try {
      const result = await this.activeBackend.transcribe(audio);
      if (result?.text) this.handleTranscriptionResult(result.text);
      // null result = server backend (result arrives via WS → handleTranscriptionResult)
    } catch (err) {
      this.log.error('Transcription failed:', err);
      this.app.voiceChatManager?.handleError('Transcription failed');
    }
  }

  async _processRecording() {
    const mimeType = this.mediaRecorder ? this.mediaRecorder.mimeType : 'audio/webm';
    const blob = new Blob(this.audioChunks, { type: mimeType });
    this.audioChunks = [];

    // Skip empty or very short recordings — MediaRecorder produces invalid containers
    const duration = this.recordingStartTime ? Date.now() - this.recordingStartTime : 0;
    if (blob.size < 100) {
      this.log.warn(`Empty recording (${blob.size} bytes), skipping`);
      this.app.voiceChatManager?.handleError('No audio captured');
      this._finishTalk(null);
      return;
    }
    if (duration < 300) {
      this.log.warn(`Recording too short (${duration}ms, ${blob.size} bytes), skipping`);
      this.app.voiceChatManager?.handleError('Recording too short — hold longer');
      if (!this.app.voiceChatManager?.isVoiceSession) {
        this.app.messageRenderer.appendSystemMessage('Recording too short. Hold the button longer to record.', 'warning');
      }
      this._finishTalk(null);
      return;
    }

    try {
      if (this._talk) this._awaitFinal();
      this._showTranscribingIndicator();
      const result = await this.activeBackend.transcribeBlob(blob);
      if (result?.text) {
        this.handleTranscriptionResult(result.text);
      }
      // null result = server backend (WS response triggers handleTranscriptionResult)
    } catch (err) {
      this.log.error('Recording transcription failed:', err);
      this._hideTranscribingIndicator();
      this.app.voiceChatManager?.handleError('Transcription failed');
      if (!this.app.voiceChatManager?.isVoiceSession) {
        this.app.messageRenderer.appendSystemMessage('Transcription failed. Please try again.', 'error');
      }
      this._finishTalk(null);
    }
  }

  // The final answer must arrive; if it never does, the holder is released.
  _awaitFinal() {
    const talk = this._talk;
    talk.finalPending = true;
    talk.finalTimer = setTimeout(() => {
      if (this._talk !== talk) return;
      this.log.warn('Final transcription never arrived');
      this._finishTalk(null);
    }, 30000);
  }

  handleTranscriptionResult(text, meta = {}) {
    if (meta.partial) {
      this._handlePartial(text, meta);
      return;
    }
    this._hideTranscribingIndicator();

    const cleaned = this._cleanTranscript(text);
    if (this._talk && (this._talk.finalPending || this.activeBackend.startRecording)) {
      this._finishTalk(cleaned);
      return;
    }
    if (!cleaned) {
      // Hands-free waits for this transcript; a filtered one must end that wait.
      this.app.voiceChatManager?.handleNoSpeech?.();
      return;
    }
    this._deliverTranscript(cleaned);
  }

  // A partial is live words only: dropped unless it answers the current
  // recording, and dropped once its final has been handed over.
  _handlePartial(text, meta) {
    const talk = this._talk;
    if (!talk?.onPartial || meta.utteranceId !== talk.utteranceId) return;
    talk.partialSentAt = 0;
    const cleaned = this._cleanTranscript(text, { quiet: true });
    if (cleaned) talk.onPartial(cleaned);
  }

  // Returns the text to use, or null when it is empty or not speech.
  _cleanTranscript(text, { quiet = false } = {}) {
    if (!text || !text.trim()) return null;
    const warn = quiet ? () => {} : (...a) => this.log.warn(...a);

    // Filter non-speech annotations the daemon emits, like [BLANK_AUDIO], [Crickets chirping], (silence).
    const cleaned = text.trim();
    if (!quiet) this.log.debug('STT result:', cleaned);
    if (/^\[.*\]$/.test(cleaned) || /^\(.*\)$/.test(cleaned)) {
      warn('Filtered Whisper artifact:', cleaned);
      return null;
    }

    // Drop results with no letters at all (music notes ♪, punctuation, "...").
    if (!/[a-z]/i.test(cleaned)) {
      warn('Filtered non-speech result:', cleaned);
      return null;
    }

    // Filter hallucinated output the daemon emits on non-speech background
    // noise (fan, footsteps, coughs, keyboard). Normalize away surrounding
    // punctuation/quotes ("You." → "you") and match only when the WHOLE
    // result is one of these, so real short commands ("yes", "stop") pass.
    const norm = cleaned.toLowerCase()
      .replace(/^[\s.,!?…"'’\-—]+|[\s.,!?…"'’\-—]+$/g, '')
      .replace(/\s+/g, ' ');
    const HALLUCINATIONS = new Set([
      'thank you', 'thanks', 'thanks for watching', 'thanks for listening',
      'you', 'bye', 'goodbye', 'the end', 'so',
      'hmm', 'mm', 'mhm', 'mm-hmm', 'uh-huh', 'uh', 'um', 'huh', 'ah', 'oh', 'eh', 'er',
      'subscribe', 'like and subscribe', 'please subscribe',
    ]);
    if (HALLUCINATIONS.has(norm) || norm.replace(/\./g, '').trim().length < 2) {
      warn('Filtered likely hallucination:', cleaned);
      return null;
    }
    return cleaned;
  }

  _deliverTranscript(cleaned) {
    if (this.app.voiceChatManager?.isVoiceSession) {
      this.app.voiceChatManager.handleTranscription(cleaned);
      return;
    }

    const textarea = this.app.elements.userInput;

    const existing = textarea.value;
    const separator = existing && !existing.endsWith(' ') ? ' ' : '';
    textarea.value = existing + separator + cleaned;
    this.app.autoResizeTextarea();
    textarea.focus();
  }

  handleTranscriptionError(error, meta = {}) {
    if (meta.partial) return; // live words are best effort
    this._hideTranscribingIndicator();
    this.log.error('Transcription error:', error);
    if (this._talk?.finalPending) this._finishTalk(null);
    this.app.messageRenderer.appendSystemMessage(
      `Transcription failed: ${error}`, 'error'
    );
  }

  getAudioLevel() {
    if (!this.micAnalyser || !this._levelBuffer) return 0;
    this.micAnalyser.getByteFrequencyData(this._levelBuffer);
    let sum = 0;
    for (let i = 0; i < this._levelBuffer.length; i++) sum += this._levelBuffer[i];
    return Math.min((sum / this._levelBuffer.length) / 128, 1);
  }

  _updateButtonVisibility() {
    const btn = this.button;
    if (btn) {
      btn.classList.toggle('hidden', !this.available);
    }
  }

  _updateUI() {
    const btn = this.button;
    if (btn) {
      btn.classList.toggle('btn-mic--recording', this.isRecording);
      btn.title = this.isRecording ? 'Stop recording' : 'Dictate (Speech-to-Text)';
    }
  }

  _startTimer() {
    const btn = this.button;
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
    const btn = this.button;
    if (btn) {
      btn.classList.add('btn-mic--transcribing');
      btn.title = 'Transcribing...';
    }
  }

  _hideTranscribingIndicator() {
    const btn = this.button;
    if (btn) {
      btn.classList.remove('btn-mic--transcribing');
      btn.title = 'Dictate (Speech-to-Text)';
    }
  }
}
