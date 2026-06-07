/**
 * TtsServerBackend - Server-side TTS via Kokoro daemon.
 * Speech generation is handled by relay-client on the server.
 * Client receives audio chunks via WS `tts_audio` messages → TTSManager.enqueueAudio().
 * This backend handles voice loading and voice mode sync.
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

  /**
   * Send text to server for on-demand TTS synthesis.
   * Audio arrives via WS `tts_audio` → enqueueAudio().
   */
  speakText(text, voice, speed = 1.0) {
    const ws = this._app?.wsClient;
    if (ws) {
      ws.send({ type: 'tts_speak', text, voice, speed });
    }
    return null;
  }

  /**
   * Tell the server to abandon any in-flight read-aloud streaming (the user
   * stopped playback). Read-aloud now streams sentence-by-sentence, so without
   * this the daemon keeps synthesizing chunks nobody will hear.
   */
  cancelSpeak(ws) {
    (ws || this._app?.wsClient)?.send({ type: 'tts_speak_cancel' });
  }

  /**
   * Fetch available voices from the server daemon.
   */
  async loadVoices() {
    const token = localStorage.getItem('eve_session');
    const headers = token ? { 'x-session-token': token } : {};
    const res = await fetch('/api/tts/voices', { headers });
    if (!res.ok) throw new Error('TTS voices unavailable');
    return await res.json();
  }

  /**
   * Send voice_mode state to server so relay-client activates TTS.
   */
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
