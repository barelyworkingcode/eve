/**
 * Voice tests against the real speech daemons.
 *
 * Chromium plays a WAV file as the microphone
 * (`--use-file-for-fake-audio-capture`) instead of using a virtual audio
 * driver — hermetic, headless, and parallel-safe in a way a shared system
 * audio device is not. Known speech is generated at test time with macOS `say`.
 *
 * Slower than the rest of the e2e suite (~3s per transcription), so it is
 * excluded from `npm run test:e2e` and run via `npm run test:voice`.
 */
const { test, expect } = require('./fixtures');
const { chromium } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TTSService = require('../../tts-service');
const STTService = require('../../stt-service');

const PHRASE = 'The quick brown fox jumps over the lazy dog';
// The recognizer mangles unusual proper nouns ("eve voice" came back as "in
// police"), so assert on word overlap of a common-word phrase, never string
// equality. 0.7, not 0.8: the recognizer jitters run to run (a phrase that
// scores 1.0 most runs was observed at 0.78 once). Broken speech still
// scores near zero, so this fails hard on a real regression without being
// flaky.
const MIN_OVERLAP = 0.7;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function overlap(spoken, heard) {
  const want = norm(spoken).split(' ').filter(Boolean);
  const got = new Set(norm(heard).split(' ').filter(Boolean));
  if (!want.length) return 0;
  return want.filter((w) => got.has(w)).length / want.length;
}

/** Generate known speech. macOS only (`say` + `afconvert`). */
function makeSpeechWav(phrase) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eve-voice-'));
  const aiff = path.join(dir, 's.aiff');
  const wav = path.join(dir, 's.wav');
  execFileSync('say', ['-v', 'Samantha', '-o', aiff, phrase]);
  // 16-bit LE PCM, 48 kHz, mono — the format Chromium's fake capture expects.
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav]);
  return { dir, wav };
}

/**
 * The mic button lives in the chat input row, which only exists once a session
 * is open — on the welcome screen it is in the DOM but its ancestor is hidden.
 * Without this, an "is the mic hidden?" assertion passes for the wrong reason.
 */
async function openChatSession(page) {
  await page.getByTestId('sidebar-project-p1').click();
  await page.getByTestId('sidebar-new-session-p1').click();
  await page.getByTestId('shell-card-web-chat').click();
  await page.getByRole('button', { name: 'Start Chat' }).click();
  await expect(page.getByTestId('chat-input')).toBeVisible({ timeout: 15000 });
}

async function daemonUp(Service) {
  try { return await new Service().isAvailable(); } catch { return false; }
}

// Stubbed so visibility never depends on whether the speech daemons happen
// to be running.
test.describe('mic button visibility', () => {
  for (const available of [true, false]) {
    test(`mic button is ${available ? 'shown' : 'hidden'} when STT reports available=${available}`, async ({ page, eve }) => {
      await page.route('**/api/stt/status', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available }) }));
      await page.goto(eve.baseUrl, { waitUntil: 'domcontentloaded' });
      await openChatSession(page);
      const mic = page.getByTestId('chat-mic');
      await expect(mic).toHaveCount(1);
      if (available) await expect(mic).toBeVisible();
      else await expect(mic).toBeHidden();
    });
  }
});

test.describe('speech to transcript', () => {
  test('a spoken phrase lands in the chat input', async ({ eve }) => {
    test.skip(process.platform !== 'darwin', 'needs macOS `say`/`afconvert` to generate speech');
    test.skip(!(await daemonUp(STTService)),
      'Whisper daemon down — start it with: relay service restart --id relaystt-daemon');

    const { dir, wav } = makeSpeechWav(PHRASE);
    // %noloop matters: without it the WAV repeats and a long hold captures twice.
    const browser = await chromium.launch({
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}%noloop`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    try {
      const page = await browser.newPage();
      // mediaDevices needs a secure context; eve on 127.0.0.1 qualifies.
      await page.goto(eve.baseUrl, { waitUntil: 'domcontentloaded' });
      await openChatSession(page);
      const mic = page.getByTestId('chat-mic');
      await expect(mic).toBeVisible({ timeout: 15000 });

      // #micBtn is a click toggle, not push-to-talk. Hold past the 300ms
      // floor in _processRecording(); the generated phrase is ~2.5s.
      await mic.click();
      await page.waitForTimeout(3000);
      await mic.click();

      const input = page.locator('#userInput');
      await expect(input).not.toHaveValue('', { timeout: 40000 });
      const heard = await input.inputValue();
      const score = overlap(PHRASE, heard);
      console.log(`  spoken: ${JSON.stringify(PHRASE)}`);
      console.log(`  heard : ${JSON.stringify(heard)}  (${(score * 100).toFixed(0)}% word overlap)`);
      expect(score).toBeGreaterThanOrEqual(MIN_OVERLAP);
    } finally {
      await browser.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('TTS/STT round trip', () => {
  for (const phrase of [
    'The quick brown fox jumps over the lazy dog',
    'Please open the settings panel and enable dark mode',
    'One two three four five six seven eight nine ten',
  ]) {
    test(`round trip: ${phrase.slice(0, 32)}...`, async () => {
      test.skip(!(await daemonUp(TTSService)),
        'Kokoro daemon down — start it with: relay service restart --id relaytts-daemon');
      test.skip(!(await daemonUp(STTService)),
        'Whisper daemon down — start it with: relay service restart --id relaystt-daemon');

      const voices = await new TTSService().listVoices();
      const voice = (voices[0] && (voices[0].id || voices[0])) || 'anna';
      const spoken = await new TTSService().synthesize(phrase, voice, 1.0);
      expect(spoken.audio_base64, 'daemon returned no audio').toBeTruthy();

      const heard = await new STTService().transcribe(spoken.audio_base64, 'en');
      const score = overlap(phrase, heard.text);
      console.log(`  heard: ${JSON.stringify(heard.text)}  (${(score * 100).toFixed(0)}% word overlap)`);
      expect(score).toBeGreaterThanOrEqual(MIN_OVERLAP);
    });
  }
});
