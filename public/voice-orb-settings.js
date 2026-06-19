/**
 * VoiceOrbSettings — gear button + bottom-sheet sliders for tuning
 * the 3D voice orb appearance. Driven entirely from the ORB_SLIDERS table.
 */

const ORB_SLIDERS = [
  { key: 'innerSize',     id: 'orbInnerSize' },
  { key: 'outerSize',     id: 'orbOuterSize' },
  { key: 'spinRate',      id: 'orbSpinRate' },
  { key: 'idleJitter',    id: 'orbIdleJitter' },
  { key: 'speechJitter',  id: 'orbSpeechJitter' },
];

// River ambient bed volume (native only). Persisted browser-side; the native
// engine resets to its default each launch, so we re-apply on init.
const RIVER_VOL_KEY = 'eve.riverVolume';
const RIVER_VOL_DEFAULT = 0.12;

class VoiceOrbSettings {
  constructor(manager) {
    this.manager = manager;
    this.tuning = null;
  }

  init() {
    const gear = document.getElementById('voiceOrbSettingsBtn');
    const sheet = document.getElementById('voiceOrbSettingsSheet');
    const close = document.getElementById('voiceOrbSettingsClose');
    const reset = document.getElementById('voiceOrbSettingsReset');
    if (!gear || !sheet) return;

    // Load tuning: defaults ← localStorage
    try {
      this.tuning = { ...VoiceOrb3D.DEFAULT_TUNING, ...JSON.parse(localStorage.getItem(VoiceOrb3D.TUNING_KEY) || '{}') };
    } catch {
      this.tuning = { ...VoiceOrb3D.DEFAULT_TUNING };
    }

    this._syncSliders();

    // Gear click → toggle sheet (refresh the diag toggle from native on open)
    gear.addEventListener('click', () => {
      sheet.classList.toggle('hidden');
      if (!sheet.classList.contains('hidden')) this._refreshDiagToggle();
    });

    this._initDiagToggle();
    this._initRiverVolume();

    // Close click → hide sheet
    close.addEventListener('click', () => sheet.classList.add('hidden'));

    // Slider input → update tuning, persist, apply live
    for (const s of ORB_SLIDERS) {
      const slider = document.getElementById(s.id);
      if (!slider) continue;
      slider.addEventListener('input', () => {
        const value = parseFloat(slider.value);
        this.tuning[s.key] = value;
        const label = document.getElementById(s.id + 'Val');
        if (label) label.textContent = value.toFixed(2);
        localStorage.setItem(VoiceOrb3D.TUNING_KEY, JSON.stringify(this.tuning));
        this.manager.orbRenderer?.setTuning?.({ [s.key]: value });
      });
    }

    // Reset → restore defaults, persist, push to UI, apply live
    reset.addEventListener('click', () => {
      this.tuning = { ...VoiceOrb3D.DEFAULT_TUNING };
      localStorage.setItem(VoiceOrb3D.TUNING_KEY, JSON.stringify(this.tuning));
      this._syncSliders();
      this.manager.orbRenderer?.setTuning?.(this.tuning);
    });
  }

  /** Native-only: device-log streaming toggle (persists in native UserDefaults,
   *  default off). Hidden entirely on non-native surfaces. */
  _initDiagToggle() {
    const row = document.getElementById('diagLogRow');
    const toggle = document.getElementById('diagLogToggle');
    if (!row || !toggle) return;
    const native = this.manager.nativeAudio;
    if (!native || !native.available) { row.classList.add('hidden'); return; }
    this._refreshDiagToggle();
    toggle.addEventListener('change', () => {
      native.setDiagLogging(toggle.checked)
        .then((r) => { toggle.checked = !!(r && r.enabled); })
        .catch(() => {});
    });
  }

  /** Native-only: ambient river bed volume slider. Persists in localStorage and
   *  re-applies to native on load (native resets to its default each launch). */
  _initRiverVolume() {
    const row = document.getElementById('riverVolRow');
    const slider = document.getElementById('riverVolSlider');
    const label = document.getElementById('riverVolVal');
    if (!row || !slider) return;
    const native = this.manager.nativeAudio;
    if (!native || !native.available) { row.classList.add('hidden'); return; }
    let vol = RIVER_VOL_DEFAULT;
    try {
      const saved = parseFloat(localStorage.getItem(RIVER_VOL_KEY));
      if (!Number.isNaN(saved)) vol = saved;
    } catch {}
    slider.value = vol;
    if (label) label.textContent = vol.toFixed(2);
    native.setAmbientVolume(vol);
    slider.addEventListener('input', () => {
      const value = parseFloat(slider.value);
      if (label) label.textContent = value.toFixed(2);
      try { localStorage.setItem(RIVER_VOL_KEY, String(value)); } catch {}
      native.setAmbientVolume(value);
    });
  }

  /** Reflect the persisted native streaming state into the checkbox. */
  _refreshDiagToggle() {
    const toggle = document.getElementById('diagLogToggle');
    const native = this.manager.nativeAudio;
    if (!toggle || !native || !native.available) return;
    native.getDiagLogging().then((r) => { toggle.checked = !!(r && r.enabled); }).catch(() => {});
  }

  /** Push current tuning values into all sliders and their value labels. */
  _syncSliders() {
    for (const s of ORB_SLIDERS) {
      const slider = document.getElementById(s.id);
      const label = document.getElementById(s.id + 'Val');
      if (slider) slider.value = this.tuning[s.key];
      if (label) label.textContent = this.tuning[s.key].toFixed(2);
    }
  }
}

window.VoiceOrbSettings = VoiceOrbSettings;
