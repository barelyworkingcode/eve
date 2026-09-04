/**
 * tts_speak / tts_speak_cancel / transcribe_audio: none of these touch relay,
 * so they had zero coverage of any kind before phase 5 (spec §9b, §9d).
 *
 * These arms are TCP clients to the Kokoro/Whisper daemons (server.js
 * TTS_PORT/STT_PORT). The harness now pins both ports to a freshly-allocated
 * port nothing listens on (test/integration/harness.js), so every path here
 * is the deterministic *failure* path regardless of whether the real daemons
 * happen to be running on this box — the same hazard as the visual harness's
 * unstubbed /api/stt/status (docs/handoff.md). The daemons' SUCCESS paths are
 * out of scope for this phase (spec §9d/D3): they need a fake length-prefixed
 * TCP daemon that doesn't exist yet.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { startEve } = require('./harness');

describe('voice ws arms (deterministic failure paths, daemons unreachable)', () => {
  let eve;
  let projectDir;
  let ws;

  beforeAll(async () => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-it-voice-'));
    eve = await startEve({ projects: [{ id: 'p1', name: 'T', path: projectDir }] });
    ws = await eve.connectWs();
  });

  afterAll(async () => {
    if (ws) await ws.close();
    if (eve) await eve.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('tts_speak against an unreachable daemon: tts_error then tts_done', async () => {
    const from = ws.mark();
    ws.send({ type: 'tts_speak', text: 'hello there', voice: 'af_heart' });
    const err = await ws.waitFor((f) => f.type === 'tts_error', 5000, from);
    expect(err.message).toBe('Speech synthesis failed');
    await ws.waitFor((f) => f.type === 'tts_done', 5000, from);
  });

  it('tts_speak over the 10,000-char cap: tts_error "Text too long"', async () => {
    const from = ws.mark();
    ws.send({ type: 'tts_speak', text: 'x'.repeat(10001) });
    const err = await ws.waitFor((f) => f.type === 'tts_error', 5000, from);
    expect(err.message).toBe('Text too long (max 10000 characters)');
  });

  it('tts_speak_cancel replies with nothing at all', async () => {
    const from = ws.mark();
    ws.send({ type: 'tts_speak_cancel' });
    // Negative characterisation: the arm is a synchronous counter bump with no
    // reply frame. Give it a beat to (not) arrive, then assert nothing did.
    await new Promise((r) => setTimeout(r, 200));
    expect(ws.frames.slice(from).length).toBe(0);
  });

  it('transcribe_audio with no audio: transcription_error "No audio data"', async () => {
    const from = ws.mark();
    ws.send({ type: 'transcribe_audio' });
    const err = await ws.waitFor((f) => f.type === 'transcription_error', 5000, from);
    expect(err.error).toBe('No audio data');
  });

  it('transcribe_audio with a sub-100-byte payload: transcription_error "Audio recording too short"', async () => {
    const from = ws.mark();
    // Decoded size is checked, not encoded length: ~30 base64 chars decode to
    // well under 100 bytes.
    const tinyBase64 = Buffer.from('too short').toString('base64');
    ws.send({ type: 'transcribe_audio', audio: tinyBase64 });
    const err = await ws.waitFor((f) => f.type === 'transcription_error', 5000, from);
    expect(err.error).toBe('Audio recording too short');
  });
});
