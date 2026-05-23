/**
 * SettingsManager - browser theme configuration stored in localStorage.
 * Applies settings by overriding CSS custom properties on :root.
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

const SETTINGS_DEFAULTS = {
  accentColor: '#3b82f6',
  bgPrimary: '#0a0a0a',
  bgSecondary: '#141414',
  textPrimary: '#fafafa',
  textSecondary: '#a0a0a0',
  borderColor: '#2a2a2a',
  dangerColor: '#ef4444',
  successColor: '#22c55e',
  messageUserBg: '#1e3a5f',
  fontFamily: 'sf-mono',
  fontSize: 13,
  terminalFontFamily: 'sf-mono',
  ttsPromptTag: '[SPEAK RESPONSE]',
  sttPromptTag: '[VOICE DICTATION]',
  showHiddenFiles: false,
};

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

const STORAGE_KEY = 'eve-settings';

class SettingsManager {
  constructor(bus) {
    this.bus = bus;
    this._settings = { ...SETTINGS_DEFAULTS };
    this._rafId = null;
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (stored) Object.assign(this._settings, stored);
    } catch (e) {}
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

  get(key) {
    return this._settings[key];
  }

  getAll() {
    return { ...this._settings };
  }

  set(key, value) {
    this._settings[key] = value;
    this._debouncedSave();
    this._scheduleApply();
  }

  setAll(obj) {
    Object.assign(this._settings, obj);
    this._save();
    this._applyToDOM();
  }

  reset() {
    this._settings = { ...SETTINGS_DEFAULTS };
    localStorage.removeItem(STORAGE_KEY);
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
    return this._luminance(this._settings.bgPrimary) > 0.5;
  }

  applyToDOM() {
    this._applyToDOM();
  }

  _applyToDOM() {
    const root = document.documentElement.style;
    const s = this._settings;
    const light = this.isLight();

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

    const fontStack = FONT_PRESETS[s.fontFamily] || FONT_PRESETS['sf-mono'];
    document.body.style.fontFamily = fontStack;
    document.body.style.fontSize = s.fontSize + 'px';

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = s.bgPrimary;

    this.bus.emit(EVT.SETTINGS_CHANGED, s);
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
