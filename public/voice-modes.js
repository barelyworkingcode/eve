/**
 * VoiceModes — the chat's voice UI: the Text / Talk / Hands-free control above
 * the composer, the hold-to-talk button, and the "Speak replies" header button.
 *
 * VoiceChatManager stays the audio engine (orb view, VAD, native audio);
 * STTManager records and returns words; TTSManager plays replies. This class
 * only decides what the chat shows and wires those three together.
 *
 * Mode is per page load (not stored). The speaker is per device: localStorage
 * `eve-speaker` 'on' | 'off', absent = off.
 */
class VoiceModes {
  static MODES = [
    { id: 'text', label: 'Text' },
    { id: 'talk', label: 'Talk' },
    { id: 'handsfree', label: 'Hands-free' },
  ];
  static SPEAKER_KEY = 'eve-speaker';
  static HOLD_LABEL = 'Hold to talk';
  static RELEASE_LABEL = 'Release to send';

  constructor(container) {
    this.container = container;
    this.app = container.get('app');
    this.bus = container.get('bus');
    this.log = container.get('logger').child('VoiceModes');
    this._mode = 'text';
    this._speakerOn = localStorage.getItem(VoiceModes.SPEAKER_KEY) === 'on';
    this._holding = false;      // the person is pressing the Talk button
    this._starting = false;     // recorder is being opened
    this._awaitingFinal = false; // released; the words are still coming back
    this._talkSessionId = null;
    this.radios = new Map();
    this.speakerBtn = null;
    this.talkBtn = null;
  }

  get mode() { return this._mode; }
  get speakerOn() { return this._speakerOn; }

  init() {
    this.form = document.getElementById('inputForm');
    if (!this.form) return;
    this._buildModeControl();
    this._buildTalkButton();
    this._buildSpeakerButton();

    // Boot: the stored setting decides whether replies are spoken.
    this.app.ttsManager.setEnabled(this._speakerOn);
    this.app.ttsManager.syncButtonState();
    if (this._speakerOn) this.app.ttsManager.syncVoiceMode(this.app.wsClient);

    const sync = () => this._syncSpeakerVisibility();
    for (const evt of [EVT.SESSION_SWITCH, EVT.SESSION_UPDATED, EVT.SESSION_REMOVED]) {
      if (evt) this.bus.on(evt, sync);
    }
    // Tab changes of any kind rewrite the tab bar; the button shows on chat tabs only.
    const bar = document.getElementById('tabBar');
    if (bar && typeof MutationObserver !== 'undefined') {
      new MutationObserver(sync).observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    this._render();
  }

  setMode(mode) {
    if (!VoiceModes.MODES.some(m => m.id === mode) || mode === this._mode) return;
    if (mode === 'handsfree' && !this.app.currentSessionId) return;
    if (this._holding || this._starting) this._cancelTalk();
    this._mode = mode;
    this._render();
    this.bus.emit(EVT.VOICE_MODE_CHANGED, { mode, sessionId: this.app.currentSessionId });
    // In this batch Hands-free is today's orb view, so there is no dead control.
    if (mode === 'handsfree') this.app.voiceChatManager.convertToVoiceChat();
  }

  setSpeaker(on) {
    on = !!on;
    this._speakerOn = on;
    localStorage.setItem(VoiceModes.SPEAKER_KEY, on ? 'on' : 'off');
    const tts = this.app.ttsManager;
    if (on) tts.unlockAudio(); // iOS: unlock audio within the tap
    this._applySpeaker();
    this._renderSpeaker();
  }

  // Last step of the chat view's show. Arriving back from the orb view ends
  // Hands-free; the orb view may also have switched replies on, so the stored
  // speaker setting is restored.
  onChatShown(sessionId) {
    if (this._holding || this._starting) this._cancelTalk();
    if (this._mode === 'handsfree') {
      this._mode = 'text';
      this.bus.emit(EVT.VOICE_MODE_CHANGED, { mode: 'text', sessionId });
    }
    if (this.app.ttsManager.enabled !== this._speakerOn) this._applySpeaker();
    this._render();
  }

  _applySpeaker() {
    const tts = this.app.ttsManager;
    tts.setEnabled(this._speakerOn);
    tts.syncButtonState();
    tts.syncVoiceMode(this.app.wsClient);
  }

  // — Mode control ----------------------------------------------------------

  _buildModeControl() {
    const group = document.createElement('div');
    group.className = 'voice-modes';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Voice mode');
    group.dataset.testid = 'voice-modes';
    for (const { id, label } of VoiceModes.MODES) {
      const radio = document.createElement('button');
      radio.type = 'button';
      radio.className = 'voice-modes__radio';
      radio.setAttribute('role', 'radio');
      radio.dataset.mode = id;
      radio.textContent = label;
      radio.addEventListener('click', () => this.setMode(id));
      radio.addEventListener('keydown', (e) => this._onRadioKey(e, id));
      group.appendChild(radio);
      this.radios.set(id, radio);
    }
    this.form.parentNode.insertBefore(group, this.form);
    this.group = group;
  }

  _onRadioKey(e, id) {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const ids = VoiceModes.MODES.map(m => m.id);
    const next = ids[(ids.indexOf(id) + dir + ids.length) % ids.length];
    this.setMode(next);
    this.radios.get(this._mode)?.focus();
  }

  // — Talk ------------------------------------------------------------------

  _buildTalkButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'talkBtn';
    btn.className = 'btn-talk';
    btn.dataset.testid = 'chat-talk';
    btn.hidden = true;
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = VoiceModes.HOLD_LABEL;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      this._press();
    });
    for (const type of ['pointerup', 'pointercancel']) {
      btn.addEventListener(type, () => this._release());
    }
    btn.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault(); // no click from Space/Enter: the hold is the gesture
      if (!e.repeat) this._press();
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      this._release();
    });
    btn.addEventListener('blur', () => this._release());
    btn.addEventListener('contextmenu', (e) => e.preventDefault()); // touch long-press

    const textarea = document.getElementById('userInput');
    this.form.insertBefore(btn, textarea ? textarea.nextSibling : null);
    this.talkBtn = btn;
  }

  async _press() {
    if (this._holding || this._starting || this._awaitingFinal) return;
    const app = this.app;
    const stt = app.sttManager;
    if (!app.currentSessionId) return;
    if (stt.available === false) {
      app.messageRenderer.appendSystemMessage('Speech-to-text is unavailable.', 'warning');
      return;
    }
    this._holding = true;
    this._starting = true;
    this._talkSessionId = app.currentSessionId;

    // Speaking over a reply ends the reply first.
    if (app.ttsManager.isPlaying || app.ttsManager.enabled) app.ttsManager.stop();

    await stt.startRecording({
      onPartial: (text) => app.messageRenderer.showLiveUserTurn(text),
      onFinal: (text) => this._onFinal(text),
    });
    this._starting = false;
    if (!stt.isRecording) {
      // The recorder never opened (mic blocked); startRecording said why.
      this._holding = false;
      this._awaitingFinal = false;
      this._renderTalk();
      return;
    }
    if (!this._holding) {
      // Let go before the recorder opened.
      this._awaitFinal();
      stt.stopRecording();
    }
    this._renderTalk();
  }

  _release() {
    if (!this._holding) return;
    this._holding = false;
    if (this._starting) { this._renderTalk(); return; } // _press finishes the stop
    this._awaitFinal();
    this.app.sttManager.stopRecording();
    this._renderTalk();
  }

  _awaitFinal() {
    this._awaitingFinal = true;
  }

  _onFinal(text) {
    this._awaitingFinal = false;
    this.app.messageRenderer.clearLiveUserTurn();
    const sameChat = this._talkSessionId === this.app.currentSessionId;
    this._talkSessionId = null;
    if (text && sameChat) this.app.sendSpokenTurn(text);
    this._renderTalk();
  }

  // Leaving Talk (or the chat) mid-hold throws the recording away.
  _cancelTalk() {
    this._holding = false;
    this._starting = false;
    this._talkSessionId = null; // _onFinal then sends nothing
    if (this.app.sttManager.isRecording) this.app.sttManager.stopRecording();
    this._renderTalk();
  }

  // — Speaker button --------------------------------------------------------

  _buildSpeakerButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'speakerBtn';
    btn.className = 'btn-speaker hidden';
    btn.dataset.testid = 'thread-speaker';
    btn.setAttribute('aria-label', 'Speak replies');
    btn.title = 'Speak replies';
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <path d="M11 5L6 9H2v6h4l5 4V5z"/>
  <path d="M19.07 4.93a10 10 0 010 14.14"/>
  <path d="M15.54 8.46a5 5 0 010 7.07"/>
</svg>`;
    btn.addEventListener('click', () => this.setSpeaker(!this._speakerOn));
    const anchor = document.getElementById('makeRoutineBtn');
    if (anchor?.parentNode) anchor.parentNode.insertBefore(btn, anchor);
    else document.querySelector('.chat-header')?.appendChild(btn);
    this.speakerBtn = btn;
  }

  // The button belongs to chat tabs; the same test RoutinePanel uses.
  _onChatTab() {
    if (!this.container.has('tabManager')) return false;
    const tm = this.container.get('tabManager');
    const tab = tm.tabs.find(t => t.id === tm.activeTabId);
    if (!tab || tab.type !== 'session') return false;
    const session = this.app.state.sessions.get(tab.id);
    return !!session && session.sessionType !== 'voice';
  }

  _syncSpeakerVisibility() {
    this.speakerBtn?.classList.toggle('hidden', !(this._onChatTab() && this._mode !== 'handsfree'));
  }

  _renderSpeaker() {
    this.speakerBtn?.setAttribute('aria-pressed', String(this._speakerOn));
    this.speakerBtn?.classList.toggle('btn-speaker--on', this._speakerOn);
  }

  // — Rendering -------------------------------------------------------------

  _render() {
    for (const [id, radio] of this.radios) {
      const checked = id === this._mode;
      radio.setAttribute('aria-checked', String(checked));
      radio.tabIndex = checked ? 0 : -1;
    }
    this.form.dataset.voiceMode = this._mode;
    this._renderTalk();
    this._renderSpeaker();
    this._syncSpeakerVisibility();
  }

  _renderTalk() {
    const btn = this.talkBtn;
    if (!btn) return;
    btn.hidden = this._mode !== 'talk';
    // Pressed only once the recorder is running: the label then tells the
    // person it is safe to speak.
    const recording = this._holding && !this._starting && this.app.sttManager.isRecording;
    btn.setAttribute('aria-pressed', String(recording));
    btn.textContent = recording ? VoiceModes.RELEASE_LABEL : VoiceModes.HOLD_LABEL;
    btn.classList.toggle('btn-talk--recording', recording);
  }
}
