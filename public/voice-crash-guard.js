/**
 * VoiceCrashGuard - Recovers from on-device voice model loads that hard-crash the app.
 *
 * Loading a native on-device TTS/STT model (Kokoro ~86MB, Whisper ~166MB) can
 * exhaust memory, which kills the whole app *before* any JS error handler runs.
 * A try/catch never fires, and because the chosen backend is persisted, every
 * relaunch re-triggers the same crash — a loop the user can't
 * escape (they can't even reach Settings to switch back).
 *
 * Detection therefore can't be inline. Instead a "load guard" marker is written
 * to localStorage *synchronously before* a heavy load begins, and cleared when the
 * load succeeds or fails gracefully. If the marker survives a relaunch, the
 * previous load crashed (or was interrupted mid-download) — so we revert that
 * backend's stored preference to 'server' before the managers read it, and report
 * what happened.
 *
 * Scope: the native on-device backend calls begin/end. Server
 * can't OOM. Native model downloads (FluidAudio) run in the app process, so a
 * load that exhausts memory kills the whole app; localStorage
 * survives the relaunch, so the marker recovers the path. In the
 * native app the reverted 'server' preference is honored by the voice managers
 * (see tts-manager.js / stt-manager.js), which otherwise force 'native'.
 */
const VoiceCrashGuard = {
  /** @param {'tts'|'stt'} kind */
  _guardKey(kind) { return `eve-voice-loadguard-${kind}`; },
  /** Persisted backend-preference key, matching the managers' own keys. */
  _prefKey(kind) { return `eve-${kind}-backend`; },

  /**
   * Mark that an on-device load for `kind` has begun. Must be called
   * synchronously before the memory-heavy work, so the marker is already
   * durable if the page dies mid-load.
   * @param {'tts'|'stt'} kind
   */
  beginLoad(kind) {
    try { localStorage.setItem(this._guardKey(kind), '1'); } catch { /* storage blocked */ }
  },

  /**
   * Mark that the load concluded without crashing — success or a handled error.
   * @param {'tts'|'stt'} kind
   */
  endLoad(kind) {
    try { localStorage.removeItem(this._guardKey(kind)); } catch { /* storage blocked */ }
  },

  /**
   * Run once at startup, before the voice managers read their preferences.
   * For each kind whose guard survived a reload, revert the stored backend
   * preference to 'server' and clear the guard.
   * @returns {Array<{kind: string}>} recovered entries (empty if none)
   */
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
