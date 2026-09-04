/**
 * VoiceChatManager - Manages the voice-first chat UI with animated orb,
 * closed-caption text display, and two input modes:
 *   - Conversation mode: always-listening via VAD (Voice Activity Detection)
 *   - Push-to-talk mode: spacebar/mic button hold to record
 */
class VoiceChatManager {
  /**
   * @param {Container} container - DI container
   */
  constructor(container) {
    this.app = container.get('app'); // Legacy bridge — Phase 3 will remove
    this.bus = container.get('bus');
    this.log = container.get('logger').child('VoiceChat');
    this.isVoiceSession = false;
    this.isRecording = false;
    this.orbRenderer = null;
    this.captions = []; // [{role, text, timestamp}]
    this.maxCaptions = 4;
    this.assistantAccum = '';
    this._spacebarDown = false;

    // Capacitor WebView defaults to conversation mode (like desktop); mobile Safari defaults to push-to-talk (AudioWorklet issues)
    this.inputMode = IS_NATIVE_AUDIO
      ? (localStorage.getItem('eve-voice-input-mode') || 'conversation')
      : ((IS_NATIVE_APP || !IS_MOBILE_SAFARI) ? 'conversation' : (localStorage.getItem('eve-voice-input-mode') || 'push-to-talk'));
    this.vadManager = new VadManager(container.get('logger').child('VAD'));
    this._vadTranscribing = false;

    // Native audio transport (iOS): when present, the native AVAudioEngine owns
    // the mic + speaker so the conversation survives the screen turning off.
    // VadManager / getUserMedia / Web-Audio playback are bypassed entirely.
    this.useNativeAudio = IS_NATIVE_AUDIO;
    this.usingNativeSession = false; // true while a native voice session is live
    this.nativeAudio = this.useNativeAudio ? new NativeAudioBridge(container.get('logger').child('NativeAudio')) : null;
    this._nativeLevel = 0; // latest mic RMS from native onLevel (for the orb)
    this._assistantSpeaking = false; // true while a reply is being spoken
    this._suppressTTSFrames = false; // drop stale server TTS frames after a barge-in
    this._pendingInterruptNote = false; // tag the next user_input as interrupted
  }

  init() {
    this.voiceChatEl = document.getElementById('voiceChat');
    this.orbCanvas = document.getElementById('voiceOrbCanvas');
    this.captionsEl = document.getElementById('voiceCaptions');
    this.promptEl = document.getElementById('voiceChatPrompt');
    this.micBtn = document.getElementById('voiceChatMic');
    this.closeBtn = document.getElementById('voiceChatClose');
    this.voiceSelect = document.getElementById('voiceChatVoiceSelect');
    this.speedSelect = document.getElementById('voiceChatSpeedSelect');
    this.convertBtn = document.getElementById('voiceChatConvert');
    this.drawerToggle = document.getElementById('voiceChatDrawerToggle');
    this.drawerPanel = document.getElementById('voiceChatDrawerPanel');
    this.drawer = document.getElementById('voiceChatDrawer');
    this.modeToggle = document.getElementById('voiceChatModeToggle');
    this.backendStatusEl = document.getElementById('voiceChatBackendStatus');

    if (!this.orbCanvas) return;

    this._makeOrbRenderer(this._defaultOrbClass());
    this._exposeOrbControl();

    // Orb tuning sliders (gear button + bottom sheet)
    if (typeof VoiceOrbSettings !== 'undefined') {
      this.orbSettings = new VoiceOrbSettings(this);
      this.orbSettings.init();
    }

    // Update backend status display and prompt when backends change
    this.bus.on(EVT.VOICE_BACKEND_CHANGED, () => {
      this._updateBackendStatus();
      if (this.isVoiceSession) {
        const mode = this.inputMode;
        this._setPrompt(mode === 'conversation' ? 'Listening...' : this._getPushToTalkPrompt());
      }
    });

    // Spacebar handler (push-to-talk) — capture phase so we intercept before Monaco's body listener
    document.addEventListener('keydown', (e) => this._onKeyDown(e), true);
    document.addEventListener('keyup', (e) => this._onKeyUp(e), true);

    // Mic button (push-to-talk fallback + click alternative)
    if (this.micBtn) {
      this.micBtn.addEventListener('mousedown', () => this._onMicDown());
      this.micBtn.addEventListener('mouseup', () => this._onMicUp());
      this.micBtn.addEventListener('mouseleave', () => {
        if (this.isRecording) this._stopRecording();
      });
      this.micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this._onMicDown(); });
      this.micBtn.addEventListener('touchend', (e) => { e.preventDefault(); this._onMicUp(); });
    }

    // Orb canvas push-to-talk (press and hold to record, just like mic button)
    if (this.orbCanvas) {
      this.orbCanvas.addEventListener('mousedown', () => this._onMicDown());
      this.orbCanvas.addEventListener('mouseup', () => this._onMicUp());
      this.orbCanvas.addEventListener('mouseleave', () => {
        if (this.isRecording && !this._spacebarDown) this._stopRecording();
      });
      this.orbCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); this._onMicDown(); }, { passive: false });
      this.orbCanvas.addEventListener('touchend', (e) => { e.preventDefault(); this._onMicUp(); }, { passive: false });
      this.orbCanvas.addEventListener('touchcancel', () => this._onMicUp());
    }

    // Close button - end session
    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => {
        if (this.app.currentSessionId) {
          this.app.tabManager.closeTab(this.app.currentSessionId);
        }
      });
    }

    // Convert to web chat
    if (this.convertBtn) {
      this.convertBtn.addEventListener('click', () => this.convertToWebChat());
    }

    // Drawer toggle
    if (this.drawerToggle) {
      this.drawerToggle.addEventListener('click', () => {
        this.drawerPanel?.classList.toggle('hidden');
        this.drawer?.classList.toggle('voice-drawer--open');
      });
    }

    // Voice selection
    if (this.voiceSelect) {
      this._populateVoiceSelect();
      this.voiceSelect.addEventListener('change', (e) => {
        this.app.ttsManager.setVoice(e.target.value);
        this.app.ttsManager.syncVoiceMode(this.app.wsClient);
      });
    }

    // Playback speed
    if (this.speedSelect) {
      this.speedSelect.value = String(this.app.ttsManager.speed);
      this.speedSelect.addEventListener('change', (e) => {
        this.app.ttsManager.setSpeed(e.target.value);
        this.app.ttsManager.syncVoiceMode(this.app.wsClient);
      });
    }

    // Mode toggle button
    if (this.modeToggle) {
      this._updateModeToggleUI();
      this.modeToggle.addEventListener('click', () => this._toggleInputMode());
    }

    this._initNativeAudio();
  }

  /** Wire native AVAudioEngine events to the existing voice-session handlers. */
  _initNativeAudio() {
    if (!this.useNativeAudio) return;
    this.nativeAudio.init({
      onListening:   () => { if (this.isVoiceSession) { this._setOrbState('listening', 'native listening'); this._setPrompt('Listening...'); } },
      onSpeechStart: () => { if (this.isVoiceSession) { this._setOrbState('listening', 'native speech'); this._setPrompt('Listening...'); } },
      onSpeechEnd:   () => { if (this.isVoiceSession) { this._setOrbState('processing', 'native speech ended'); this._setPrompt('Transcribing...'); } },
      onUtterance:   (d) => this._onNativeUtterance(d.audio),
      onSpeaking:    () => this.handleTTSStart(),
      onPlaybackEnded: (d) => { if (d && d.bargeIn) this._interruptGeneration('voice'); this.handleTTSEnd(); },
      onLevel:       (d) => { this._nativeLevel = d.rms || 0; },
      onVADMisfire:  () => { this._pendingInterruptNote = false; this._suppressTTSFrames = false; if (this.isVoiceSession && this.inputMode === 'conversation') { this._setOrbState('listening', 'native misfire'); this._setPrompt('Listening...'); } },
      onInterruption: (d) => { if (this.isVoiceSession) this._setPrompt(d.state === 'began' ? 'Paused…' : 'Listening...'); },
      onRouteChange: () => {},
      onError:       (d) => this.handleError(d.message || 'Audio error'),
      onDiagLog:     (d) => this._forwardDiagLog(d),
    });
    // Flush diagnostics the native engine buffered before this listener existed
    // (app-launch → first session, i.e. the cold-start trace) so it isn't lost.
    this.nativeAudio.dumpLogs?.().then((res) => {
      const lines = res && res.lines;
      if (Array.isArray(lines) && lines.length) this._sendDeviceLog({ type: 'device_log', lines });
    }).catch(() => {});
  }

  /** Stream a native diagnostic line to eve so logs can be collected with no USB. */
  _forwardDiagLog(d) {
    if (!d || !d.line) return;
    this._sendDeviceLog({ type: 'device_log', seq: d.seq, line: d.line });
  }

  _sendDeviceLog(payload) {
    try { this.app.wsClient?.send(payload); } catch (_) { /* never let diagnostics break voice */ }
  }

  /** Native VAD finished an utterance — ship the WAV to server STT. */
  _onNativeUtterance(base64) {
    if (!this.isVoiceSession || !base64) return;
    this._setOrbState('processing', 'native utterance');
    this._setPrompt('Transcribing...');
    // Result returns via transcription_result → STTManager → handleTranscription().
    this.app.wsClient.send({ type: 'transcribe_audio', audio: base64 });
  }

  /**
   * Common barge-in bookkeeping once speech is already halted: stop the
   * in-flight LLM generation (handleStop also resets dispatcher/renderer turn
   * state), suppress TTS frames that were already in flight over the WS, and
   * tag the next transcription so the LLM knows its reply was cut off.
   */
  _interruptGeneration(reason) {
    this._assistantSpeaking = false;
    this._suppressTTSFrames = true;
    this._pendingInterruptNote = true;
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue();
    this.app.handleStop();
    this.log.info(`Barge-in (${reason}) — generation stopped`);
  }

  /** User-initiated interrupt (tap / spacebar / PTT): halt playback, then stop generation if a reply was being spoken. */
  _bargeIn(reason) {
    const speaking = this._assistantSpeaking || this.app.ttsManager.isPlaying;
    this.app.ttsManager.stop();
    if (speaking) this._interruptGeneration(reason);
  }

  /** Orb level source when native owns the audio (no Web-Audio analyser). */
  getNativeLevel(state) {
    if (state === 'listening') return this._nativeLevel;
    if (state === 'speaking') return 0.5; // no native playback meter; steady mid-level
    return 0;
  }

  activateForSession(sessionId) {
    // Fully tear down any existing voice session (stop TTS/STT, disable server voice mode)
    if (this.isVoiceSession) {
      this.deactivate();
    }

    this.isVoiceSession = true;
    this.assistantAccum = '';
    this.captions = [];
    this._renderCaptions();
    this._updateBackendStatus();
    this._setOrbState('idle', 'session activated');
    this.orbRenderer?.start();

    // Resume AudioContext now — voice session activation is triggered by user gesture
    this.app.ttsManager._ensureAudioContext();

    if (!this.app.ttsManager.enabled) {
      this.app.enableVoiceMode();
    }

    // Show permission hint on first voice session
    if (!localStorage.getItem('eve-voice-hint-dismissed')) {
      if (IS_SAFARI) {
        this._addCaption('error', 'Tip: In Safari Settings for this site, set Microphone to "Allow" and Auto-Play to "Allow All" for the best experience.');
      }
      localStorage.setItem('eve-voice-hint-dismissed', 'true');
    }

    if (this.useNativeAudio) {
      this._startNativeSession();
    } else if (this.inputMode === 'conversation') {
      this._startConversationMode().catch(err => {
        this.log.error('Conversation mode failed:', err);
        this._setPrompt(this._getPushToTalkPrompt());
      });
    } else {
      this._setPrompt(this._getPushToTalkPrompt());
    }
  }

  /** Hand the mic + speaker to the native engine for this session. */
  async _startNativeSession() {
    this.usingNativeSession = true;
    const mode = this.inputMode === 'conversation' ? 'handsfree' : 'ptt';
    if (mode === 'handsfree') {
      this._setOrbState('listening', 'native session');
      this._setPrompt('Listening...');
    } else {
      this._setOrbState('idle', 'native session');
      this._setPrompt(this._getPushToTalkPrompt());
    }
    try {
      await this.nativeAudio.startSession(mode);
    } catch (err) {
      this.log.error('Native session failed to start:', err);
      this.usingNativeSession = false;
      this._setPrompt('Voice unavailable');
    }
  }

  deactivate() {
    // Halt in-progress speech only when a real voice session is being torn
    // down (barge-in). deactivate() also runs on plain tab switches with
    // read-aloud TTS on but no voice session active — there, let the current
    // message finish playing rather than cutting it off mid-sentence.
    const wasVoiceSession = this.isVoiceSession;
    this.isVoiceSession = false;
    this.isRecording = false;
    this._vadTranscribing = false;
    this._assistantSpeaking = false;
    this._suppressTTSFrames = false;
    this._pendingInterruptNote = false;
    if (this.useNativeAudio && this.usingNativeSession) {
      this.usingNativeSession = false;
      this.nativeAudio.stopSession();
    }
    this.app.sttManager.stopRecording();
    if (wasVoiceSession) this.app.ttsManager.stop();
    this.vadManager.destroy();
    this.orbRenderer?.stop();

    // Reconcile server-side TTS with the read-aloud toggle instead of forcing
    // it off. deactivate() runs on every switch into a non-voice session tab
    // (TabManager.switchToTab), but read-aloud TTS (ttsManager.enabled) may
    // still be on for the chat we're landing on — and the server backend needs
    // voice_mode to keep emitting tts_audio. Blindly sending enabled:false here
    // left the speaker button lit but silent until a reconnect: switching tabs
    // and back killed TTS for all future messages. syncVoiceMode still sends
    // enabled:false when read-aloud is genuinely off (preserving teardown) and
    // is a no-op for on-device backends.
    this.app.ttsManager.syncVoiceMode(this.app.wsClient);
  }

  // --- Input mode management ---

  _toggleInputMode() {
    if (this.useNativeAudio) {
      this.inputMode = this.inputMode === 'conversation' ? 'push-to-talk' : 'conversation';
      const mode = this.inputMode === 'conversation' ? 'handsfree' : 'ptt';
      if (this.usingNativeSession) this.nativeAudio.setMode(mode);
      this.nativeAudio.haptic('light');
      if (mode === 'handsfree') {
        this._setOrbState('listening', 'mode: handsfree');
        this._setPrompt('Listening...');
      } else {
        this._setOrbState('idle', 'mode: push-to-talk');
        this._setPrompt(this._getPushToTalkPrompt());
      }
      localStorage.setItem('eve-voice-input-mode', this.inputMode);
      this._updateModeToggleUI();
      return;
    }

    if (this.inputMode === 'conversation') {
      this.inputMode = 'push-to-talk';
      this.vadManager.destroy();
      this._setOrbState('idle', 'switched to push-to-talk');
      this._setPrompt(this._getPushToTalkPrompt());
    } else {
      this.inputMode = 'conversation';
      if (this.isVoiceSession) {
        this._startConversationMode();
      }
    }
    localStorage.setItem('eve-voice-input-mode', this.inputMode);
    this._updateModeToggleUI();
  }

  _updateModeToggleUI() {
    if (!this.modeToggle) return;
    const isConvo = this.inputMode === 'conversation';
    const label = document.getElementById('voiceChatModeLabel');
    if (label) label.textContent = isConvo ? 'Hands-free' : 'Push-to-talk';
    this.modeToggle.title = isConvo
      ? 'Hands-free — tap for push-to-talk'
      : 'Push-to-talk — tap for hands-free';
    this.modeToggle.classList.toggle('voice-chat__mode-toggle--ptt', !isConvo);
    // Update mic button visibility — in conversation mode, mic is not the primary input
    if (this.micBtn) {
      this.micBtn.classList.toggle('voice-chat__btn--secondary', isConvo);
    }
  }

  async _startConversationMode() {
    this._setPrompt('Starting voice detection...');
    this._setOrbState('idle', 'starting VAD');

    await this.vadManager.start({
      onSpeechStart: () => this._onVADSpeechStart(),
      onSpeechEnd: (audio) => this._onVADSpeechEnd(audio),
      onVADMisfire: () => this._onVADMisfire(),
      onError: (err) => {
        this.log.error('VAD failed:', err);
        this._setPrompt('Voice detection failed — using push-to-talk');
        this.inputMode = 'push-to-talk';
        localStorage.setItem('eve-voice-input-mode', this.inputMode);
        this._updateModeToggleUI();
      },
    });

    if (this.vadManager.isListening) {
      this._setOrbState('listening', 'VAD ready');
      this._setPrompt('Listening...');
    }
  }

  _onVADSpeechStart() {
    if (!this.isVoiceSession) return;

    // Aggressive barge-in: always stop TTS immediately and halt generation if a reply was being spoken
    this._bargeIn('vad');

    this._setOrbState('listening', 'speech detected');
    this._setPrompt('Listening...');
  }

  _onVADSpeechEnd(audio) {
    if (!this.isVoiceSession) return;

    // Drop if a transcription is already in flight (Chrome's AEC sometimes
    // leaks enough echo to trigger a second VAD cycle for the same utterance)
    if (this._vadTranscribing) return;

    this._setOrbState('processing', 'speech ended');
    this._setPrompt('Transcribing...');
    this._vadTranscribing = true;

    // Route through STT manager — handles browser/server backend selection
    this.app.sttManager.transcribeFloat32(audio);
  }

  _onVADMisfire() {
    // Too-short speech burst — return to listening state
    if (!this.isVoiceSession) return;
    if (!this._vadTranscribing && !this.app.ttsManager.isPlaying) {
      this._setOrbState('listening', 'VAD misfire');
      this._setPrompt('Listening...');
    }
  }

  // --- Mic button handling (adapts to mode) ---

  _onMicDown() {
    if (this.inputMode === 'conversation') {
      // Tap to barge-in: stop TTS, VAD resumes via handleTTSEnd()
      if (this._assistantSpeaking || this.app.ttsManager.isPlaying) this._bargeIn('tap');
      return;
    }
    this._startRecording();
  }

  _onMicUp() {
    if (this.inputMode === 'conversation') return;
    this._stopRecording();
  }

  // --- Keyboard handling (push-to-talk) ---

  _onKeyDown(e) {
    if (!this.isVoiceSession) return;
    if (e.code !== 'Space') return;
    // Don't capture if user is typing in an input
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    // Don't capture if a dialog is open
    if (document.querySelector('.dialog:not(.hidden)')) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.repeat) return; // Already recording — just suppress the event

    if (this.inputMode === 'conversation') {
      if (this.useNativeAudio) {
        // Native handsfree is already listening; spacebar is just barge-in.
        this._bargeIn('spacebar');
        this._spacebarDown = true;
        return;
      }
      this.vadManager.pause();
    }
    this._spacebarDown = true;
    this._startRecording();
  }

  _onKeyUp(e) {
    if (!this.isVoiceSession) return;
    if (e.code !== 'Space') return;
    if (!this._spacebarDown) return;

    e.preventDefault();
    e.stopPropagation();
    this._spacebarDown = false;

    // Native handsfree barge-in needs no stop/resume — the engine keeps listening.
    if (this.inputMode === 'conversation' && this.useNativeAudio) return;

    this._stopRecording();

    if (this.inputMode === 'conversation') {
      // Resume VAD after manual push-to-talk
      this.vadManager.resume();
    }
  }

  async _startRecording() {
    if (this.isRecording) return;
    this.isRecording = true;

    // Stop any playing TTS (barge-in)
    this._bargeIn('ptt');

    this._setOrbState('listening', 'recording started');
    this._setPrompt('Listening...');
    this.micBtn?.classList.add('voice-chat__btn--recording');

    if (this.useNativeAudio) {
      this.nativeAudio.haptic('medium');
      this.nativeAudio.startCapture();
      return;
    }
    await this.app.sttManager.startRecording();
  }

  _stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;

    this._setOrbState('processing', 'recording stopped');
    this._setPrompt('Transcribing...');
    this.micBtn?.classList.remove('voice-chat__btn--recording');

    if (this.useNativeAudio) {
      this.nativeAudio.haptic('light');
      this.nativeAudio.stopCapture();
      return;
    }
    this.app.sttManager.stopRecording();
  }

  // --- Transcription + LLM flow ---

  handleTranscription(text) {
    this._vadTranscribing = false;

    const interrupted = this._pendingInterruptNote;
    this._pendingInterruptNote = false;
    this._suppressTTSFrames = false;
    const sendText = interrupted ? `[interrupted your previous reply] ${text}` : text;

    this._addCaption('user', text);

    this.app.messageDispatcher.markLocalSubmit(this.app.currentSessionId);
    this.app.wsClient.send({
      type: 'user_input',
      text: this.app._buildSendText(sendText, true),
      files: [],
      sessionId: this.app.currentSessionId,
      dictated: true,
    });

    // Render in hidden chat so converting to web chat shows the message
    this.app.messageRenderer.appendUserMessage(text, []);

    this.assistantAccum = '';
    this._setOrbState('processing', 'transcription sent');
    this._setPrompt('Thinking...');
    // Faint repeating cue while it's the AI's turn but it hasn't spoken yet
    // (thinking / tool-calling). Stopped when audio starts or the turn ends.
    if (this.useNativeAudio) this.nativeAudio.startThinkingCue();
  }

  handleAssistantDelta(text) {
    if (!this.isVoiceSession) return;
    this.assistantAccum += text;
    // Strip think tags and show clean text in captions
    const clean = this.assistantAccum
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .trim();
    if (clean) this._updateAssistantCaption(clean);
  }

  handleTTSStart() {
    if (!this.isVoiceSession) return;
    this._assistantSpeaking = true;
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue(); // it's speaking now
    // Pause VAD during TTS — browser echo cancellation (especially Chrome)
    // leaks enough speaker audio to trigger false barge-in and duplicate messages.
    // Barge-in is still available via mic/orb tap or spacebar. Native needs no
    // VAD pause: with AEC active, EveAudioEngine keeps the mic open behind a
    // stricter energy gate (voice barge-in); without AEC it falls back to
    // half-duplex (mic suppressed while speaking).
    if (this.inputMode === 'conversation' && !this.useNativeAudio) {
      this.vadManager.pause();
      this.micBtn?.classList.add('voice-chat__btn--muted');
    }
    this._setOrbState('speaking', 'TTS started');
    this._setPrompt('Speaking...');
  }

  handleTTSEnd() {
    if (!this.isVoiceSession) return;
    this._assistantSpeaking = false;

    if (this.useNativeAudio) {
      // Native re-opens the mic itself (emits onListening) for handsfree.
      if (this.inputMode === 'conversation') {
        this._setOrbState('listening', 'TTS ended');
        this._setPrompt('Listening...');
      } else {
        this._setOrbState('idle', 'TTS ended');
        this._setPrompt(this._getPushToTalkPrompt());
      }
      return;
    }

    if (this.inputMode === 'conversation') {
      this.vadManager.resume();
      this.micBtn?.classList.remove('voice-chat__btn--muted');
      this._setOrbState('listening', 'TTS ended');
      this._setPrompt('Listening...');
    } else {
      this._setOrbState('idle', 'TTS ended');
      this._setPrompt(this._getPushToTalkPrompt());
    }
  }

  handleError(message) {
    if (!this.isVoiceSession) return;
    this._vadTranscribing = false;
    this._pendingInterruptNote = false;
    this._suppressTTSFrames = false;
    this._addCaption('error', message);
    if (this.useNativeAudio) {
      this.nativeAudio.stopThinkingCue();
      this.nativeAudio.playEarcon('error');
      if (this.inputMode === 'conversation') {
        this._setOrbState('listening', 'error recovery');
        this._setPrompt('Listening...');
      } else {
        this._setOrbState('idle', 'error recovery');
        this._setPrompt(this._getPushToTalkPrompt());
      }
      return;
    }
    if (this.vadManager.isListening) {
      this._setOrbState('listening', 'error recovery');
      this._setPrompt('Listening...');
    } else {
      this._setOrbState('idle', 'error recovery');
      this._setPrompt(this._getPushToTalkPrompt());
    }
  }

  handleResponseComplete() {
    if (!this.isVoiceSession) return;
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue(); // turn over (covers text-only)

    // Client-side TTS: speak the accumulated text via browser or native backend
    const backend = this.app.ttsManager.backend;
    if (this.app.ttsManager.activeBackend.onDevice && this.assistantAccum.trim()) {
      this.app.ttsManager.speakText(this.assistantAccum);
    }

    this.assistantAccum = '';
  }

  // --- Captions ---

  _addCaption(role, text) {
    this.captions.push({ role, text, timestamp: Date.now() });
    // Keep only recent captions
    if (this.captions.length > this.maxCaptions) {
      this.captions = this.captions.slice(-this.maxCaptions);
    }
    this._renderCaptions();
  }

  _updateAssistantCaption(text) {
    // Update or add the latest assistant caption
    const last = this.captions[this.captions.length - 1];
    if (last && last.role === 'assistant') {
      last.text = text;
      // Fast path: update the existing DOM element's text without rebuilding
      const lastEl = this.captionsEl?.lastElementChild;
      if (lastEl) {
        const maxLen = 200;
        lastEl.textContent = text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
        this.captionsEl.scrollTop = this.captionsEl.scrollHeight;
        return;
      }
    } else {
      this.captions.push({ role: 'assistant', text, timestamp: Date.now() });
      if (this.captions.length > this.maxCaptions) {
        this.captions = this.captions.slice(-this.maxCaptions);
      }
    }
    this._renderCaptions();
  }

  _renderCaptions() {
    if (!this.captionsEl) return;
    this.captionsEl.innerHTML = '';

    const total = this.captions.length;
    this.captions.forEach((cap, i) => {
      const el = document.createElement('div');
      el.className = `voice-chat__caption voice-chat__caption--${cap.role}`;

      // Fade older captions
      const age = total - i;
      if (age > 2) el.classList.add('voice-chat__caption--fading');

      // Truncate long text for display
      const maxLen = 200;
      const displayText = cap.text.length > maxLen ? cap.text.slice(0, maxLen) + '...' : cap.text;
      el.textContent = displayText;

      this.captionsEl.appendChild(el);
    });

    // Scroll to bottom
    this.captionsEl.scrollTop = this.captionsEl.scrollHeight;
  }

  // --- Convert between modes ---

  convertToVoiceChat() {
    const sessionId = this.app.currentSessionId;
    if (!sessionId) return;
    const session = this.app.sessions.get(sessionId);
    if (session) {
      session.sessionType = 'voice';
      if (this.app.state) {
        const stateSession = this.app.state.sessions.get(session.id);
        if (stateSession) stateSession.sessionType = 'voice';
      }
    }
    // Persist session type
    this.app.tabManager._saveSessionMeta(sessionId, { sessionType: 'voice' });
    // Re-trigger tab switch to show voice UI
    this.app.tabManager.switchToTab(sessionId);
  }

  convertToWebChat() {
    const sessionId = this.app.currentSessionId;
    const session = this.app.sessions.get(sessionId);
    if (session) {
      session.sessionType = null;
      if (this.app.state) {
        const stateSession = this.app.state.sessions.get(session.id);
        if (stateSession) stateSession.sessionType = null;
      }
    }
    // Clear persisted session type
    this.app.tabManager._removeSessionMeta(sessionId);
    this.deactivate();
    // Re-trigger tab switch to show web chat UI
    this.app.tabManager.switchToTab(sessionId);
  }

  // --- Helpers ---

  _setPrompt(text) {
    if (this.promptEl) this.promptEl.textContent = text;
  }

  _updateBackendStatus() {
    if (!this.backendStatusEl) return;
    const tts = this.app.ttsManager;
    const stt = this.app.sttManager;
    const ttsLabel = tts.activeBackend.onDevice ? 'on-device' : 'server';
    const sttLabel = stt.activeBackend.onDevice ? 'on-device' : 'server';
    this.backendStatusEl.textContent = `TTS: ${ttsLabel}  ·  STT: ${sttLabel}`;
  }

  _setOrbState(state, reason) {
    this.log.debug(`Orb: ${state}` + (reason ? ` (${reason})` : ''));
    this.orbRenderer?.setState(state);
  }

  /**
   * (Re)build the orb renderer on a fresh canvas element. A canvas's context
   * type (webgl) is permanent once requested, so rebuilding requires
   * replacing the element itself. With Renderer null (WebGL unavailable, or
   * renderer init failed), the canvas is hidden and no renderer is
   * constructed — the rest of voice chat keeps working without the
   * visualiser.
   */
  _makeOrbRenderer(Renderer) {
    const currentState = this.orbRenderer?.targetState || 'idle';
    const wasRunning = this.orbRenderer?.running;
    if (this.orbRenderer?.destroy) this.orbRenderer.destroy();
    else this.orbRenderer?.stop();
    this.orbRenderer = null;
    window.orbRenderer = null;
    if (!Renderer) {
      this.orbCanvas.hidden = true;
      this.log.warn('Orb visualiser unavailable — hiding canvas; voice chat continues without it');
      return null;
    }
    const fresh = this.orbCanvas.cloneNode(false);
    this.orbCanvas.replaceWith(fresh);
    this.orbCanvas = fresh;
    this.orbCanvas.hidden = false;
    this.orbRenderer = new Renderer(this.orbCanvas, this.app);
    // Three.js import failure or WebGL context failure → no fallback
    // renderer; hide the canvas and continue.
    this.orbRenderer.onInitError = () => this._makeOrbRenderer(null);
    this.orbRenderer.setState(currentState);
    if (wasRunning) this.orbRenderer.start();
    window.orbRenderer = this.orbRenderer;
    return this.orbRenderer;
  }

  _defaultOrbClass() {
    return (typeof VoiceOrb3D !== 'undefined' && VoiceOrb3D.isSupported()) ? VoiceOrb3D : null;
  }

  /** Console helper: window.orb('speaking') or window.orb('idle', {r:255,g:0,b:0}) */
  _exposeOrbControl() {
    window.orb = (state, color) => {
      if (state && this.orbRenderer) {
        if (color) this.orbRenderer.stateConfigs[state] = { ...this.orbRenderer.stateConfigs[state], color };
        this.orbRenderer.setState(state);
        return `Orb → ${state}` + (color ? ` (color: ${JSON.stringify(color)})` : '');
      }
      return { states: Object.keys(this.orbRenderer?.stateConfigs || {}), current: this.orbRenderer?.targetState, configs: this.orbRenderer?.stateConfigs };
    };
    window.orbRenderer = this.orbRenderer;

    /** Console helper: window.orbDemo() to cycle states, window.orbDemo() again to stop */
    window.orbDemo = () => {
      if (this._demoInterval) {
        clearInterval(this._demoInterval);
        this._demoInterval = null;
        return 'Orb demo stopped';
      }
      const states = Object.keys(this.orbRenderer?.stateConfigs || {});
      if (!states.length || !this.orbRenderer) return 'No orb renderer available';
      let i = 0;
      this.orbRenderer.setState(states[0]);
      this._demoInterval = setInterval(() => {
        i = (i + 1) % states.length;
        this.orbRenderer.setState(states[i]);
        console.log(`Orb → ${states[i]}`);
      }, 5000);
      return `Orb demo started: cycling ${states.join(' → ')} every 5s (call orbDemo() again to stop)`;
    };

    /** Console helper: window.eveTune({bargeInRmsThreshold: 0.04, bargeInMinVoicedMs: 500}) */
    window.eveTune = (opts) => this.nativeAudio
      ? this.nativeAudio.setTuning(opts)
      : 'native audio unavailable';

    /** Console helper: window.eveDiag(true|false) — toggle device-log streaming to
     *  eve/relay-device.log. Persists across app restarts (native UserDefaults),
     *  default off, so you can enable it, relaunch, and capture the cold boot.
     *  window.eveDiag() with no arg reports the current state. */
    window.eveDiag = (on) => {
      if (!this.nativeAudio) return Promise.resolve('native audio unavailable');
      const p = on === undefined ? this.nativeAudio.getDiagLogging() : this.nativeAudio.setDiagLogging(on);
      return p.then((r) => `device-log streaming ${r && r.enabled ? 'ON' : 'OFF'}`);
    };
  }

  _getPushToTalkPrompt() {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    return isMobile ? 'Hold mic to speak...' : 'Hold spacebar to speak...';
  }

  _populateVoiceSelect() {
    if (!this.voiceSelect) return;
    // Delegate to the existing TTS manager voices
    const voices = this.app.ttsManager.voices || [];
    if (voices.length === 0) {
      this._voiceRetries = (this._voiceRetries || 0) + 1;
      if (this._voiceRetries < 5) {
        setTimeout(() => this._populateVoiceSelect(), 1000);
      }
      return;
    }
    this._voiceRetries = 0;

    this.voiceSelect.innerHTML = '';
    // Group by language
    const groups = {};
    for (const v of voices) {
      // Daemon emits `lang` (kokoro-compatible shape); keep `language` as a
      // fallback so a voice never lands in "Other" on a field-name mismatch.
      const lang = v.lang || v.language || 'Other';
      if (!groups[lang]) groups[lang] = [];
      groups[lang].push(v);
    }
    for (const [lang, voiceList] of Object.entries(groups)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = lang;
      for (const v of voiceList) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        if (v.id === this.app.ttsManager.voice) opt.selected = true;
        optgroup.appendChild(opt);
      }
      this.voiceSelect.appendChild(optgroup);
    }
  }
}
