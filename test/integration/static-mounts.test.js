/**
 * Pins the voice static-mount surface on a live server: the in-browser
 * (WASM) TTS/STT backend's mounts are gone (404), and the VAD assets the
 * page still loads (/vad-web, /vad-onnx) keep serving (200).
 */
describe('voice static mounts on a live server', () => {
  // Boots the real server (same harness as integration/e2e) so the
  // assertions hit server.js's actual mount table, not a copy of it.
  const { startEve } = require('./harness');
  let eve;

  beforeAll(async () => {
    eve = await startEve({});
  }, 60000);

  afterAll(async () => {
    await eve.stop();
  });

  // The WASM TTS/STT workers are deleted; their mounts must be gone.
  for (const p of [
    '/onnxruntime-web/ort.all.min.mjs',
    '/transformers/transformers.min.js',
    '/espeak-ng/espeak-ng.js',
  ]) {
    it(`404s ${p} (removed WASM-backend mount)`, async () => {
      const res = await eve.get(p);
      expect(res.status).toBe(404);
    }, 10000);
  }

  // VAD (voice-activity detection) stays — its assets must still serve.
  for (const p of [
    '/vad-web/bundle.min.js',
    '/vad-onnx/ort-wasm-simd-threaded.mjs',
  ]) {
    it(`serves ${p} (VAD assets stay)`, async () => {
      const res = await eve.get(p);
      expect(res.status).toBe(200);
    }, 10000);
  }
});
