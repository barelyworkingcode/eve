// `ws._ttsSpeakGen`/`ws._ttsSpeakChain` are per-connection generation
// bookkeeping stored on the socket itself, deliberately — moving them to
// module scope would let one connection's tts_speak_cancel silence another
// connection's speech, a cross-connection leak.
const { splitIntoChunks, cleanChunkText } = require('../tts-chunker');
const { Director } = require('../tts-director');

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
    let errorMsg = err.message;
    if (errorMsg.includes('ffmpeg') || errorMsg.includes('EBML') || errorMsg.includes('End of file')) {
      errorMsg = 'Failed to process audio. The recording may be too short or corrupted.';
    }
    ws.send(JSON.stringify({ type: 'transcription_error', error: errorMsg }));
  }
}

// isActive() goes false once this read-aloud has been superseded or
// cancelled; the loop bails before its next chunk so it stops holding the
// daemon's global gen_lock for audio nobody will hear.
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

  // Synthesis stays serial: the daemon's gen_lock serializes globally anyway,
  // and at RTF ~0.05 generation outpaces playback, so chunk N+1 is ready
  // before N finishes.
  const chunks = splitIntoChunks(text);
  log?.debug(`TTS speak: ${chunks.length} chunk(s), ${text.length} chars (voice: ${voice})`);

  // One Director instance for the whole message: delivery cues persist
  // across its chunks; a play button starts a fresh instance.
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
        // Opaque/already-compact audio — permessage-deflate would be net-negative CPU.
        ws.send(Buffer.from(result.audio_base64, 'base64'), { compress: false });
      }
    }
  } catch (err) {
    log?.error('TTS speak failed:', err.message);
    if (isActive()) ws.send(JSON.stringify({ type: 'tts_error', message: 'Speech synthesis failed' }));
  }
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
      // The daemon's own gen_lock is the crash-safety boundary (it serializes
      // globally, across all sessions); this per-connection chain just keeps
      // one client's requests ordered and avoids piling up in-flight work.
      const speakGen = (ws._ttsSpeakGen = (ws._ttsSpeakGen || 0) + 1);
      ws._ttsSpeakChain = (ws._ttsSpeakChain || Promise.resolve())
        .then(() => handleTtsSpeak(ws, ttsService, message, log, () => ws._ttsSpeakGen === speakGen))
        .catch((err) => log?.error('tts_speak chain error:', err.message));
    },
  },

  {
    type: 'tts_speak_cancel',
    handle(ctx) {
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
