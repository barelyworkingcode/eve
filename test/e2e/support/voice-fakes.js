'use strict';

// Fake relayTTS and relaySTT daemons: the length-prefixed JSON protocol that
// tts-service.js and stt-service.js speak, on 127.0.0.1 with a free port.
// One request per connection, as those clients send it.

const net = require('net');

const SAMPLE_RATE = 8000;
const wavCache = new Map();

// A valid PCM WAV of silence, so the browser decodes and plays it.
function silentWav(seconds) {
  if (wavCache.has(seconds)) return wavCache.get(seconds);
  const dataBytes = Math.round(seconds * SAMPLE_RATE) * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(1, 22);            // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  const b64 = buf.toString('base64');
  wavCache.set(seconds, b64);
  return b64;
}

function frame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

// `answer(request, state)` returns the reply object. The fake keeps every
// request, lets a test wait on the next match, and lets it change the answer.
function createFake(answer) {
  const state = { reply: null };
  const requests = [];
  const waiters = [];
  const sockets = new Set();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) return;
      let request;
      try {
        request = JSON.parse(buf.slice(4, 4 + len).toString('utf8'));
      } catch {
        sock.end(frame({ success: false, error: 'invalid request' }));
        return;
      }
      buf = Buffer.alloc(0);
      sock.end(frame(answer(request, state)));
      if (request.action !== 'ping') record(request);
    });
  });

  function record(request) {
    requests.push(request);
    for (const w of [...waiters]) {
      if (w.match(request)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(request);
      }
    }
  }

  return {
    requests,
    waitForRequest(match = () => true) {
      const earlier = requests.find(match);
      if (earlier) return Promise.resolve(earlier);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    reply(r) { state.reply = r; },
    listen() {
      // Resolves on the server's own `listening` callback.
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function createTts() {
  return createFake((request, state) => {
    if (request.action === 'list_voices') {
      return { success: true, voices: [{ id: 'af_heart', name: 'Heart', lang: 'American English', gender: 'F' }] };
    }
    const r = state.reply || { seconds: 30 };
    if (r.error) return { success: false, error: r.error };
    return { success: true, audio_base64: silentWav(r.seconds), sample_rate: SAMPLE_RATE, duration: r.seconds };
  });
}

function createStt() {
  return createFake((request, state) => {
    if (request.action === 'ping') return { success: true };
    const r = state.reply || { text: 'hello from the test microphone' };
    if (r.error) return { success: false, error: r.error };
    return { success: true, text: r.text, language: 'en', duration: 1 };
  });
}

// Specs see the live request list, the wait and the reply switch; not the socket.
function expose(fake) {
  const { requests, waitForRequest, reply } = fake;
  return { requests, waitForRequest, reply };
}

async function startVoiceFakes() {
  const tts = createTts();
  const stt = createStt();
  const [ttsPort, sttPort] = await Promise.all([tts.listen(), stt.listen()]);
  return {
    ttsPort,
    sttPort,
    voice: { tts: expose(tts), stt: expose(stt) },
    close: () => Promise.all([tts.close(), stt.close()]),
  };
}

module.exports = { startVoiceFakes, silentWav };
