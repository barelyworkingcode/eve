/**
 * TtsServerBackend - speech generation happens via relay-client on the
 * server, against the external TTS daemon. Client receives audio chunks via
 * WS `tts_audio` messages → TTSManager.enqueueServerAudioBuffer().
 */
class TtsServerBackend {
  constructor() {
    this.name = 'server';
    this.onDevice = false;
    
    this.ready = true;
    this.loading = false;
  }

  init(context) {
    this._app = context.app || null;
    context.onReady?.();
  }

  speakText(text, voice, speed = 1.0) {
    const ws = this._app?.wsClient;
    if (ws) {
      ws.send({ type: 'tts_speak', text, voice, speed });
    }
    return null;
  }

  /** Without this, the daemon keeps synthesizing chunks nobody will hear. */
  cancelSpeak(ws) {
    (ws || this._app?.wsClient)?.send({ type: 'tts_speak_cancel' });
  }

  async loadVoices() {
    const token = localStorage.getItem('eve_session');
    const headers = token ? { 'x-session-token': token } : {};
    const res = await fetch('/api/tts/voices', { headers });
    if (!res.ok) throw new Error('TTS voices unavailable');
    return await res.json();
  }

  syncVoiceMode(ws, enabled, voice, speed = 1.0) {
    ws.send({ type: 'voice_mode', enabled, voice, speed });
  }

  async isAvailable() {
    try {
      const token = localStorage.getItem('eve_session');
      const headers = token ? { 'x-session-token': token } : {};
      const res = await fetch('/api/tts/voices', { headers });
      return res.ok;
    } catch {
      return false;
    }
  }

  destroy() {}
}
