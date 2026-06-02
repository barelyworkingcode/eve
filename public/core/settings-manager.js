/**
 * SettingsManager - browser theme configuration stored in localStorage.
 * Applies settings by overriding CSS custom properties on :root.
 *
 * Theme model: two palettes (dark + light), each a set of base colors, plus a
 * themeMode of 'auto' | 'light' | 'dark'. In 'auto' the active palette follows
 * the OS (prefers-color-scheme) and re-applies live when the OS theme flips.
 * The 9 base colors live ONLY inside palettes[mode]; get('bgPrimary') etc.
 * resolve to whichever palette is currently active.
 */

const FONT_PRESETS = {
  'sf-mono': "'SF Mono', Monaco, 'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  'jetbrains': "'JetBrains Mono', monospace",
  'fira-code': "'Fira Code', 'Fira Mono', monospace",
  'source-code-pro': "'Source Code Pro', monospace",
  'cascadia': "'Cascadia Code', 'Cascadia Mono', monospace",
  'menlo': "Menlo, Consolas, 'Courier New', monospace",
  'system-mono': 'monospace',
  'inter': "Inter, -apple-system, 'Segoe UI', sans-serif",
  'system-sans': "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  'helvetica': "'Helvetica Neue', Helvetica, Arial, sans-serif",
  'georgia': "Georgia, 'Times New Roman', serif",
  'charter': "Charter, 'Bitstream Charter', Georgia, serif",
};

const FONT_GROUPS = {
  'Monospace': ['sf-mono', 'jetbrains', 'fira-code', 'source-code-pro', 'cascadia', 'menlo', 'system-mono'],
  'Sans-Serif': ['inter', 'system-sans', 'helvetica'],
  'Serif': ['georgia', 'charter'],
};

const FONT_PRESET_LABELS = {
  'sf-mono': 'SF Mono / Monaco',
  'jetbrains': 'JetBrains Mono',
  'fira-code': 'Fira Code',
  'source-code-pro': 'Source Code Pro',
  'cascadia': 'Cascadia Code',
  'menlo': 'Menlo / Consolas',
  'system-mono': 'System Monospace',
  'inter': 'Inter',
  'system-sans': 'System Sans-Serif',
  'helvetica': 'Helvetica Neue',
  'georgia': 'Georgia',
  'charter': 'Charter',
};

// The base palette keys. These live inside palettes[mode], never at the top level.
const COLOR_KEYS = [
  'accentColor', 'bgPrimary', 'bgSecondary', 'textPrimary', 'textSecondary',
  'borderColor', 'dangerColor', 'successColor', 'messageUserBg',
];

const THEME_PRESETS = {
  'Default Dark': {
    accentColor: '#3b82f6',
    bgPrimary: '#0a0a0a',
    bgSecondary: '#141414',
    textPrimary: '#fafafa',
    textSecondary: '#a0a0a0',
    borderColor: '#2a2a2a',
    dangerColor: '#ef4444',
    successColor: '#22c55e',
    messageUserBg: '#1e3a5f',
  },
  'Midnight Blue': {
    accentColor: '#60a5fa',
    bgPrimary: '#0b1120',
    bgSecondary: '#111827',
    textPrimary: '#e2e8f0',
    textSecondary: '#94a3b8',
    borderColor: '#1e3a5f',
    dangerColor: '#f87171',
    successColor: '#34d399',
    messageUserBg: '#1e3a5f',
  },
  'Dracula': {
    accentColor: '#bd93f9',
    bgPrimary: '#282a36',
    bgSecondary: '#21222c',
    textPrimary: '#f8f8f2',
    textSecondary: '#6272a4',
    borderColor: '#44475a',
    dangerColor: '#ff5555',
    successColor: '#50fa7b',
    messageUserBg: '#44475a',
  },
  'Solarized Dark': {
    accentColor: '#268bd2',
    bgPrimary: '#002b36',
    bgSecondary: '#073642',
    textPrimary: '#fdf6e3',
    textSecondary: '#839496',
    borderColor: '#094959',
    dangerColor: '#dc322f',
    successColor: '#859900',
    messageUserBg: '#094959',
  },
  'Light': {
    accentColor: '#2563eb',
    bgPrimary: '#ffffff',
    bgSecondary: '#f3f4f6',
    textPrimary: '#111827',
    textSecondary: '#6b7280',
    borderColor: '#e5e7eb',
    dangerColor: '#dc2626',
    successColor: '#16a34a',
    messageUserBg: '#dbeafe',
  },
  'Solarized Light': {
    accentColor: '#268bd2',
    bgPrimary: '#fdf6e3',
    bgSecondary: '#eee8d5',
    textPrimary: '#073642',
    textSecondary: '#586e75',
    borderColor: '#d3cbb7',
    dangerColor: '#dc322f',
    successColor: '#859900',
    messageUserBg: '#d5e5f0',
  },
  'Paper': {
    accentColor: '#7c3aed',
    bgPrimary: '#faf9f7',
    bgSecondary: '#f0eeeb',
    textPrimary: '#1c1917',
    textSecondary: '#78716c',
    borderColor: '#e7e5e4',
    dangerColor: '#e11d48',
    successColor: '#059669',
    messageUserBg: '#ede9fe',
  },
};

// Non-color theme settings and their defaults. Colors come from the presets above.
const NON_COLOR_DEFAULTS = {
  themeMode: 'dark',
  fontFamily: 'sf-mono',
  fontSize: 13,
  terminalFontFamily: 'sf-mono',
  ttsPromptTag: '[SPEAK RESPONSE]',
  sttPromptTag: '[VOICE DICTATION]',
  showHiddenFiles: false,
};

function defaultSettings() {
  return {
    ...NON_COLOR_DEFAULTS,
    palettes: {
      dark: { ...THEME_PRESETS['Default Dark'] },
      light: { ...THEME_PRESETS['Light'] },
    },
  };
}

const STORAGE_KEY = 'eve-settings';

class SettingsManager {
  constructor(bus) {
    this.bus = bus;
    this._settings = defaultSettings();
    this._rafId = null;
    this._saveTimer = null;
    this._load();
    this._watchSystemTheme();
  }

  _load() {
    let stored;
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch (e) {
      stored = null;
    }
    if (!stored) return;

    if (stored.palettes) {
      // Already the current shape — merge, guaranteeing both palettes are complete.
      Object.assign(this._settings, stored);
      this._settings.palettes = {
        dark: { ...THEME_PRESETS['Default Dark'], ...(stored.palettes.dark || {}) },
        light: { ...THEME_PRESETS['Light'], ...(stored.palettes.light || {}) },
      };
      if (!['auto', 'light', 'dark'].includes(this._settings.themeMode)) {
        this._settings.themeMode = 'dark';
      }
    } else {
      // Legacy flat shape ({bgPrimary, accentColor, ...}). Migrate once.
      this._migrateLegacy(stored);
      this._save();
    }
  }

  /**
   * Convert pre-palette flat settings into the palettes + themeMode shape.
   * The stored colors were the user's single active theme; infer whether they
   * were running light or dark from background luminance, seat them in that
   * palette, and leave the opposite palette at its preset default.
   */
  _migrateLegacy(stored) {
    const flat = {};
    for (const k of COLOR_KEYS) {
      if (stored[k] != null) flat[k] = stored[k];
    }
    if (flat.bgPrimary) {
      const activeMode = this._luminance(flat.bgPrimary) > 0.5 ? 'light' : 'dark';
      const base = activeMode === 'light' ? THEME_PRESETS['Light'] : THEME_PRESETS['Default Dark'];
      this._settings.palettes[activeMode] = { ...base, ...flat };
      this._settings.themeMode = activeMode;
    }
    // Carry over every non-color key (fonts, prompt tags, favorites, search prefs…).
    for (const [k, v] of Object.entries(stored)) {
      if (COLOR_KEYS.includes(k) || k === 'palettes' || k === 'themeMode') continue;
      this._settings[k] = v;
    }
  }

  _save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings));
  }

  _debouncedSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), 200);
  }

  _scheduleApply() {
    if (this._rafId) return;
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this._applyToDOM();
    });
  }

  _watchSystemTheme() {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (this._settings.themeMode === 'auto') this._applyToDOM();
    };
    // Safari <14 only supports the deprecated addListener.
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  _systemPrefersDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** The mode actually rendered right now (resolves 'auto' against the OS). */
  getActiveMode() {
    if (this._settings.themeMode === 'auto') return this._systemPrefersDark() ? 'dark' : 'light';
    return this._settings.themeMode === 'light' ? 'light' : 'dark';
  }

  _activePalette() {
    return this._settings.palettes[this.getActiveMode()];
  }

  // --- Generic accessors -------------------------------------------------

  get(key) {
    if (COLOR_KEYS.includes(key)) return this._activePalette()[key];
    return this._settings[key];
  }

  set(key, value) {
    if (COLOR_KEYS.includes(key)) {
      this._settings.palettes[this.getActiveMode()][key] = value;
    } else {
      this._settings[key] = value;
    }
    this._debouncedSave();
    this._scheduleApply();
  }

  // --- Theme mode + palette API (used by the settings dialog) ------------

  getThemeMode() {
    return this._settings.themeMode;
  }

  setThemeMode(mode) {
    if (!['auto', 'light', 'dark'].includes(mode)) return;
    this._settings.themeMode = mode;
    this._save();
    this._applyToDOM();
  }

  getPalette(mode) {
    return { ...this._settings.palettes[mode] };
  }

  /** Set a single color within a specific palette (dark/light). */
  setColor(mode, key, value) {
    if (!this._settings.palettes[mode] || !COLOR_KEYS.includes(key)) return;
    this._settings.palettes[mode][key] = value;
    this._debouncedSave();
    this._scheduleApply();
  }

  /** Replace a whole palette's colors (used when applying a preset). */
  setPalette(mode, colors) {
    if (!this._settings.palettes[mode]) return;
    this._settings.palettes[mode] = { ...this._settings.palettes[mode], ...colors };
    this._save();
    this._applyToDOM();
  }

  /** Presets grouped by whether they read as a light or dark theme. */
  getPresetGroups() {
    const groups = { dark: [], light: [] };
    for (const [name, colors] of Object.entries(THEME_PRESETS)) {
      (this.paletteIsLight(colors) ? groups.light : groups.dark).push({ name, colors });
    }
    return groups;
  }

  /** Name of the preset whose colors exactly match the given palette, if any. */
  matchPresetName(colors) {
    for (const [name, preset] of Object.entries(THEME_PRESETS)) {
      if (COLOR_KEYS.every((k) => (preset[k] || '').toLowerCase() === (colors[k] || '').toLowerCase())) {
        return name;
      }
    }
    return null;
  }

  reset() {
    // Reset theme + font preferences to defaults, but keep non-theme state the
    // user accumulated (favorite template, last-used search models, etc.).
    const fresh = defaultSettings();
    for (const k of Object.keys(NON_COLOR_DEFAULTS)) this._settings[k] = fresh[k];
    this._settings.palettes = fresh.palettes;
    this._save();
    this._applyToDOM();
  }

  getFavoriteTemplate() {
    return this._settings.favoriteTemplate || null;
  }

  setFavoriteTemplate(favorite) {
    this._settings.favoriteTemplate = favorite;
    this._save();
  }

  getLastSearchModel(projectId) {
    return this._settings.lastSearchModels?.[projectId] || null;
  }

  setLastSearchModel(projectId, modelId) {
    if (!this._settings.lastSearchModels) this._settings.lastSearchModels = {};
    if (modelId) this._settings.lastSearchModels[projectId] = modelId;
    else delete this._settings.lastSearchModels[projectId];
    this._save();
  }

  getLastSearchAiEnabled(projectId) {
    return !!this._settings.lastSearchAiEnabled?.[projectId];
  }

  setLastSearchAiEnabled(projectId, enabled) {
    if (!this._settings.lastSearchAiEnabled) this._settings.lastSearchAiEnabled = {};
    this._settings.lastSearchAiEnabled[projectId] = !!enabled;
    this._save();
  }

  isLight() {
    return this.paletteIsLight(this._activePalette());
  }

  paletteIsLight(colors) {
    return this._luminance(colors.bgPrimary) > 0.5;
  }

  applyToDOM() {
    this._applyToDOM();
  }

  _applyToDOM() {
    const root = document.documentElement.style;
    const s = this._activePalette();
    const light = this.paletteIsLight(s);

    root.setProperty('--accent', s.accentColor);
    root.setProperty('--accent-hover', this._darken(s.accentColor, 15));
    root.setProperty('--bg-primary', s.bgPrimary);
    root.setProperty('--bg-secondary', s.bgSecondary);
    root.setProperty('--bg-tertiary', light ? this._darken(s.bgSecondary, 3) : this._lighten(s.bgSecondary, 4));
    root.setProperty('--bg-hover', light ? this._darken(s.bgSecondary, 6) : this._lighten(s.bgSecondary, 10));
    root.setProperty('--text-primary', s.textPrimary);
    root.setProperty('--text-secondary', s.textSecondary);
    root.setProperty('--text-muted', light ? this._lighten(s.textSecondary, 25) : this._darken(s.textSecondary, 25));
    root.setProperty('--border-color', s.borderColor);
    root.setProperty('--danger', s.dangerColor);
    root.setProperty('--danger-hover', this._darken(s.dangerColor, 10));
    root.setProperty('--success', s.successColor);
    root.setProperty('--code-bg', light ? this._darken(s.bgPrimary, 3) : this._darken(s.bgPrimary, 2));
    root.setProperty('--message-user', s.messageUserBg);
    root.setProperty('--message-assistant', s.bgSecondary);
    root.setProperty('--warning', light ? '#d97706' : '#f59e0b');

    // Let native controls (scrollbars, color pickers, form inputs) match the theme.
    root.colorScheme = light ? 'light' : 'dark';

    // Two independent font slots: --font-ui drives chrome/prose, --font-mono
    // drives the terminal, code editor, and code blocks (always monospace).
    root.setProperty('--font-ui', FONT_PRESETS[this._settings.fontFamily] || FONT_PRESETS['sf-mono']);
    root.setProperty('--font-mono', this.getTerminalFontStack());
    root.setProperty('--root-font-size', this._settings.fontSize + 'px');

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = s.bgPrimary;

    this.bus.emit(EVT.SETTINGS_CHANGED, { ...this._settings, ...s });
  }

  getFontStack(key) {
    return FONT_PRESETS[key || this._settings.fontFamily] || FONT_PRESETS['sf-mono'];
  }

  getTerminalFontStack() {
    return this.getFontStack(this._settings.terminalFontFamily);
  }

  _parseHex(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  _toHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }

  _darken(hex, percent) {
    const [r, g, b] = this._parseHex(hex);
    const f = 1 - percent / 100;
    return this._toHex(r * f, g * f, b * f);
  }

  _lighten(hex, percent) {
    const [r, g, b] = this._parseHex(hex);
    const f = percent / 100;
    return this._toHex(r + (255 - r) * f, g + (255 - g) * f, b + (255 - b) * f);
  }

  _luminance(hex) {
    const [r, g, b] = this._parseHex(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
}
