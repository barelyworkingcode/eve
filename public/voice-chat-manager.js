class VoiceChatManager {
  constructor(container) {
    this.app = container.get('app');
    this.bus = container.get('bus');
    this.log = container.get('logger').child('VoiceChat');
    this.isVoiceSession = false;
    this.isRecording = false;
    this.orbRenderer = null;
    this.captions = [];
    this.maxCaptions = 4;
    this.assistantAccum = '';
    this._spacebarDown = false;

    // Capacitor WebView defaults to conversation mode (like desktop); mobile Safari defaults to push-to-talk (AudioWorklet issues)
    this.inputMode = IS_NATIVE_AUDIO
      ? (localStorage.getItem('eve-voice-input-mode') || 'conversation')
      : ((IS_NATIVE_APP || !IS_MOBILE_SAFARI) ? 'conversation' : (localStorage.getItem('eve-voice-input-mode') || 'push-to-talk'));
    this.vadManager = new VadManager(container.get('logger').child('VAD'));
    this._vadTranscribing = false;

    // Native iOS audio transport: when present, the native AVAudioEngine owns
    // the mic + speaker so the conversation survives the screen turning off.
    this.useNativeAudio = IS_NATIVE_AUDIO;
    this.usingNativeSession = false;
    this.nativeAudio = this.useNativeAudio ? new NativeAudioBridge(container.get('logger').child('NativeAudio')) : null;
    this._nativeLevel = 0;
    this._assistantSpeaking = false;
    this._suppressTTSFrames = false;
    this._pendingInterruptNote = false;
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

    if (typeof VoiceOrbSettings !== 'undefined') {
      this.orbSettings = new VoiceOrbSettings(this);
      this.orbSettings.init();
    }

    this.bus.on(EVT.VOICE_BACKEND_CHANGED, () => {
      this._updateBackendStatus();
      if (this.isVoiceSession) {
        const mode = this.inputMode;
        this._setPrompt(mode === 'conversation' ? 'Listening...' : this._getPushToTalkPrompt());
      }
    });

    // Capture phase: must run before Monaco's own keydown listener
    document.addEventListener('keydown', (e) => this._onKeyDown(e), true);
    document.addEventListener('keyup', (e) => this._onKeyUp(e), true);

    if (this.micBtn) {
      this.micBtn.addEventListener('mousedown', () => this._onMicDown());
      this.micBtn.addEventListener('mouseup', () => this._onMicUp());
      this.micBtn.addEventListener('mouseleave', () => {
        if (this.isRecording) this._stopRecording();
      });
      this.micBtn.addEventListener('touchstart', (e) => { e.preventDefault(); this._onMicDown(); });
      this.micBtn.addEventListener('touchend', (e) => { e.preventDefault(); this._onMicUp(); });
    }

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

    if (this.closeBtn) {
      this.closeBtn.addEventListener('click', () => {
        if (this.app.currentSessionId) {
          this.app.tabManager.closeTab(this.app.currentSessionId);
        }
      });
    }

    if (this.convertBtn) {
      this.convertBtn.addEventListener('click', () => this.convertToWebChat());
    }

    if (this.drawerToggle) {
      this.drawerToggle.addEventListener('click', () => {
        this.drawerPanel?.classList.toggle('hidden');
        this.drawer?.classList.toggle('voice-drawer--open');
      });
    }

    if (this.voiceSelect) {
      this._populateVoiceSelect();
      this.voiceSelect.addEventListener('change', (e) => {
        this.app.ttsManager.setVoice(e.target.value);
        this.app.ttsManager.syncVoiceMode(this.app.wsClient);
      });
    }

    if (this.speedSelect) {
      this.speedSelect.value = String(this.app.ttsManager.speed);
      this.speedSelect.addEventListener('change', (e) => {
        this.app.ttsManager.setSpeed(e.target.value);
        this.app.ttsManager.syncVoiceMode(this.app.wsClient);
      });
    }

    if (this.modeToggle) {
      this._updateModeToggleUI();
      this.modeToggle.addEventListener('click', () => this._toggleInputMode());
    }

    this._initNativeAudio();
  }

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
    // Flush diagnostics the native engine buffered before this listener existed.
    this.nativeAudio.dumpLogs?.().then((res) => {
      const lines = res && res.lines;
      if (Array.isArray(lines) && lines.length) this._sendDeviceLog({ type: 'device_log', lines });
    }).catch(() => {});
  }

  _forwardDiagLog(d) {
    if (!d || !d.line) return;
    this._sendDeviceLog({ type: 'device_log', seq: d.seq, line: d.line });
  }

  _sendDeviceLog(payload) {
    try { this.app.wsClient?.send(payload); } catch (_) { /* never let diagnostics break voice */ }
  }

  _onNativeUtterance(base64) {
    if (!this.isVoiceSession || !base64) return;
    this._setOrbState('processing', 'native utterance');
    this._setPrompt('Transcribing...');
    this.app.wsClient.send({ type: 'transcribe_audio', audio: base64 });
  }

  _interruptGeneration(reason) {
    this._assistantSpeaking = false;
    this._suppressTTSFrames = true;
    this._pendingInterruptNote = true;
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue();
    this.app.handleStop();
    this.log.info(`Barge-in (${reason}) — generation stopped`);
  }

  _bargeIn(reason) {
    const speaking = this._assistantSpeaking || this.app.ttsManager.isPlaying;
    this.app.ttsManager.stop();
    if (speaking) this._interruptGeneration(reason);
  }

  getNativeLevel(state) {
    if (state === 'listening') return this._nativeLevel;
    if (state === 'speaking') return 0.5; // no native playback meter; steady mid-level
    return 0;
  }

  activateForSession(sessionId) {
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
    // Only halt in-progress speech when a real voice session is torn down.
    // deactivate() also runs on plain tab switches with read-aloud TTS on but
    // no voice session active — let that message finish rather than cut it off.
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

    // syncVoiceMode reconciles server voice_mode with the read-aloud toggle
    // instead of forcing it off — read-aloud TTS may still be enabled for the
    // chat being switched to, and the server needs voice_mode on to keep
    // emitting tts_audio.
    this.app.ttsManager.syncVoiceMode(this.app.wsClient);
  }

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

    this._bargeIn('vad');

    this._setOrbState('listening', 'speech detected');
    this._setPrompt('Listening...');
  }

  _onVADSpeechEnd(audio) {
    if (!this.isVoiceSession) return;

    // Drop if a transcription is already in flight — Chrome's AEC sometimes
    // leaks enough echo to trigger a second VAD cycle for the same utterance.
    if (this._vadTranscribing) return;

    this._setOrbState('processing', 'speech ended');
    this._setPrompt('Transcribing...');
    this._vadTranscribing = true;

    this.app.sttManager.transcribeFloat32(audio);
  }

  _onVADMisfire() {
    if (!this.isVoiceSession) return;
    if (!this._vadTranscribing && !this.app.ttsManager.isPlaying) {
      this._setOrbState('listening', 'VAD misfire');
      this._setPrompt('Listening...');
    }
  }

  _onMicDown() {
    if (this.inputMode === 'conversation') {
      if (this._assistantSpeaking || this.app.ttsManager.isPlaying) this._bargeIn('tap');
      return;
    }
    this._startRecording();
  }

  _onMicUp() {
    if (this.inputMode === 'conversation') return;
    this._stopRecording();
  }

  _onKeyDown(e) {
    if (!this.isVoiceSession) return;
    if (e.code !== 'Space') return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (document.querySelector('.dialog:not(.hidden)')) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.repeat) return;

    if (this.inputMode === 'conversation') {
      if (this.useNativeAudio) {
        // Native handsfree is already listening — spacebar only barges in.
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

    // Native handsfree needs no stop/resume on barge-in — the engine keeps listening.
    if (this.inputMode === 'conversation' && this.useNativeAudio) return;

    this._stopRecording();

    if (this.inputMode === 'conversation') {
      this.vadManager.resume();
    }
  }

  async _startRecording() {
    if (this.isRecording) return;
    this.isRecording = true;

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

    // Render into hidden chat history so convertToWebChat() shows this message.
    this.app.messageRenderer.appendUserMessage(text, []);

    this.assistantAccum = '';
    this._setOrbState('processing', 'transcription sent');
    this._setPrompt('Thinking...');
    if (this.useNativeAudio) this.nativeAudio.startThinkingCue();
  }

  handleAssistantDelta(text) {
    if (!this.isVoiceSession) return;
    this.assistantAccum += text;
    const clean = this.assistantAccum
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .replace(/<think>[\s\S]*$/g, '')
      .trim();
    if (clean) this._updateAssistantCaption(clean);
  }

  handleTTSStart() {
    if (!this.isVoiceSession) return;
    this._assistantSpeaking = true;
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue();
    // Pause VAD during TTS — browser echo cancellation (esp. Chrome) leaks
    // enough speaker audio to trigger false barge-in and duplicate messages.
    // Native audio needs no pause: it barge-ins via a stricter energy gate
    // with AEC active, or half-duplex without it.
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
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue(); // covers text-only replies, which have no TTS start/end to stop the cue

    const backend = this.app.ttsManager.backend;
    if (this.app.ttsManager.activeBackend.onDevice && this.assistantAccum.trim()) {
      this.app.ttsManager.speakText(this.assistantAccum);
    }

    this.assistantAccum = '';
  }

  _addCaption(role, text) {
    this.captions.push({ role, text, timestamp: Date.now() });
    if (this.captions.length > this.maxCaptions) {
      this.captions = this.captions.slice(-this.maxCaptions);
    }
    this._renderCaptions();
  }

  _updateAssistantCaption(text) {
    const last = this.captions[this.captions.length - 1];
    if (last && last.role === 'assistant') {
      last.text = text;
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

      const age = total - i;
      if (age > 2) el.classList.add('voice-chat__caption--fading');

      const maxLen = 200;
      const displayText = cap.text.length > maxLen ? cap.text.slice(0, maxLen) + '...' : cap.text;
      el.textContent = displayText;

      this.captionsEl.appendChild(el);
    });

    this.captionsEl.scrollTop = this.captionsEl.scrollHeight;
  }

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
    this.app.tabManager._saveSessionMeta(sessionId, { sessionType: 'voice' });
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
    this.app.tabManager._removeSessionMeta(sessionId);
    this.deactivate();
    this.app.tabManager.switchToTab(sessionId);
  }

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
   * A canvas's WebGL context is permanent once requested, so switching
   * renderers requires replacing the canvas element itself.
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
    this.orbRenderer.onInitError = () => this._makeOrbRenderer(null);
    this.orbRenderer.setState(currentState);
    if (wasRunning) this.orbRenderer.start();
    window.orbRenderer = this.orbRenderer;
    return this.orbRenderer;
  }

  _defaultOrbClass() {
    return (typeof VoiceOrb3D !== 'undefined' && VoiceOrb3D.isSupported()) ? VoiceOrb3D : null;
  }

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

    window.eveTune = (opts) => this.nativeAudio
      ? this.nativeAudio.setTuning(opts)
      : 'native audio unavailable';

    /** Persists across app restarts via native UserDefaults; default off. */
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
    const groups = {};
    for (const v of voices) {
      // The voice daemon emits `lang`; keep `language` as a fallback so a
      // voice never lands in "Other" on a field-name mismatch.
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
