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
