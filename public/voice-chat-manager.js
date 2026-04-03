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
    this.isVoiceSession = false;
    this.isRecording = false;
    this.orbRenderer = null;
    this.captions = []; // [{role, text, timestamp}]
    this.maxCaptions = 4;
    this.assistantAccum = '';
    this._spacebarDown = false;

    // Capacitor WebView defaults to conversation mode (like desktop); mobile Safari defaults to push-to-talk (AudioWorklet issues)
    this.inputMode = (IS_NATIVE_APP || !IS_MOBILE_SAFARI) ? 'conversation' : (localStorage.getItem('eve-voice-input-mode') || 'push-to-talk');
    this.vadManager = new VadManager();
    this._vadTranscribing = false;
  }

  init() {
    this.voiceChatEl = document.getElementById('voiceChat');
    this.orbCanvas = document.getElementById('voiceOrbCanvas');
    this.captionsEl = document.getElementById('voiceCaptions');
    this.promptEl = document.getElementById('voiceChatPrompt');
    this.micBtn = document.getElementById('voiceChatMic');
    this.closeBtn = document.getElementById('voiceChatClose');
    this.voiceSelect = document.getElementById('voiceChatVoiceSelect');
    this.convertBtn = document.getElementById('voiceChatConvert');
    this.drawerToggle = document.getElementById('voiceChatDrawerToggle');
    this.drawerPanel = document.getElementById('voiceChatDrawerPanel');
    this.drawer = document.getElementById('voiceChatDrawer');
    this.modeToggle = document.getElementById('voiceChatModeToggle');
    this.backendStatusEl = document.getElementById('voiceChatBackendStatus');

    if (!this.orbCanvas) return;

    this.orbRenderer = new VoiceOrbCanvas(this.orbCanvas, this.app);

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

    // Mode toggle button
    if (this.modeToggle) {
      this._updateModeToggleUI();
      this.modeToggle.addEventListener('click', () => this._toggleInputMode());
    }
  }

  activateForSession(sessionId) {
    // Clean up any existing voice session (prevents listener leaks on session switch)
    this.vadManager.destroy();

    this.isVoiceSession = true;
    this.assistantAccum = '';
    this.captions = [];
    this._renderCaptions();
    this._updateBackendStatus();
    this.orbRenderer?.setState('idle');
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

    if (this.inputMode === 'conversation') {
      this._startConversationMode().catch(err => {
        console.error('[VoiceChat] Conversation mode failed:', err);
        this._setPrompt(this._getPushToTalkPrompt());
      });
    } else {
      this._setPrompt(this._getPushToTalkPrompt());
    }
  }

  deactivate() {
    this.isVoiceSession = false;
    this.isRecording = false;
    this._vadTranscribing = false;
    this.app.sttManager.stopRecording();
    this.app.ttsManager.stop();
    this.vadManager.destroy();
    this.orbRenderer?.stop();
  }

  // --- Input mode management ---

  _toggleInputMode() {
    if (this.inputMode === 'conversation') {
      this.inputMode = 'push-to-talk';
      this.vadManager.destroy();
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
    this.modeToggle.title = isConvo ? 'Switch to push-to-talk' : 'Switch to conversation mode';
    this.modeToggle.classList.toggle('voice-chat__btn--mode-active', isConvo);
    // Update mic button visibility — in conversation mode, mic is not the primary input
    if (this.micBtn) {
      this.micBtn.classList.toggle('voice-chat__btn--secondary', isConvo);
    }
  }

  async _startConversationMode() {
    this._setPrompt('Starting voice detection...');
    this.orbRenderer?.setState('idle');

    await this.vadManager.start({
      onSpeechStart: () => this._onVADSpeechStart(),
      onSpeechEnd: (audio) => this._onVADSpeechEnd(audio),
      onVADMisfire: () => this._onVADMisfire(),
      onError: (err) => {
        console.error('[VoiceChat] VAD failed:', err);
        this._setPrompt('Voice detection failed — using push-to-talk');
        this.inputMode = 'push-to-talk';
        localStorage.setItem('eve-voice-input-mode', this.inputMode);
        this._updateModeToggleUI();
      },
    });

    if (this.vadManager.isListening) {
      this.orbRenderer?.setState('listening');
      this._setPrompt('Listening...');
    }
  }

  _onVADSpeechStart() {
    if (!this.isVoiceSession) return;

    // Aggressive barge-in: always stop TTS immediately (safe to call even when not playing)
    this.app.ttsManager.stop();

    this.orbRenderer?.setState('listening');
    this._setPrompt('Listening...');
  }

  _onVADSpeechEnd(audio) {
    if (!this.isVoiceSession) return;

    this.orbRenderer?.setState('processing');
    this._setPrompt('Transcribing...');
    this._vadTranscribing = true;

    // Route through STT manager — handles browser/server backend selection
    this.app.sttManager.transcribeFloat32(audio);
  }

  _onVADMisfire() {
    // Too-short speech burst — return to listening state
    if (!this.isVoiceSession) return;
    if (!this._vadTranscribing && !this.app.ttsManager.isPlaying) {
      this.orbRenderer?.setState('listening');
      this._setPrompt('Listening...');
    }
  }

  // --- Mic button handling (adapts to mode) ---

  _onMicDown() {
    if (this.inputMode === 'conversation') return;
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
    this.app.ttsManager.stop();

    this.orbRenderer?.setState('listening');
    this._setPrompt('Listening...');
    this.micBtn?.classList.add('voice-chat__btn--recording');

    await this.app.sttManager.startRecording();
  }

  _stopRecording() {
    if (!this.isRecording) return;
    this.isRecording = false;

    this.orbRenderer?.setState('processing');
    this._setPrompt('Transcribing...');
    this.micBtn?.classList.remove('voice-chat__btn--recording');

    this.app.sttManager.stopRecording();
  }

  // --- Transcription + LLM flow ---

  handleTranscription(text) {
    this._vadTranscribing = false;
    this._addCaption('user', text);

    this.app.wsClient.send({
      type: 'user_input',
      text: text,
      files: [],
      sessionId: this.app.currentSessionId,
      dictated: true,
    });

    // Render in hidden chat so converting to web chat shows the message
    this.app.messageRenderer.appendUserMessage(text, []);

    this.assistantAccum = '';
    this.orbRenderer?.setState('processing');
    this._setPrompt('Thinking...');
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
    // VAD stays active during playback for voice barge-in.
    // Echo cancellation + higher thresholds filter speaker output.
    this.orbRenderer?.setState('speaking');
    this._setPrompt('Speaking...');
  }

  handleTTSEnd() {
    if (!this.isVoiceSession) return;

    if (this.vadManager.isListening) {
      this.orbRenderer?.setState('listening');
      this._setPrompt('Listening...');
    } else {
      this.orbRenderer?.setState('idle');
      this._setPrompt(this._getPushToTalkPrompt());
    }
  }

  handleError(message) {
    if (!this.isVoiceSession) return;
    this._addCaption('error', message);
    if (this.vadManager.isListening) {
      this.orbRenderer?.setState('listening');
      this._setPrompt('Listening...');
    } else {
      this.orbRenderer?.setState('idle');
      this._setPrompt(this._getPushToTalkPrompt());
    }
  }

  handleResponseComplete() {
    if (!this.isVoiceSession) return;

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
      const lang = v.language || 'Other';
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


/**
 * VoiceOrbCanvas - Wire-sphere with spikes visualization.
 * A scribbled ball of overlapping curved lines (like a wire-frame sphere)
 * with vector spikes that extend during recording/speaking.
 * States: idle, listening, processing, speaking.
 */
class VoiceOrbCanvas {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.app = app;
    this.ctx = canvas.getContext('2d');
    this.state = 'idle';
    this.targetState = 'idle';
    this.animationFrame = null;
    this.time = 0;
    this.running = false;

    this.currentColor = { r: 160, g: 160, b: 180 };
    this.spikeEnergy = 0;
    this.rotSpeed = 0;
    this.wobbleAmt = 0;
    this.audioLevel = 0; // smoothed 0-1 from mic or playback

    this.stateConfigs = {
      idle:       { color: { r: 140, g: 140, b: 165 }, spikes: 0.0,  rot: 0.1,  wobble: 0.03 },
      listening:  { color: { r: 220, g: 80,  b: 80  }, spikes: 0.75, rot: 0.3,  wobble: 0.10 },
      processing: { color: { r: 210, g: 170, b: 60  }, spikes: 0.25, rot: 0.6,  wobble: 0.06 },
      speaking:   { color: { r: 80,  g: 140, b: 220 }, spikes: 0.5,  rot: 0.2,  wobble: 0.12 },
    };

    this.wireLoops = [];
    this.spines = [];
    this._initWireLoops();
    this._initSpines();
    this._setupResize();
  }

  _initWireLoops() {
    // Generate great-circle-like loops at various tilts to create a wire sphere
    const count = 14;
    for (let i = 0; i < count; i++) {
      this.wireLoops.push({
        tilt: (i / count) * Math.PI,                    // tilt angle of this loop
        phase: Math.random() * Math.PI * 2,             // starting rotation phase
        wobbleFreq: 0.8 + Math.random() * 1.2,          // how fast this loop wobbles
        wobbleAmp: 0.02 + Math.random() * 0.04,         // how much it wobbles independently
        opacity: 0.15 + Math.random() * 0.25,
      });
    }
  }

  _initSpines() {
    const count = 60;
    for (let i = 0; i < count; i++) {
      this.spines.push({
        angle: (i / count) * Math.PI * 2,
        length: 0.3 + Math.random() * 0.7,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleFreq: 1.5 + Math.random() * 2.5,
        curvature: (Math.random() - 0.5) * 0.5,
        thickness: 0.4 + Math.random() * 0.5,
      });
    }
  }

  _setupResize() {
    const observer = new ResizeObserver(() => this._resize());
    observer.observe(this.canvas.parentElement);
    this._resize();
  }

  _resize() {
    const parent = this.canvas.parentElement;
    const size = Math.min(parent.clientWidth, parent.clientHeight, 360);
    this.canvas.width = size * 2;
    this.canvas.height = size * 2;
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    this.cx = this.canvas.width / 2;
    this.cy = this.canvas.height / 2;
    this.baseRadius = size * 0.35;
  }

  setState(state) { this.targetState = state; }

  start() {
    if (this.running) return;
    this.running = true;
    this._render();
  }

  stop() {
    this.running = false;
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  _lerp(a, b, t) { return a + (b - a) * t; }

  _render() {
    if (!this.running) return;

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.time += 0.016;

    const config = this.stateConfigs[this.targetState] || this.stateConfigs.idle;
    const ease = 0.04;

    // Read real-time audio level from mic or playback
    let rawLevel = 0;
    if (this.targetState === 'listening') {
      rawLevel = this.app?.sttManager?.getAudioLevel?.() || 0;
    } else if (this.targetState === 'speaking') {
      rawLevel = this.app?.ttsManager?.getAudioLevel?.() || 0;
    }
    this.audioLevel = this._lerp(this.audioLevel, rawLevel, 0.15);

    // Audio level boosts wobble and spike energy beyond base config values
    const audioBoost = this.audioLevel;

    this.currentColor.r = this._lerp(this.currentColor.r, config.color.r, ease);
    this.currentColor.g = this._lerp(this.currentColor.g, config.color.g, ease);
    this.currentColor.b = this._lerp(this.currentColor.b, config.color.b, ease);
    this.spikeEnergy = this._lerp(this.spikeEnergy, config.spikes + audioBoost * 0.4, ease * 3);
    this.rotSpeed = this._lerp(this.rotSpeed, config.rot + audioBoost * 0.2, ease);
    this.wobbleAmt = this._lerp(this.wobbleAmt, config.wobble + audioBoost * 0.15, ease * 3);

    const cr = Math.round(this.currentColor.r);
    const cg = Math.round(this.currentColor.g);
    const cb = Math.round(this.currentColor.b);

    const rotation = this.time * this.rotSpeed;

    // Soft center glow
    const glowR = this.baseRadius * 0.6;
    const gradient = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, glowR);
    gradient.addColorStop(0, `rgba(${cr}, ${cg}, ${cb}, 0.06)`);
    gradient.addColorStop(1, 'transparent');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, glowR, 0, Math.PI * 2);
    ctx.fill();

    // Draw wire-sphere loops: each is an ellipse (great circle projected)
    for (const loop of this.wireLoops) {
      const tilt = loop.tilt + rotation;
      const loopWobble = Math.sin(this.time * loop.wobbleFreq + loop.phase) * this.wobbleAmt;

      ctx.beginPath();
      const steps = 80;
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2;

        // 3D point on a unit sphere, then project
        const x3d = Math.cos(t);
        const y3d = Math.sin(t) * Math.cos(tilt);
        const z3d = Math.sin(t) * Math.sin(tilt);

        // Apply wobble distortion
        const wobbleDist = Math.sin(t * 5 + this.time * 1.5 + loop.phase) * this.wobbleAmt
                         + Math.sin(t * 8 + this.time * 2.3) * this.wobbleAmt * 0.5;
        const r = this.baseRadius * (1 + wobbleDist + loopWobble);

        // Simple perspective: push z slightly
        const perspective = 1 + z3d * 0.15;
        const px = this.cx + x3d * r * perspective;
        const py = this.cy + y3d * r * perspective;

        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${loop.opacity})`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // Draw spikes extending from sphere surface
    for (const spine of this.spines) {
      const a = spine.angle + rotation;

      // Find the surface radius at this angle (with wobble)
      const surfaceWobble = Math.sin(a * 5 + this.time * 1.5) * this.wobbleAmt
                          + Math.sin(a * 8 + this.time * 2.3) * this.wobbleAmt * 0.5;
      const surfaceR = this.baseRadius * (1 + surfaceWobble);

      // Spike length driven by energy
      const animWobble = Math.sin(this.time * spine.wobbleFreq + spine.wobblePhase) * 0.3;
      const spikeLen = this.baseRadius * spine.length * (0.08 + this.spikeEnergy * 0.92) * (0.7 + animWobble);

      if (spikeLen < 1.5) continue;

      const startX = this.cx + Math.cos(a) * surfaceR;
      const startY = this.cy + Math.sin(a) * surfaceR;

      const endR = surfaceR + spikeLen;
      const curveAngle = a + spine.curvature * (0.4 + this.spikeEnergy * 0.6);
      const endX = this.cx + Math.cos(curveAngle) * endR;
      const endY = this.cy + Math.sin(curveAngle) * endR;

      const midR = surfaceR + spikeLen * 0.55;
      const ctrlAngle = a + spine.curvature * 0.25;
      const ctrlX = this.cx + Math.cos(ctrlAngle) * midR;
      const ctrlY = this.cy + Math.sin(ctrlAngle) * midR;

      const alpha = 0.15 + (spikeLen / (this.baseRadius * 0.7)) * 0.5;

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${Math.min(alpha, 0.7)})`;
      ctx.lineWidth = spine.thickness * (0.8 + this.spikeEnergy * 0.6);
      ctx.stroke();
    }

    this.animationFrame = requestAnimationFrame(() => this._render());
  }
}
