'use strict';

// The fake microphone's audio, generated at test time: no audio file lives in
// the repo. 16 kHz mono 16-bit PCM WAV, base64 (what fixtures.js hands the page).
//
// 'silence': one second of zeros.
// 'speech':  2.5 s of synthetic speech, then 5 s of silence, looped by the page.
//   A glottal pulse train (F0 about 130 Hz, with vibrato and jitter) runs through
//   three formant resonators that move between /a/ /i/ /u/, one vowel per
//   syllable at about 4 syllables a second, each with its own amplitude
//   envelope. A little noise gives each syllable a fricative-like onset. The
//   noise comes from a seeded PRNG, so the buffer is the same on every run.

const SAMPLE_RATE = 16000;
const SPEECH_SECONDS = 2.5;
const PAUSE_SECONDS = 5;
const SYLLABLE_HZ = 4;

const VOWELS = [
  [730, 1090, 2440], // /a/
  [270, 2290, 3010], // /i/
  [300, 870, 2240],  // /u/
];
const BANDWIDTHS = [90, 110, 160];
const GAINS = [1, 0.5, 0.25];

function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two-pole resonator at `freq` with bandwidth `bw`; state kept by the caller.
function resonate(state, x, freq, bw) {
  const r = Math.exp(-Math.PI * bw / SAMPLE_RATE);
  const c1 = 2 * r * Math.cos(2 * Math.PI * freq / SAMPLE_RATE);
  const c2 = -r * r;
  const gain = 1 - c1 - c2;
  const y = gain * x + c1 * state.y1 + c2 * state.y2;
  state.y2 = state.y1;
  state.y1 = y;
  return y;
}

function speechSamples() {
  const rand = seededRandom(335);
  const n = Math.round(SPEECH_SECONDS * SAMPLE_RATE);
  const out = new Float32Array(n);
  const filters = VOWELS[0].map(() => ({ y1: 0, y2: 0 }));
  const syllableSamples = SAMPLE_RATE / SYLLABLE_HZ;
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const syllable = Math.floor(i / syllableSamples);
    const t = (i % syllableSamples) / syllableSamples; // 0..1 inside the syllable
    const vowel = VOWELS[syllable % VOWELS.length];
    const env = Math.sin(Math.PI * t) ** 0.7;
    const f0 = 130 * (1 + 0.04 * Math.sin(2 * Math.PI * 5 * i / SAMPLE_RATE)) * (1 + 0.01 * (rand() - 0.5));
    phase += f0 / SAMPLE_RATE;
    let pulse = 0;
    if (phase >= 1) { phase -= 1; pulse = 1; }
    // Glottal source: impulse train plus a little breath noise; the noise is
    // strongest at the syllable onset.
    const source = pulse * 40 + (rand() - 0.5) * (0.6 + 3 * Math.max(0, 0.25 - t) * 4);
    let y = 0;
    for (let k = 0; k < 3; k++) y += GAINS[k] * resonate(filters[k], source, vowel[k], BANDWIDTHS[k]);
    y *= env;
    out[i] = y;
    peak = Math.max(peak, Math.abs(y));
  }
  const scale = peak ? 0.7 / peak : 0;
  for (let i = 0; i < n; i++) out[i] *= scale;
  return out;
}

function toWav(samples) {
  const dataBytes = samples.length * 2;
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
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  }
  return buf;
}

const cache = new Map();

// kind: 'silence' | 'speech'. Returns the WAV as a Buffer.
function micWav(kind) {
  if (cache.has(kind)) return cache.get(kind);
  let samples;
  if (kind === 'silence') {
    samples = new Float32Array(SAMPLE_RATE);
  } else if (kind === 'speech') {
    const speech = speechSamples();
    samples = new Float32Array(speech.length + Math.round(PAUSE_SECONDS * SAMPLE_RATE));
    samples.set(speech);
  } else {
    throw new Error(`micWav: unknown kind ${kind}`);
  }
  const wav = toWav(samples);
  cache.set(kind, wav);
  return wav;
}

module.exports = { micWav };
