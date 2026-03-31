/**
 * TTS Web Worker - Runs kokoro-js in isolation to avoid AMD loader conflicts.
 * Messages IN:  { type: 'init', dtype?, device? }
 *               { type: 'generate', text, voice, id }
 * Messages OUT: { type: 'init_progress', progress }
 *               { type: 'ready' }
 *               { type: 'audio', id, audio (base64 WAV), duration }
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
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};

async function handleInit(msg) {
  tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: msg.dtype || 'q8',
    device: msg.device || 'wasm',
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

  const bytes = wavBytes instanceof Uint8Array ? wavBytes : new Uint8Array(wavBytes);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }

  self.postMessage({
    type: 'audio',
    id: msg.id,
    audio: btoa(chunks.join('')),
    duration: audio.audio.length / audio.sampling_rate,
  });
}
