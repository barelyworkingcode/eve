/**
 * Voice message descriptors — read-aloud TTS, its cancellation, and STT
 * transcription. See ws/message-registry.js for the registry these are
 * registered into.
 *
 * This is the only domain with a binary-frame path: handleTtsSpeak streams
 * synthesized audio back as raw `Buffer` WS frames with `{compress:false}`
 * (opaque/already-compact audio — permessage-deflate would be net-negative
 * CPU). Every other descriptor in every domain sends JSON strings only.
 *
 * `ws._ttsSpeakGen` / `ws._ttsSpeakChain` are per-connection generation
 * bookkeeping stored on the socket itself (see the comment in `tts_speak`
 * below for why). They stay there deliberately — moving them to module scope
 * would let one connection's tts_speak_cancel silence another connection's
 * speech, which is exactly the cross-connection leak C1 forbids.
 *
 * None of these four arms are `await`ed in today's switch, so none of these
 * descriptors may be `async` — see C2 in ws/message-registry.js.
 * `handleTranscribeAudio` and `handleTtsSpeak` are themselves `async`
 * internally (real TCP round trips to the STT/TTS daemons) but neither call
 * site awaits them, exactly as today.
 */
const { splitIntoChunks, cleanChunkText } = require('../tts-chunker');
const { Director } = require('../tts-director');

/**
 * Transcribe audio via the Whisper STT daemon.
 */
async function handleTranscribeAudio(ws, sttService, message, log) {
  try {
    const { audio, language } = message;
    if (!audio) {
      ws.send(JSON.stringify({ type: 'transcription_error', error: 'No audio data' }));
      return;
    }
    const audioBytes = Math.round(audio.length * 3 / 4); // approximate decoded size
    log?.debug(`Transcribing audio: ~${audioBytes} bytes, language=${language || 'auto'}`);
    if (audioBytes < 100) {
      ws.send(JSON.stringify({ type: 'transcription_error', error: 'Audio recording too short' }));
      return;
    }
    const result = await sttService.transcribe(audio, language || null);
    log?.debug('STT result:', result.text);
    ws.send(JSON.stringify({
      type: 'transcription_result',
      text: result.text,
      language: result.language,
      duration: result.duration
    }));
  } catch (err) {
    log?.error('Transcription failed:', err.message);
    // Strip verbose ffmpeg output — show a clean error to the user
    let errorMsg = err.message;
    if (errorMsg.includes('ffmpeg') || errorMsg.includes('EBML') || errorMsg.includes('End of file')) {
      errorMsg = 'Failed to process audio. The recording may be too short or corrupted.';
    }
    ws.send(JSON.stringify({ type: 'transcription_error', error: errorMsg }));
  }
}

/**
 * On-demand TTS (read-aloud button): synthesize text and stream audio back to
 * the browser sentence-by-sentence so the first word plays after the first
 * sentence is generated, not the whole message. Each chunk goes out as a
 * binary WS frame; the browser plays them in arrival order
 * (enqueueServerAudioBuffer) and finalizes on the tts_done control frame.
 *
 * @param {() => boolean} isActive — false once this read-aloud has been
 *   superseded or cancelled; the loop bails before its next chunk so we stop
 *   holding the daemon's global gen_lock for audio nobody will hear.
 */
const TTS_SPEAK_MAX_CHARS = 10000;

async function handleTtsSpeak(ws, ttsService, message, log, isActive = () => true) {
  const { text, voice, speed } = message;
  if (!text || !ttsService) {
    ws.send(JSON.stringify({ type: 'tts_error', message: 'TTS unavailable' }));
    return;
  }
  if (text.length > TTS_SPEAK_MAX_CHARS) {
    ws.send(JSON.stringify({ type: 'tts_error', message: `Text too long (max ${TTS_SPEAK_MAX_CHARS} characters)` }));
    return;
  }

  // Full-sentence chunks, synthesized one at a time. Synthesis stays serial:
  // the daemon's gen_lock serializes globally anyway, and at RTF ~0.05
  // generation outpaces playback, so chunk N+1 is ready before N finishes.
  const chunks = splitIntoChunks(text);
  log?.debug(`TTS speak: ${chunks.length} chunk(s), ${text.length} chars (voice: ${voice})`);

  // Fresh Director per read-aloud: parse inline cues into expressive spans (and
  // strip the tags so they're never spoken literally). Delivery persists across
  // this message's chunks; a play button starts a clean turn.
  const director = new Director();
  const baseSpeed = speed || 1.0;

  try {
    for (const chunk of chunks) {
      for (const span of director.plan(chunk)) {
        if (!isActive()) return; // cancelled — browser already finalized via stop()
        const cleaned = cleanChunkText(span.text);
        if (!cleaned) continue;
        const result = await ttsService.synthesize(
          cleaned, voice || 'af_heart', baseSpeed * span.speed, span.instruct, span.gain);
        if (!isActive()) return; // cancelled while this span was generating
        // Audio goes out as a binary WS frame (no base64 inflation / atob); only
        // control frames (tts_done/tts_error) stay JSON. See RelayClient._sendAudioToBrowser.
        // Opaque/already-compact audio — skip permessage-deflate (net-negative CPU).
        ws.send(Buffer.from(result.audio_base64, 'base64'), { compress: false });
      }
    }
  } catch (err) {
    log?.error('TTS speak failed:', err.message);
    if (isActive()) ws.send(JSON.stringify({ type: 'tts_error', message: 'Speech synthesis failed' }));
  }
  // Finalize on success or partial failure so the browser leaves the speaking
  // state. Skipped on cancel (early return) — the browser already cleaned up.
  if (isActive()) ws.send(JSON.stringify({ type: 'tts_done' }));
}

module.exports = [
  {
    type: 'voice_mode',
    handle(ctx) {
      ctx.relayClient.setVoiceMode(ctx.message.enabled, ctx.message.voice, ctx.message.speed);
    },
  },

  {
    type: 'tts_speak',
    expensive: true,
    handle(ctx) {
      const { ws, message, log } = ctx;
      const { ttsService } = ctx.deps;
      // Serialize a connection's read-aloud requests so rapid play-button
      // clicks don't fan out into overlapping synthesis. The daemon's own
      // gen_lock is the crash-safety boundary (it serializes globally,
      // across all sessions); this per-connection chain just keeps one
      // client's requests ordered and avoids piling up in-flight work.
      //
      // Read-aloud now streams sentence-by-sentence, so a new request (or
      // a stop) bumps _ttsSpeakGen; the streaming loop checks the gen
      // before each chunk and bails, abandoning the rest. This request
      // owns the generation captured here.
      const speakGen = (ws._ttsSpeakGen = (ws._ttsSpeakGen || 0) + 1);
      ws._ttsSpeakChain = (ws._ttsSpeakChain || Promise.resolve())
        .then(() => handleTtsSpeak(ws, ttsService, message, log, () => ws._ttsSpeakGen === speakGen))
        .catch((err) => log?.error('tts_speak chain error:', err.message));
    },
  },

  {
    type: 'tts_speak_cancel',
    handle(ctx) {
      // Browser stopped read-aloud playback. Bump the generation so an
      // in-flight streaming loop abandons its remaining chunks instead of
      // synthesizing audio nobody will hear (and holding the daemon's
      // global gen_lock against other sessions).
      ctx.ws._ttsSpeakGen = (ctx.ws._ttsSpeakGen || 0) + 1;
    },
  },

  {
    type: 'transcribe_audio',
    expensive: true,
    handle(ctx) {
      handleTranscribeAudio(ctx.ws, ctx.deps.sttService, ctx.message, ctx.log);
    },
  },
];
