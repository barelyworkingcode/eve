/**
 * STTService - TCP client for the Whisper STT daemon.
 * Mirrors the TTSService pattern: length-prefixed JSON over TCP.
 */
const net = require('net');

class STTService {
  constructor(host = 'localhost', port = 9998, timeout = 60000) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
  }

  /**
   * Check if the Whisper daemon is reachable.
   */
  async isAvailable() {
    try {
      const response = await this._sendRequest({ action: 'ping' }, 2000);
      return response.success === true;
    } catch {
      return false;
    }
  }

  /**
   * Transcribe base64-encoded audio.
   * @param {string} audioBase64 - Base64-encoded audio data (any format ffmpeg can decode)
   * @param {string|null} language - Optional language hint (e.g. 'en')
   * @returns {Promise<{text: string, language: string, duration: number, transcription_time: number}>}
   */
  async transcribe(audioBase64, language = null) {
    const request = { audio_base64: audioBase64 };
    if (language) request.language = language;
    const response = await this._sendRequest(request);
    if (!response.success) {
      throw new Error(response.error || 'Transcription failed');
    }
    return response;
  }

  /**
   * Send a length-prefixed JSON request to the daemon and receive the response.
   */
  _sendRequest(request, timeoutOverride) {
    const timeout = timeoutOverride || this.timeout;
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      sock.setTimeout(timeout);

      let responseData = Buffer.alloc(0);
      let expectedLen = null;

      sock.on('data', (chunk) => {
        responseData = Buffer.concat([responseData, chunk]);

        // Read 4-byte length header
        if (expectedLen === null && responseData.length >= 4) {
          expectedLen = responseData.readUInt32BE(0);
          responseData = responseData.slice(4);
        }

        // Check if we have the full payload
        if (expectedLen !== null && responseData.length >= expectedLen) {
          const payload = responseData.slice(0, expectedLen).toString('utf-8');
          sock.destroy();
          try {
            resolve(JSON.parse(payload));
          } catch (err) {
            reject(new Error(`Invalid JSON response: ${err.message}`));
          }
        }
      });

      sock.on('error', (err) => {
        sock.destroy();
        reject(new Error(`STT daemon connection error: ${err.message}`));
      });

      sock.on('timeout', () => {
        sock.destroy();
        reject(new Error('STT daemon request timed out'));
      });

      sock.connect(this.port, this.host, () => {
        const payload = Buffer.from(JSON.stringify(request), 'utf-8');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length, 0);
        sock.write(Buffer.concat([header, payload]));
      });
    });
  }
}

module.exports = STTService;
