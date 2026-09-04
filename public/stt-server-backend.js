/**
 * SttServerBackend - sends audio over WebSocket to Eve's server, which
 * forwards it to the external STT daemon. Results arrive asynchronously via
 * WS `transcription_result` / `transcription_error` messages, routed by
 * message-dispatcher to STTManager.handleTranscriptionResult().
 */
class SttServerBackend {
  constructor() {
    this.name = 'server';
    this.onDevice = false;
    
    this.ready = true;
    this.loading = false;
  }

  init(context) {
    this._wsClient = context.wsClient;
    context.onReady?.();
  }

  /** Returns null — result arrives via WS dispatcher → handleTranscriptionResult(). */
  transcribe(audio) {
    const base64Wav = VadManager.audioToBase64Wav(audio);
    this._wsClient.send({ type: 'transcribe_audio', audio: base64Wav });
    return null;
  }

  /** Returns null — result arrives via WS dispatcher. */
  async transcribeBlob(blob) {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (!reader.result) { reject(new Error('Failed to read audio recording')); return; }
        resolve(reader.result.split(',')[1]);
      };
      reader.onerror = () => reject(new Error('Failed to process audio recording'));
      reader.readAsDataURL(blob);
    });
    this._wsClient.send({ type: 'transcribe_audio', audio: base64 });
    return null;
  }

  async isAvailable() {
    try {
      const token = localStorage.getItem('eve_session');
      const headers = token ? { 'x-session-token': token } : {};
      const res = await fetch('/api/stt/status', { headers });
      if (res.ok) {
        const data = await res.json();
        return data.available === true;
      }
      return false;
    } catch {
      return false;
    }
  }

  destroy() {
    this._wsClient = null;
  }
}
