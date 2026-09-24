/**
 * Pins removed and surviving static/route surface on a live server:
 * - voice: the in-browser (WASM) TTS/STT backend's mounts are gone (404), and
 *   the VAD assets the page still loads (/vad-web, /vad-onnx) keep serving (200).
 * - Modules: the /api/modules routes and the module assets are gone.
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

describe('removed Modules surface on a live server', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { startEve } = require('./harness');
  let eve;
  let projectDir;

  // A registered project with a real module on disk: without it the removed
  // handlers would also have 404'd ("Project not found"), proving nothing.
  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-modules-'));
    const moduleDir = path.join(projectDir, 'modules', 'demo');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(
      path.join(moduleDir, 'module.json'),
      JSON.stringify({ displayName: 'Demo', entry: 'index.html' }),
    );
    fs.writeFileSync(path.join(moduleDir, 'index.html'), '<!doctype html><p>demo</p>');
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
  }, 60000);

  afterAll(async () => {
    await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  for (const p of [
    '/api/modules?projectId=p1',
    '/api/modules/p1/demo',
    '/api/modules/serve/p1/demo/index.html',
    '/modules/module-host.js',
    '/modules/module-builder-prompt.md',
    '/panes/module-pane.js',
    '/apple/modules-orb.css',
  ]) {
    it(`404s ${p} (removed Modules surface)`, async () => {
      const res = await eve.get(p);
      expect(res.status).toBe(404);
    }, 10000);
  }

  // A single-segment path falls through to the SPA's index.html, so the only
  // observable proof the SDK is gone is that no JavaScript comes back.
  it('/eve-module-sdk.js falls through to the app shell, not JavaScript', async () => {
    const res = await eve.get('/eve-module-sdk.js');
    const contentType = res.headers.get('content-type') || '';
    expect(contentType).toMatch(/^text\/html/);
    expect(contentType).not.toMatch(/javascript/);
  }, 10000);
});
