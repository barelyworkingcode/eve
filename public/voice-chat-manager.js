/**
 * VoiceChatManager — the voice audio engine. Hands-free in the chat
 * (voice-modes.js) is its one user: VAD or the native audio session listens,
 * transcripts become spoken turns, replies play through TTSManager. It owns no
 * markup; VoiceModes draws the chat's voice UI from the events it emits.
 */
class VoiceChatManager {
  // River bed volume (native app only), set in Settings → Voice. Persisted
  // browser-side; the native engine resets to its default each launch, so the
  // saved value is pushed again at init.
  static RIVER_VOLUME_KEY = 'eve.riverVolume';
  static RIVER_VOLUME_DEFAULT = 0.12;
  static RIVER_VOLUME_MAX = 0.6;

  constructor(container) {
    this.app = container.get('app');
    this.bus = container.get('bus');
    this.log = container.get('logger').child('VoiceChat');
    this.isVoiceSession = false;
    this.assistantAccum = '';

    this.vadManager = new VadManager(container.get('logger').child('VAD'));
    this._vadTranscribing = false;

    // Native iOS audio transport: when present, the native AVAudioEngine owns
    // the mic + speaker so the conversation survives the screen turning off.
    this.useNativeAudio = IS_NATIVE_AUDIO;
    this.usingNativeSession = false;
    this.nativeAudio = this.useNativeAudio ? new NativeAudioBridge(container.get('logger').child('NativeAudio')) : null;
    this._assistantSpeaking = false;
    this._suppressTTSFrames = false;
    this._pendingInterruptNote = false;

    // _hfToken lets a start that was torn down mid-way notice.
    this._chatHandsFree = false;
    this._hfSessionId = null;
    this._hfToken = 0;
    this._publishedState = null;
    this._transcribeTimer = null;
    this._nativeStop = null;
  }

  init() {
    this._exposeDevHelpers();
    this._initNativeAudio();
  }

  get riverVolume() {
    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem(VoiceChatManager.RIVER_VOLUME_KEY)); } catch { /* storage blocked */ }
    if (Number.isNaN(saved)) return VoiceChatManager.RIVER_VOLUME_DEFAULT;
    return Math.min(VoiceChatManager.RIVER_VOLUME_MAX, Math.max(0, saved));
  }

  setRiverVolume(volume) {
    try { localStorage.setItem(VoiceChatManager.RIVER_VOLUME_KEY, String(volume)); } catch { /* storage blocked */ }
    this.nativeAudio?.setAmbientVolume(volume);
  }

  _initNativeAudio() {
    if (!this.useNativeAudio) return;
    this.nativeAudio.init({
      onListening:   () => { if (this.isVoiceSession) this._setState('listening', 'native listening'); },
      onSpeechStart: () => { if (this.isVoiceSession) { this._setState('listening', 'native speech'); this._publishState('hearing'); } },
      onSpeechEnd:   () => { if (this.isVoiceSession) this._setState('processing', 'native speech ended'); },
      onUtterance:   (d) => this._onNativeUtterance(d.audio),
      onSpeaking:    () => this.handleTTSStart(),
      onPlaybackEnded: (d) => { if (d && d.bargeIn) this._interruptGeneration('voice'); this.handleTTSEnd(); },
      onVADMisfire:  () => { this._pendingInterruptNote = false; this._suppressTTSFrames = false; if (this.isVoiceSession) this._setState('listening', 'native misfire'); },
      onInterruption: () => {},
      onRouteChange: () => {},
      onError:       (d) => this.handleError(d.message || 'Audio error'),
      onDiagLog:     (d) => this._forwardDiagLog(d),
    });
    // The engine forgets the river volume on every launch.
    this.nativeAudio.setAmbientVolume(this.riverVolume);
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
    this._setState('processing', 'native utterance');
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

  /**
   * Hands-free in the chat. Resolves once VAD listens (browser) or the native
   * session has started (iOS app); rejects with the reason it could not, or
   * with `cancelled` when deactivate() ran first.
   */
  async startHandsFree(sessionId) {
    if (this.isVoiceSession) this.deactivate();
    const token = ++this._hfToken;
    const cancelled = () => Object.assign(new Error('Hands-free was stopped before it started'), { cancelled: true });

    this.isVoiceSession = true;
    this._chatHandsFree = true;
    this._hfSessionId = sessionId;
    this._publishedState = null;
    this.assistantAccum = '';
    this._suppressTTSFrames = false;

    // Replies are always spoken here, without touching the saved speaker setting.
    const tts = this.app.ttsManager;
    tts.unlockAudio(); // iOS: inside the tap that started this
    tts.setEnabled(true);
    tts.syncButtonState();
    tts.syncVoiceMode(this.app.wsClient);

    try {
      if (this.useNativeAudio) {
        this.usingNativeSession = true;
        try {
          await this.nativeAudio.startSession('handsfree');
        } catch (err) {
          this.usingNativeSession = false;
          throw err;
        }
      } else {
        let failure = null;
        await this.vadManager.start({
          onSpeechStart: () => this._onVADSpeechStart(),
          onSpeechEnd: (audio) => this._onVADSpeechEnd(audio),
          onVADMisfire: () => this._onVADMisfire(),
          onError: (err) => { failure = err; },
        });
        if (token !== this._hfToken) { this.vadManager.destroy(); throw cancelled(); }
        if (failure || !this.vadManager.isListening) {
          this.vadManager.destroy();
          throw failure || new Error('Voice detection did not start');
        }
      }
    } catch (err) {
      if (token === this._hfToken) this.deactivate();
      throw err;
    }
    if (token !== this._hfToken) throw cancelled();
    this._setState('listening', 'hands-free ready');
  }

  // Ends Hands-free inside the tap that leaves it. The promise settles once the
  // native session is down, so a following getUserMedia (Talk) can wait on it.
  stopHandsFree() {
    this.deactivate();
    const pending = this._nativeStop;
    this._nativeStop = null;
    return Promise.resolve(pending).catch(() => {});
  }

  // Halts the spoken reply only. The text keeps streaming; its later audio is
  // dropped until the next turn (see _suppressTTSFrames).
  stopSpeaking() {
    if (!this.isVoiceSession) return;
    this._suppressTTSFrames = true;
    this.app.ttsManager.stop();
  }

  // The fixed reminder goes through the local voice daemon, never to the model.
  speakReminder(text) {
    if (!this.isVoiceSession) return;
    this._suppressTTSFrames = false;
    return this.app.ttsManager.speakText(text);
  }

  // A transcript that was filtered out as not speech ends the wait for it.
  handleNoSpeech() {
    if (!this._chatHandsFree) return;
    this._clearTranscribeWatchdog();
    this._vadTranscribing = false;
    if (!this._assistantSpeaking && !this.app.ttsManager.isPlaying) this._setState('listening', 'no speech');
  }

  _publishState(state) {
    if (!this._chatHandsFree || state === this._publishedState) return;
    this._publishedState = state;
    this.bus.emit(EVT.VOICE_STATE, { state, sessionId: this._hfSessionId });
  }

  // Whisper filtering can swallow a result without telling us; never stay deaf.
  _armTranscribeWatchdog() {
    this._clearTranscribeWatchdog();
    if (!this._chatHandsFree) return;
    this._transcribeTimer = setTimeout(() => this.handleNoSpeech(), 15000);
  }

  _clearTranscribeWatchdog() {
    if (this._transcribeTimer) clearTimeout(this._transcribeTimer);
    this._transcribeTimer = null;
  }

  deactivate() {
    // Only halt in-progress speech when a real voice session is torn down.
    // deactivate() also runs on plain tab switches with read-aloud TTS on but
    // no voice session active — let that message finish rather than cut it off.
    const wasVoiceSession = this.isVoiceSession;
    const wasChatHandsFree = this._chatHandsFree;
    this._hfToken++;
    this._clearTranscribeWatchdog();
    this.isVoiceSession = false;
    this._vadTranscribing = false;
    this._assistantSpeaking = false;
    this._suppressTTSFrames = false;
    this._pendingInterruptNote = false;
    if (this.useNativeAudio && this.usingNativeSession) {
      this.usingNativeSession = false;
      this._nativeStop = this.nativeAudio.stopSession();
    }
    this.app.sttManager.stopRecording();
    if (wasVoiceSession) this.app.ttsManager.stop();
    this.vadManager.destroy();

    // syncVoiceMode reconciles server voice_mode with the read-aloud toggle
    // instead of forcing it off — read-aloud TTS may still be enabled for the
    // chat being switched to, and the server needs voice_mode on to keep
    // emitting tts_audio.
    this.app.ttsManager.syncVoiceMode(this.app.wsClient);

    if (wasChatHandsFree) {
      this._publishState('idle');
      this._chatHandsFree = false;
      this._hfSessionId = null;
      this._publishedState = null;
    }
  }

  _onVADSpeechStart() {
    if (!this.isVoiceSession) return;

    this._bargeIn('vad');

    this._setState('listening', 'speech detected');
    this._publishState('hearing');
  }

  _onVADSpeechEnd(audio) {
    if (!this.isVoiceSession) return;

    // Drop if a transcription is already in flight — Chrome's AEC sometimes
    // leaks enough echo to trigger a second VAD cycle for the same utterance.
    if (this._vadTranscribing) return;

    this._setState('processing', 'speech ended');
    this._vadTranscribing = true;
    this._armTranscribeWatchdog();

    this.app.sttManager.transcribeFloat32(audio);
  }

  _onVADMisfire() {
    if (!this.isVoiceSession) return;
    if (!this._vadTranscribing && !this.app.ttsManager.isPlaying) {
      this._setState('listening', 'VAD misfire');
    }
  }

  handleTranscription(text) {
    this._vadTranscribing = false;
    this._clearTranscribeWatchdog();

    const interrupted = this._pendingInterruptNote;
    this._pendingInterruptNote = false;
    this._suppressTTSFrames = false;

    // The turn shows in the chat like any spoken turn; the note rides along unseen.
    const sent = this.app.sendSpokenTurn(text, { prefix: interrupted ? '[interrupted your previous reply] ' : '' });
    if (!sent) {
      this._setState('listening', 'turn not sent');
      return;
    }
    this.assistantAccum = '';
    this._setState('processing', 'transcription sent');
    if (this.useNativeAudio) this.nativeAudio.startThinkingCue();
  }

  handleAssistantDelta(text) {
    if (!this.isVoiceSession) return;
    this.assistantAccum += text;
  }

  handleTTSStart() {
    if (!this.isVoiceSession) return;
    this._assistantSpeaking = true;
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue();
    // Pause VAD during TTS — browser echo cancellation (esp. Chrome) leaks
    // enough speaker audio to trigger false barge-in and duplicate messages.
    // Native audio needs no pause: it barge-ins via a stricter energy gate
    // with AEC active, or half-duplex without it.
    if (!this.useNativeAudio) this.vadManager.pause();
    this._setState('speaking', 'TTS started');
  }

  handleTTSEnd() {
    if (!this.isVoiceSession) return;
    this._assistantSpeaking = false;
    if (!this.useNativeAudio) this.vadManager.resume();
    this._setState('listening', 'TTS ended');
  }

  // `alreadyShown`: the caller put the message in the chat itself.
  handleError(message, alreadyShown = false) {
    if (!this.isVoiceSession) return;
    if (!alreadyShown) this.app.messageRenderer.appendSystemMessage(message, 'error');
    this._vadTranscribing = false;
    this._clearTranscribeWatchdog();
    this._pendingInterruptNote = false;
    this._suppressTTSFrames = false;
    this.log.warn('Voice error:', message);
    if (this.useNativeAudio) {
      this.nativeAudio.stopThinkingCue();
      this.nativeAudio.playEarcon('error');
      this._setState('listening', 'error recovery');
      return;
    }
    this._setState(this.vadManager.isListening ? 'listening' : 'idle', 'error recovery');
  }

  handleResponseComplete() {
    if (!this.isVoiceSession) return;
    if (this.useNativeAudio) this.nativeAudio.stopThinkingCue(); // covers text-only replies, which have no TTS start/end to stop the cue

    if (this.app.ttsManager.activeBackend.onDevice && this.assistantAccum.trim() && !this._suppressTTSFrames) {
      this.app.ttsManager.speakText(this.assistantAccum);
    }

    this.assistantAccum = '';
  }

  // The loading messages of the TTS and STT managers land here; Hands-free
  // shows no prompt line, so they only reach the log.
  _setPrompt(text) {
    this.log.debug(`Voice: ${text}`);
  }

  _setState(state, reason) {
    this.log.debug(`State: ${state}` + (reason ? ` (${reason})` : ''));
    const published = { listening: 'listening', processing: 'thinking', speaking: 'speaking' }[state];
    if (published) this._publishState(published);
  }

  // Console helpers for the native engine; no screen offers them.
  _exposeDevHelpers() {
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
}
