/**
 * VoiceCrashGuard - recovers from on-device voice model loads that can OOM-kill
 * the app before any JS handler runs, so a try/catch never fires. Because the
 * backend choice is persisted, every relaunch would retrigger the same crash
 * with no way to reach Settings to switch back.
 *
 * Detection can't be inline, so a guard marker is written to localStorage
 * synchronously before the load and cleared on success or handled failure. A
 * marker that survives a relaunch means the previous load crashed (or was
 * interrupted mid-download); the stored backend preference is reverted to
 * 'server' before the voice managers read it.
 *
 * Only native on-device loads are guarded — server backends can't OOM the app.
 */
const VoiceCrashGuard = {
  _guardKey(kind) { return `eve-voice-loadguard-${kind}`; },
  // must match the managers' own backend-preference key
  _prefKey(kind) { return `eve-${kind}-backend`; },

  // must be called synchronously before the load begins — the marker only
  // helps if it's durable before the app can OOM
  beginLoad(kind) {
    try { localStorage.setItem(this._guardKey(kind), '1'); } catch { /* storage blocked */ }
  },

  endLoad(kind) {
    try { localStorage.removeItem(this._guardKey(kind)); } catch { /* storage blocked */ }
  },

  // must run before the voice managers read their stored preferences
  detectAndRecover() {
    const recovered = [];
    for (const kind of ['tts', 'stt']) {
      let pending = null;
      try { pending = localStorage.getItem(this._guardKey(kind)); } catch { /* storage blocked */ }
      if (!pending) continue;
      try {
        localStorage.setItem(this._prefKey(kind), 'server');
        localStorage.removeItem(this._guardKey(kind));
      } catch { /* storage blocked */ }
      recovered.push({ kind });
    }
    return recovered;
  },
};
