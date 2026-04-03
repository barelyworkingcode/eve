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
    context.onReady?.();
  }

  /**
   * No-op on client — relay-client handles server TTS generation.
   * Audio arrives via WS `tts_audio` → enqueueAudio().
   */
  speakText() {
    return null;
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
  syncVoiceMode(ws, enabled, voice) {
    ws.send({ type: 'voice_mode', enabled, voice });
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
