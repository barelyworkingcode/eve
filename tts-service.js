/**
 * TTSService - TCP client for the Kokoro TTS daemon.
 * Length-prefixed JSON protocol over TCP on port 9997.
 */
const net = require('net');

class TTSService {
  constructor(host = 'localhost', port = 9997, timeout = 30000) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
  }

  async isAvailable() {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(2000);
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => { sock.destroy(); resolve(false); });
      sock.once('timeout', () => { sock.destroy(); resolve(false); });
      sock.connect(this.port, this.host);
    });
  }

  /**
   * @param {string} text
   * @param {string} voice - Voice preset ID (e.g. 'af_heart', 'am_adam')
   * @param {number} speed
   * @returns {Promise<{audio_base64: string, duration: number, sample_rate: number}>}
   */
  async synthesize(text, voice = 'af_heart', speed = 1.0) {
    const response = await this._sendRequest({ text, voice, speed });
    if (!response.success) {
      throw new Error(response.error || 'TTS generation failed');
    }
    return response;
  }

  async listVoices() {
    const response = await this._sendRequest({ action: 'list_voices' });
    if (!response.success) {
      throw new Error(response.error || 'Failed to list voices');
    }
    return response.voices;
  }

  _sendRequest(request) {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      sock.setTimeout(this.timeout);

      const chunks = [];
      let expectedLen = null;
      let received = 0;

      sock.on('connect', () => {
        const payload = Buffer.from(JSON.stringify(request), 'utf-8');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(payload.length, 0);
        sock.write(Buffer.concat([header, payload]));
      });

      sock.on('data', (chunk) => {
        chunks.push(chunk);
        received += chunk.length;

        if (expectedLen === null && received >= 4) {
          expectedLen = Buffer.concat(chunks).readUInt32BE(0);
        }

        if (expectedLen !== null && received >= expectedLen + 4) {
          const fullBuf = Buffer.concat(chunks);
          const payload = fullBuf.slice(4, 4 + expectedLen);
          sock.destroy();
          try {
            resolve(JSON.parse(payload.toString('utf-8')));
          } catch {
            reject(new Error('Invalid JSON response from TTS daemon'));
          }
        }
      });

      sock.on('error', (err) => {
        reject(new Error(`TTS daemon connection error: ${err.message}`));
      });

      sock.on('timeout', () => {
        sock.destroy();
        reject(new Error('TTS daemon request timed out'));
      });

      sock.connect(this.port, this.host);
    });
  }
}

module.exports = TTSService;
