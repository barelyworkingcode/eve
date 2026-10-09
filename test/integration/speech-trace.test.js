const net = require('net');
const WebSocket = require('ws');
const TTSService = require('../../tts-service');
const STTService = require('../../stt-service');
const RelayClient = require('../../relay-client');
const voiceMessages = require('../../ws/voice-messages');

const VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;
const GOOD_ID = 'trace-abcd1234';

// Loopback daemon speaking the 4-byte big-endian length-prefixed JSON protocol.
function startDaemon(reply) {
  const requests = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < 4 + buf.readUInt32BE(0)) return;
      requests.push(JSON.parse(buf.slice(4, 4 + buf.readUInt32BE(0)).toString('utf-8')));
      const out = Buffer.from(JSON.stringify(reply), 'utf-8');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(out.length, 0);
      sock.end(Buffer.concat([header, out]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

describe('trace ID in speech service request frames', () => {
  let daemon;
  afterEach(() => new Promise((r) => (daemon ? daemon.server.close(r) : r())));

  describe('TTSService', () => {
    beforeEach(async () => { daemon = await startDaemon({ success: true, audio_base64: 'AAAA' }); });

    it('sends trace_id when given a traceId', async () => {
      await new TTSService('127.0.0.1', daemon.port).synthesize('Hello there', 'af_heart', 1.0, null, 1.0, { traceId: GOOD_ID });
      expect(daemon.requests[0].trace_id).toBe(GOOD_ID);
    });

    it('omits trace_id without the option', async () => {
      await new TTSService('127.0.0.1', daemon.port).synthesize('Hello there');
      expect(daemon.requests[0]).not.toHaveProperty('trace_id');
    });
  });

  describe('STTService', () => {
    beforeEach(async () => { daemon = await startDaemon({ success: true, text: 'hi' }); });

    it('sends trace_id when given a traceId', async () => {
      await new STTService('127.0.0.1', daemon.port).transcribe('QUJD', 'en', { traceId: GOOD_ID });
      expect(daemon.requests[0].trace_id).toBe(GOOD_ID);
    });

    it('omits trace_id without the option', async () => {
      await new STTService('127.0.0.1', daemon.port).transcribe('QUJD', 'en');
      expect(daemon.requests[0]).not.toHaveProperty('trace_id');
    });
  });

  describe('ws voice handlers', () => {
    const handler = (type) => voiceMessages.find((d) => d.type === type).handle;
    const AUDIO = 'A'.repeat(200);
    const tick = () => new Promise((r) => setTimeout(r, 20));

    function ctxFor(message, deps) {
      return { ws: { send: jest.fn() }, message, log: null, deps };
    }

    it.each([
      ['a valid client ID', GOOD_ID, (id) => expect(id).toBe(GOOD_ID)],
      ['an invalid client ID', 'bad id!', (id) => expect(id).toMatch(VALID_ID)],
      ['a missing client ID', undefined, (id) => expect(id).toMatch(VALID_ID)],
    ])('transcribe_audio passes %s to the STT service', async (_n, clientId, check) => {
      const sttService = { transcribe: jest.fn().mockResolvedValue({ text: 'x' }) };
      handler('transcribe_audio')(ctxFor({ type: 'transcribe_audio', audio: AUDIO, trace_id: clientId }, { sttService }));
      await tick();
      expect(sttService.transcribe).toHaveBeenCalledTimes(1);
      const args = sttService.transcribe.mock.calls[0];
      check(args[args.length - 1].traceId);
    });

    it.each([
      ['a valid client ID', GOOD_ID, (id) => expect(id).toBe(GOOD_ID)],
      ['an invalid client ID', 'bad id!', (id) => expect(id).toMatch(VALID_ID)],
      ['a missing client ID', undefined, (id) => expect(id).toMatch(VALID_ID)],
    ])('tts_speak passes %s to the TTS service', async (_n, clientId, check) => {
      const ttsService = { synthesize: jest.fn().mockResolvedValue({ audio_base64: 'AAAA' }) };
      handler('tts_speak')(ctxFor({ type: 'tts_speak', text: 'Hello there, this is a test.', trace_id: clientId }, { ttsService }));
      await tick();
      expect(ttsService.synthesize).toHaveBeenCalled();
      const args = ttsService.synthesize.mock.calls[0];
      check(args[args.length - 1].traceId);
    });
  });

  describe('RelayClient speech chain', () => {
    it('uses the sendMessage turn ID for every TTS chunk of the turn', async () => {
      const sent = [];
      const browserWs = { readyState: WebSocket.OPEN, send: jest.fn((d) => { if (!Buffer.isBuffer(d)) sent.push(JSON.parse(d)); }), close: jest.fn() };
      const ttsService = { synthesize: jest.fn().mockResolvedValue({ audio_base64: 'AAAA' }) };
      const log = { debug() {}, info() {}, warn() {}, error() {} };
      const client = new RelayClient({ createWebSocket: jest.fn() }, browserWs, ttsService, log);
      client.ws = { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
      try {
        client.setVoiceMode(true, 'af_heart', 1.0);
        client.sendMessage('hi', [], 's1', { traceId: GOOD_ID });
        const delta = (text) => ({ sessionId: 's1', type: 'llm_event', event: { type: 'assistant', delta: { type: 'text_delta', text } } });
        client._handleRelayMessage(delta('The first sentence is long enough to be spoken alone. '));
        client._handleRelayMessage(delta('The second sentence is also long enough to stand on its own. '));
        client._handleRelayMessage(delta('And a trailing remainder without a full stop'));
        client._handleRelayMessage({ sessionId: 's1', type: 'message_complete' });
        for (let i = 0; i < 100 && !sent.some((m) => m.type === 'tts_done'); i++) await new Promise((r) => setTimeout(r, 10));

        const calls = ttsService.synthesize.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(2);
        for (const args of calls) expect(args[args.length - 1]).toEqual({ traceId: GOOD_ID });
      } finally {
        client.close();
      }
    });
  });
});
