'use strict';

// Fakerelay worlds (schema 1, relay's docs/fakerelay.md "World spec") for specs
// to start from. Each call returns a fresh object, so a spec can edit its copy.
// Artifacts are public: neutral names only.

function base() {
  return {
    schema: 1,
    projects: [
      { id: 'p_acme', name: 'Acme', mode: 'work', files: { 'README.md': '# Acme\n' } },
    ],
    default_project: { work: 'p_acme' },
  };
}

// World file values ({ base64 }) for the media viewers, about 1 s each. The WAV is built from PCM
// (8 kHz, 16-bit mono, 440 Hz); the WebM is a small fixed clip (64x48 VP8 with Opus audio).
const WEBM_BASE64 = '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';

function wavBase64() {
  const rate = 8000;
  const samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]).toString('base64');
}

const media = {
  webm: () => ({ base64: WEBM_BASE64 }),
  wav: () => ({ base64: wavBase64() }),
};

module.exports = { base, media };
