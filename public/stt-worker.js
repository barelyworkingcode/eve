/**
 * STT Web Worker - Runs Whisper via transformers.js in isolation.
 * Messages IN:  { type: 'init', model?, dtype?, device? }
 *               { type: 'transcribe', audio (Float32Array), id }
 * Messages OUT: { type: 'init_progress', progress, file }
 *               { type: 'ready' }
 *               { type: 'transcription', id, text, language }
 *               { type: 'error', id?, message }
 */
import { pipeline, env } from '/transformers/transformers.min.js';

// Point WASM files to local static route
env.backends.onnx.wasm.wasmPaths = '/transformers/';

let transcriber = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await handleInit(msg);
        break;
      case 'transcribe':
        await handleTranscribe(msg);
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};

async function handleInit(msg) {
  const model = msg.model || 'onnx-community/whisper-small';
  const dtype = msg.dtype || (msg.device === 'webgpu' ? 'fp32' : 'q8');
  const device = msg.device || 'wasm';

  transcriber = await pipeline('automatic-speech-recognition', model, {
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

async function handleTranscribe(msg) {
  if (!transcriber) {
    self.postMessage({ type: 'error', id: msg.id, message: 'STT not initialized' });
    return;
  }

  const result = await transcriber(msg.audio, {
    language: 'en',
    task: 'transcribe',
  });

  self.postMessage({
    type: 'transcription',
    id: msg.id,
    text: result.text || '',
  });
}
