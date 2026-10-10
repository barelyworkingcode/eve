'use strict';

// The one import a spec needs. Per test: its own fakerelay, eve, relayScheduler,
// fake TTS and STT, data directories and browser context. See docs/test.md.

const base = require('@playwright/test');
const { devices } = base;
const { Stack } = require('./stack');
const worlds = require('./worlds');
const { micWav } = require('./mic-audio');

// `defaultBrowserType` can't be set inside a describe, and the one project is Chromium anyway.
function profile(name) {
  const copy = { ...devices[name] };
  delete copy.defaultBrowserType;
  return copy;
}
const profiles = { phone: profile('Pixel 7'), tablet: profile('Galaxy Tab S4') };

// TEST-NET-1: never routable, so only the forward below can answer it.
const BARE_IP = '192.0.2.10';

// What the page hears when it opens the microphone. 'beep' is Chromium's own
// fake device (the launch flags in playwright.config.js). The other two replace
// getUserMedia's audio with a looping WAV generated in code (mic-audio.js):
// 'silence', or 'speech' (synthetic speech-like audio, then a pause, repeating).
const MIC_KINDS = ['silence', 'speech'];

// Runs in the page, before any script. The stream is a real MediaStream, so
// the VAD, MediaRecorder and level meters consume it as they would a mic.
function installFakeMic(wavBase64) {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return real(constraints);
    const raw = atob(wavBase64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const ctx = new AudioContext();
    const buffer = await ctx.decodeAudioData(bytes.buffer);
    const out = ctx.createMediaStreamDestination();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(out);
    source.start();
    if (ctx.state === 'suspended') await ctx.resume();
    const track = out.stream.getAudioTracks()[0];
    const stop = track.stop.bind(track);
    track.stop = () => {
      stop();
      if (window.__e2eAudioStop) window.__e2eAudioStop('mic');
      try { source.stop(); } catch { /* already stopped */ }
      ctx.close().catch(() => {});
    };
    return out.stream;
  };
}

// Runs in the page, before any script. Reports each stop of a playing sound to the
// test side. Looping sources are the fake microphone's own, so only one-shot sources
// (eve's speech) count as 'speech'.
function installSpeechStopSignal() {
  const stop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function patchedStop(...args) {
    if (!this.loop && window.__e2eAudioStop) window.__e2eAudioStop('speech');
    return stop.apply(this, args);
  };
}

// Counts, in the test process, how often the page stopped the fake microphone track
// ('mic', fake mics only) and a spoken reply ('speech'). Counts never reset, so a
// wait given the count taken before the action cannot miss an event.
function audioStopSignal() {
  const counts = { mic: 0, speech: 0 };
  const side = (kind) => ({
    get stops() { return counts[kind]; },
    // Resolves once more stops than `after` have happened (default: any stop at all).
    async waitForStop(after = 0) {
      await base.expect.poll(() => counts[kind], { message: `no ${kind} stop after ${after}` }).toBeGreaterThan(after);
    },
  });
  return { counts, mic: side('mic'), speech: side('speech') };
}

const AUTHENTICATOR_OPTIONS = {
  protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
  isUserVerified: true, automaticPresenceSimulation: true,
};

function passkeyFor(page, context) {
  let cdp = null;
  let authenticatorId = null;
  const need = () => {
    if (!cdp) throw new Error('passkey.enable() has not been called in this test');
    return cdp;
  };
  return {
    // Chromium's virtual authenticator: ctap2, internal, resident key, user verification.
    async enable() {
      cdp = await context.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const res = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR_OPTIONS });
      authenticatorId = res.authenticatorId;
    },
    // A fresh, empty authenticator with the same options (presence and verification back on).
    // Returns the old one's credentials, so a row can show a second browser is not the first.
    async replace() {
      const old = await this.credentials();
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      const res = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR_OPTIONS });
      authenticatorId = res.authenticatorId;
      return old;
    },
    async credentials() {
      const res = await need().send('WebAuthn.getCredentials', { authenticatorId });
      return res.credentials.map((c) => ({ credentialId: c.credentialId, rpId: c.rpId }));
    },
    // false: the next ceremony gets neither presence nor user verification.
    async setPresence(ok) {
      await need().send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: ok });
      await need().send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: ok });
    },
  };
}

const test = base.test.extend({
  world: [worlds.base(), { option: true }],
  network: ['trusted', { option: true }],
  scheduler: [true, { option: true }],
  publicOrigin: [null, { option: true }],
  trustedSubnets: [null, { option: true }],
  plansDir: ['agent', { option: true }],
  // Contents of eve's data/settings.json, written before eve starts. null = no file.
  eveSettings: [null, { option: true }],
  // 'beep' | 'silence' | 'speech': what getUserMedia delivers (see MIC_KINDS).
  mic: ['beep', { option: true }],

  _fakeMic: [async ({ page, mic }, use) => {
    if (mic !== 'beep') {
      if (!MIC_KINDS.includes(mic)) throw new Error(`mic must be 'beep', 'silence' or 'speech', got ${mic}`);
      const wav = micWav(mic);
      await page.addInitScript(installFakeMic, wav.toString('base64'));
    }
    await use();
  }, { auto: true }],

  _audioStops: [async ({ page }, use) => {
    const signal = audioStopSignal();
    await page.exposeFunction('__e2eAudioStop', (kind) => { signal.counts[kind]++; });
    await page.addInitScript(installSpeechStopSignal);
    await use(signal);
  }, { auto: true }],

  // The running stack. Not for specs: they use eve, relay, passkey and voice.
  stack: async ({ world, network, scheduler, publicOrigin, trustedSubnets, plansDir, eveSettings }, use, testInfo) => {
    const stack = new Stack({
      fakerelay: process.env.EVE_E2E_FAKERELAY,
      relayscheduler: process.env.EVE_E2E_RELAYSCHEDULER,
      world, network, scheduler, publicOrigin, trustedSubnets, plansDir, eveSettings,
    });
    let setupError = null;
    try {
      if (!stack.bins.fakerelay || !stack.bins.relayscheduler) {
        throw new Error('EVE_E2E_FAKERELAY / EVE_E2E_RELAYSCHEDULER are not set; run through `npx playwright test` (global setup builds them)');
      }
      await stack.start();
      await use(stack);
    } catch (err) {
      setupError = err;
      throw err;
    } finally {
      try {
        await stack.stop();
        if (setupError || testInfo.status !== testInfo.expectedStatus) {
          for (const [name, file] of stack.logFiles()) await testInfo.attach(name, { path: file });
          if (stack.overrun) await testInfo.attach('teardown-overrun', { body: stack.overrun });
        }
      } finally {
        stack.remove();
      }
    }
  },

  eve: async ({ stack, page, context, network }, use) => {
    const ready = () => page.locator('html[data-ready="1"]').waitFor({ state: 'attached' });
    const toReady = async (action, opts) => {
      if (opts && opts.weakConnection) {
        // The first fetch of one core script fails; later loads (the person's Reload) succeed.
        await page.route((u) => u.pathname === '/app.js', (route) => route.abort('internetdisconnected'), { times: 1 });
        await action('domcontentloaded');
        return;
      }
      if (opts && 'preReady' in opts && !(typeof opts.preReady === 'string' && opts.preReady.trim())) {
        throw new Error('preReady needs a non-empty reason');
      }
      await action(opts && opts.preReady ? 'domcontentloaded' : 'load');
      if (!(opts && opts.preReady)) await ready();
    };
    await use({
      url: stack.url,
      // Resolves once the app is ready, the signal eve.open waits on. For a row that signs in after opening with preReady.
      ready,
      open: (urlPath = '/', opts) => toReady((waitUntil) => page.goto(stack.url + urlPath, { waitUntil }), opts),
      reload: (opts) => toReady((waitUntil) => page.reload({ waitUntil }), opts),
      // Clears this page's site data, as a person would. The token stays valid in eve and the
      // authenticator keeps its credentials. Returns with the Sign-in screen loading.
      async signOut() {
        if (network === 'trusted') throw new Error("signOut needs network: 'untrusted'");
        await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
        await page.reload({ waitUntil: 'domcontentloaded' });
      },
      setOffline: (offline) => context.setOffline(offline),
      // Opens http://192.0.2.10:<eve port><path>. The browser's requests to that address are
      // forwarded to eve's real listener with Host 192.0.2.10:<port>, so eve sees a bare-IP visit.
      // Resolves at domcontentloaded: under publicOrigin the app never reaches data-ready.
      async openByIp(urlPath = '/') {
        const port = new URL(stack.url).port;
        const host = `${BARE_IP}:${port}`;
        await context.route(`http://${host}/**`, async (route) => {
          const req = route.request();
          const res = await route.fetch({
            url: stack.url + new URL(req.url()).pathname + new URL(req.url()).search,
            headers: { ...req.headers(), host },
            maxRedirects: 0,
          });
          await route.fulfill({ response: res });
        });
        await page.goto(`http://${host}${urlPath}`, { waitUntil: 'domcontentloaded' });
      },
    });
  },

  relay: async ({ stack }, use) => {
    await use({
      dir: stack.relayDir,
      cli: (...argv) => stack.cli(...argv),
      json: (...argv) => stack.json(...argv),
      ctl: (...argv) => stack.ctl(...argv),
      mark: () => new Date().toISOString(),
      logs: (opts) => stack.logs(opts),
      waitForEvent: (event, opts) => stack.waitForEvent(event, opts),
      removePlanFiles: () => stack.removePlanFiles(),
    });
  },

  passkey: async ({ page, context }, use) => {
    await use(passkeyFor(page, context));
  },

  desktop: async ({ page }, use) => {
    await use({
      // One DataTransfer holding every file; dragenter, dragover, then drop on the target.
      // `size` fills that many zero bytes. Returns once drop is dispatched.
      async dropFiles(target, files) {
        await target.evaluate((el, specs) => {
          const dt = new DataTransfer();
          for (const f of specs) {
            const body = f.size !== undefined ? new Uint8Array(f.size) : (f.text ?? '');
            dt.items.add(new File([body], f.name, { type: f.type ?? '' }));
          }
          for (const type of ['dragenter', 'dragover', 'drop']) {
            el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
          }
        }, files);
      },
    });
  },

  voice: async ({ stack, _audioStops }, use) => {
    await use(Object.assign(Object.create(stack.voice), { mic: _audioStops.mic, speech: _audioStops.speech }));
  },
});

module.exports = { test, expect: base.expect, profiles };
