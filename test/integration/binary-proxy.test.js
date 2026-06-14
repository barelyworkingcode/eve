/**
 * Binary proxies: generated images and terminal logs are streamed from relay
 * via fetchRaw (not the JSON proxy). eve sets the content-type + cache headers.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('binary proxies (fetchRaw)', () => {
  let eve;
  let projectDir;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-bin-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
  });

  afterAll(async () => {
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('proxies a generated image with content-type + immutable cache', async () => {
    const res = await eve.get('/api/generated/pic.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/image\/png/);
    expect(res.headers.get('cache-control')).toMatch(/max-age/);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('FAKE-PNG-BYTES');
  });

  it('proxies a terminal log as octet-stream, no-store', async () => {
    const res = await eve.get('/api/terminals/term-1/log');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/octet-stream/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('TERMINAL-LOG-BYTES');
  });
});
