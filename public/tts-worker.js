/**
 * TTS Web Worker - Runs Kokoro TTS using onnxruntime-web directly.
 * Ported from kokoro-web (github.com/eduardolat/kokoro-web) to fix Safari compatibility.
 * Uses espeak-ng WASM for phonemization + ONNX runtime for inference.
 *
 * Messages IN:  { type: 'init', dtype?, device? }
 *               { type: 'generate', text, voice, id }
 * Messages OUT: { type: 'init_progress', progress }
 *               { type: 'ready' }
 *               { type: 'audio', id, audio (base64 WAV), duration }
 *               { type: 'error', id?, message }
 */
import * as ort from '/onnxruntime-web/ort.all.min.mjs';

// Point WASM binaries to local server
ort.env.wasm.wasmPaths = '/onnxruntime-web/';

const SAMPLE_RATE = 24000;
const MODEL_CONTEXT_WINDOW = 512;
const HF_BASE = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main';
const HF_MODELS = `${HF_BASE}/onnx`;
const HF_VOICES = `${HF_BASE}/voices`;

// --- State ---
let session = null;
let voiceCache = new Map(); // voiceId -> shaped voice embedding

// --- Tokenizer (177-entry Kokoro phoneme vocab) ---
const VOCAB = {
  ';':1,':':2,',':3,'.':4,'!':5,'?':6,'—':9,'\u2026':10,' ':11,
  '\u0250':12,'\u0251':13,'\u0252':14,'\u0253':15,'\u0255':16,
  '\u0256':17,'\u0257':18,'\u0258':19,'\u0259':20,'\u025A':21,
  '\u025B':22,'\u025C':23,'\u025D':24,'\u025E':25,'\u025F':26,
  '\u0260':27,'\u0261':28,'\u0262':29,'\u0263':30,'\u0264':31,
  '\u0265':32,'\u0266':33,'\u0267':34,'\u0268':35,'\u026A':36,
  '\u026B':37,'\u026C':38,'\u026D':39,'\u026E':40,'\u026F':41,
  '\u0270':42,'a':43,'b':44,'c':45,'d':46,'e':47,'f':48,'g':49,
  'h':50,'i':51,'j':52,'k':53,'l':54,'m':55,'n':56,'o':57,'p':58,
  'q':59,'r':60,'s':61,'t':62,'u':63,'v':64,'w':65,'x':66,'y':67,
  'z':68,'\u0271':69,'\u0272':70,'\u0273':71,'\u0274':72,'\u0275':73,
  '\u0276':74,'\u0278':75,'\u0279':76,'\u027A':77,'\u027B':78,
  '\u027D':79,'\u027E':80,'\u0280':81,'\u0281':82,'\u0282':83,
  '\u0283':84,'\u0284':85,'\u0288':86,'\u0289':87,'\u028A':88,
  '\u028B':89,'\u028C':90,'\u028D':91,'\u028E':92,'\u028F':93,
  '\u0290':94,'\u0291':95,'\u0292':96,'\u0294':97,'\u0295':98,
  '\u0298':99,'\u0299':100,'\u029B':101,'\u029C':102,'\u029D':103,
  '\u029F':104,'\u02A1':105,'\u02A2':106,'\u02B0':107,'\u02B2':108,
  '\u02B7':109,'\u02BC':110,'\u02C8':111,'\u02CC':112,'\u02D0':113,
  '\u02D1':114,'\u02DE':115,'\u02E0':116,'\u02E4':117,'\u0300':118,
  '\u0301':119,'\u0302':120,'\u0303':121,'\u0304':122,'\u0306':123,
  '\u0308':124,'\u030B':125,'\u030C':126,'\u030F':127,'\u0318':128,
  '\u0319':129,'\u031A':130,'\u031C':131,'\u031D':132,'\u031E':133,
  '\u031F':134,'\u0320':135,'\u0324':136,'\u0325':137,'\u0329':138,
  '\u032A':139,'\u032C':140,'\u032F':141,'\u0330':142,'\u0334':143,
  '\u0339':144,'\u033A':145,'\u033B':146,'\u033C':147,'\u033D':148,
  '\u0361':149,'\u03B2':150,'\u03B8':151,'\u03C7':152,
  '\u2016':153,'\u2191':154,'\u2193':155,'\u2197':156,'\u2198':157,
  '\u203F':158,'\u207F':159,'\u2191\u2193':160,
  '\uAB53':161,
};

function tokenize(phonemes) {
  const FALLBACK = 16;
  return [...phonemes].map(ch => VOCAB[ch] || FALLBACK);
}

// --- Text processor ---

function sanitizeText(text) {
  return text
    .replace(/'/g, "'").replace(/'/g, "'")
    .replace(/«/g, '(').replace(/»/g, ')')
    .replace(/\u201C/g, '"').replace(/\u201D/g, '"')
    .replace(/、/g, ', ').replace(/。/g, '. ')
    .replace(/！/g, '! ').replace(/，/g, ', ')
    .replace(/：/g, ': ').replace(/；/g, '; ').replace(/？/g, '? ')
    .replace(/\./g, '.[0.4s]')
    .replace(/,/g, ',[0.2s]')
    .replace(/!/g, '![0.1s]')
    .replace(/\?/g, '?[0.1s]')
    .replace(/\n/g, '[0.4s]')
    .replace(/\t/g, ' ')
    .trim();
}

function segmentText(text) {
  const parts = text.split(/(\[[0-9]+(?:\.[0-9]+)?s\])/);
  const chunks = [];
  for (const part of parts) {
    if (!part) continue;
    const silenceMatch = part.match(/^\[([0-9]+(?:\.[0-9]+)?)s\]$/);
    if (silenceMatch) {
      chunks.push({ type: 'silence', durationSeconds: parseFloat(silenceMatch[1]) });
    } else {
      const trimmed = part.trim();
      if (trimmed) chunks.push({ type: 'text', content: trimmed });
    }
  }
  return chunks;
}

// --- Phonemizer (espeak-ng WASM) ---

async function phonemize(text, lang = 'en-us') {
  const normalized = text
    .replace(/'/g, "'").replace(/'/g, "'")
    .replace(/«/g, '(').replace(/»/g, ')')
    .replace(/\u201C/g, '"').replace(/\u201D/g, '"')
    .replace(/\n/g, '  ').replace(/\t/g, '  ')
    .trim();

  const { default: ESpeakNg } = await import('/espeak-ng/espeak-ng.js');
  const espeak = await ESpeakNg({
    locateFile: () => '/espeak-ng/espeak-ng.wasm',
    arguments: ['--phonout', 'generated', '-q', '--ipa', '-v', lang, normalized],
  });

  const generated = espeak.FS.readFile('generated', { encoding: 'utf8' });
  return generated.split('\n').join(' ').trim();
}

// --- Voice embedding loader ---

async function getVoice(voiceId) {
  if (voiceCache.has(voiceId)) return voiceCache.get(voiceId);

  const url = `${HF_VOICES}/${voiceId}.bin`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch voice: ${voiceId}`);
  const buffer = await res.arrayBuffer();
  const flat = new Float32Array(buffer);

  // Reshape to [numChunks, 1, 256]
  const shaped = [];
  for (let i = 0; i < flat.length; i += 256) {
    shaped.push([Array.from(flat.subarray(i, i + 256))]);
  }
  voiceCache.set(voiceId, shaped);
  return shaped;
}

// --- Waveform trimming ---

function trimWaveform(waveform) {
  const windowSize = 256;
  const numWindows = Math.floor(waveform.length / windowSize);
  if (numWindows === 0) return waveform;

  const amplitudes = [];
  for (let i = 0; i < numWindows; i++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      sum += Math.abs(waveform[i * windowSize + j]);
    }
    amplitudes.push(sum / windowSize);
  }

  const maxAmp = Math.max(...amplitudes);
  const threshold = maxAmp * 0.05;

  let startWindow = 0;
  for (let i = 0; i < amplitudes.length; i++) {
    if (amplitudes[i] > threshold) { startWindow = i; break; }
  }

  let endWindow = amplitudes.length - 1;
  for (let i = amplitudes.length - 1; i >= 0; i--) {
    if (amplitudes[i] > threshold) { endWindow = i; break; }
  }

  const startSample = Math.max(0, (startWindow - 1) * windowSize);
  const endSample = Math.min(waveform.length, (endWindow + 2) * windowSize);
  return waveform.slice(startSample, endSample);
}

// --- WAV encoder ---

function encodeWav(float32Audio) {
  const bytesPerSample = 4; // 32-bit float
  const dataLength = float32Audio.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 32, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataLength, true);

  const floatView = new Float32Array(buffer, 44);
  floatView.set(float32Audio);

  return new Uint8Array(buffer);
}

// --- Base64 encoding ---

function toBase64(bytes) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

// --- Model loading ---

const MODEL_MAP = {
  'q4': 'model_q8f16',
  'q8': 'model_quantized',
  'fp16': 'model_fp16',
  'fp32': 'model',
};

async function loadModel(dtype, device) {
  const modelId = MODEL_MAP[dtype] || MODEL_MAP['q4'];
  const provider = device === 'webgpu' ? 'webgpu' : 'cpu';

  self.postMessage({ type: 'init_progress', progress: 10 });

  const modelUrl = `${HF_MODELS}/${modelId}.onnx`;
  const response = await fetch(modelUrl);
  if (!response.ok) throw new Error(`Failed to fetch model: ${modelUrl}`);

  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength) : 0;
  let loaded = 0;

  const reader = response.body.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total > 0) {
      const pct = 10 + Math.round((loaded / total) * 80);
      self.postMessage({ type: 'init_progress', progress: pct });
    }
  }

  const modelBuffer = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    modelBuffer.set(chunk, offset);
    offset += chunk.length;
  }

  self.postMessage({ type: 'init_progress', progress: 95 });

  session = await ort.InferenceSession.create(modelBuffer.buffer, {
    executionProviders: [provider],
  });

  self.postMessage({ type: 'init_progress', progress: 100 });
}

// --- Message handler ---

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await loadModel(msg.dtype, msg.device);
        self.postMessage({ type: 'ready' });
        break;
      case 'generate':
        await handleGenerate(msg);
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};

async function handleGenerate(msg) {
  if (!session) {
    self.postMessage({ type: 'error', id: msg.id, message: 'TTS not initialized' });
    return;
  }

  const text = msg.text || '';
  const voiceId = msg.voice || 'af_heart';
  const tokensPerChunk = MODEL_CONTEXT_WINDOW - 2; // Reserve 2 for padding tokens

  // 1. Preprocess text into chunks
  const sanitized = sanitizeText(text);
  const segments = segmentText(sanitized);

  // 2. Load voice embedding
  const voice = await getVoice(voiceId);

  // 3. Process each chunk
  const waveforms = [];

  for (const segment of segments) {
    if (segment.type === 'silence') {
      const samples = Math.round(segment.durationSeconds * SAMPLE_RATE);
      waveforms.push(new Float32Array(samples));
      continue;
    }

    // Phonemize text → IPA
    const phonemes = await phonemize(segment.content, 'en-us');
    if (!phonemes.trim()) continue;

    // Tokenize phonemes
    const allTokens = tokenize(phonemes);

    // Split into context-window-sized chunks
    for (let i = 0; i < allTokens.length; i += tokensPerChunk) {
      const tokens = allTokens.slice(i, i + tokensPerChunk);
      if (tokens.length === 0) continue;

      // Voice style: select by token count
      const styleIdx = Math.min(tokens.length - 1, voice.length - 1);
      const refStyle = voice[styleIdx][0];

      // Pad tokens with 0 on both sides
      const paddedTokens = [0, ...tokens, 0];

      // Create input tensors
      const inputIds = new ort.Tensor('int64', BigInt64Array.from(paddedTokens.map(BigInt)), [1, paddedTokens.length]);
      const style = new ort.Tensor('float32', new Float32Array(refStyle), [1, refStyle.length]);
      const speed = new ort.Tensor('float32', new Float32Array([1.0]), [1]);

      // Run inference
      const result = await session.run({ input_ids: inputIds, style, speed });
      let waveform = await result.waveform.getData();
      waveform = trimWaveform(waveform);
      waveforms.push(waveform);
    }
  }

  // 4. Concatenate all waveforms
  const totalLength = waveforms.reduce((sum, w) => sum + w.length, 0);
  const combined = new Float32Array(totalLength);
  let writeOffset = 0;
  for (const w of waveforms) {
    combined.set(w, writeOffset);
    writeOffset += w.length;
  }

  // 5. Encode as WAV and send back
  const wavBytes = encodeWav(combined);
  self.postMessage({
    type: 'audio',
    id: msg.id,
    audio: toBase64(wavBytes),
    duration: combined.length / SAMPLE_RATE,
  });
}
