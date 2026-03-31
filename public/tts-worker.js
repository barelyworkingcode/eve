/**
 * TTS Web Worker - Runs kokoro-js in isolation to avoid AMD loader conflicts.
 * Communicates with the main thread via postMessage.
 *
 * Messages IN:  { type: 'init', dtype?, device? }
 *               { type: 'generate', text, voice, id }
 *               { type: 'voices' }
 * Messages OUT: { type: 'init_progress', progress }
 *               { type: 'ready', voices }
 *               { type: 'audio', id, audio (base64 WAV), duration }
 *               { type: 'voices_result', voices }
 *               { type: 'error', id?, message }
 */
import { KokoroTTS } from '/kokoro-js/kokoro.web.js';

let tts = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'generate':
        await handleGenerate(msg);
        break;
      case 'voices':
        handleVoices();
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};

async function handleInit(msg) {
  const dtype = msg.dtype || 'q8';
  const device = msg.device || 'wasm';

  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype,
    device,
    progress_callback: (data) => {
      if (data.status === 'progress' && data.progress != null) {
        self.postMessage({ type: 'init_progress', progress: data.progress, file: data.file });
      }
    },
  });

  self.postMessage({ type: 'ready' });
}

async function handleGenerate(msg) {
  if (!tts) {
    self.postMessage({ type: 'error', id: msg.id, message: 'TTS not initialized' });
    return;
  }

  const audio = await tts.generate(msg.text, { voice: msg.voice || 'af_heart' });
  const wavBytes = audio.toWav();
  const base64 = arrayBufferToBase64(wavBytes);

  self.postMessage({
    type: 'audio',
    id: msg.id,
    audio: base64,
    duration: audio.audio.length / audio.sampling_rate,
  });
}

function handleVoices() {
  // Kokoro voice IDs are shared with the server daemon — no separate listing needed
  self.postMessage({ type: 'voices_result', voices: [] });
}

function arrayBufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}
