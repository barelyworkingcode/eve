/**
 * SettingsDialog - browser theme configuration dialog.
 * Three tabs: Colors, Typography, Presets.
 * All changes apply live via SettingsManager.
 */
class SettingsDialog extends DialogBase {
  constructor(container) {
    super(container, 'settings-dialog');
    this.settings = container.get('settings');
  }

  init() {
    this.bus.on(EVT.DIALOG_SETTINGS, () => {
      this.render();
      this.show();
    });
  }

  render() {
    this._panel.innerHTML = '';
    this._panel.style.maxWidth = '440px';

    // Title bar
    const titleBar = document.createElement('div');
    titleBar.className = 'dialog__title-bar';

    const title = document.createElement('h3');
    title.className = 'dialog__title';
    title.textContent = 'Settings';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialog__close';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.hide());

    titleBar.appendChild(title);
    titleBar.appendChild(closeBtn);
    this._panel.appendChild(titleBar);

    // Tabs
    const colorsContent = document.createElement('div');
    colorsContent.className = 'dialog__tab-content';
    const typographyContent = document.createElement('div');
    typographyContent.className = 'dialog__tab-content hidden';
    const presetsContent = document.createElement('div');
    presetsContent.className = 'dialog__tab-content hidden';
    const voiceContent = document.createElement('div');
    voiceContent.className = 'dialog__tab-content hidden';

    const tabs = [colorsContent, typographyContent, presetsContent, voiceContent];
    const { header } = this._createTabs(
      [
        { name: 'colors', label: 'Colors' },
        { name: 'typography', label: 'Typography' },
        { name: 'presets', label: 'Presets' },
        { name: 'voice', label: 'Voice' },
      ],
      (tab) => {
        const map = { colors: 0, typography: 1, presets: 2, voice: 3 };
        tabs.forEach((t, i) => t.classList.toggle('hidden', i !== map[tab]));
      }
    );
    this._panel.appendChild(header);

    // Build tab contents
    this._buildColorsTab(colorsContent);
    this._buildTypographyTab(typographyContent);
    this._buildPresetsTab(presetsContent);
    this._buildVoiceTab(voiceContent);

    this._panel.appendChild(colorsContent);
    this._panel.appendChild(typographyContent);
    this._panel.appendChild(presetsContent);
    this._panel.appendChild(voiceContent);

    // Footer with reset
    const footer = document.createElement('div');
    footer.className = 'settings-dialog__footer';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'dialog__btn dialog__btn--secondary';
    resetBtn.textContent = 'Reset to Defaults';
    resetBtn.addEventListener('click', () => {
      this.settings.reset();
      this.render();
    });
    footer.appendChild(resetBtn);
    this._panel.appendChild(footer);
  }

  _buildColorsTab(container) {
    const colors = [
      { key: 'accentColor', label: 'Accent' },
      { key: 'bgPrimary', label: 'Background' },
      { key: 'bgSecondary', label: 'Surface' },
      { key: 'textPrimary', label: 'Text' },
      { key: 'textSecondary', label: 'Text Secondary' },
      { key: 'borderColor', label: 'Borders' },
      { key: 'dangerColor', label: 'Danger' },
      { key: 'successColor', label: 'Success' },
      { key: 'messageUserBg', label: 'User Message' },
    ];

    for (const { key, label } of colors) {
      const row = document.createElement('div');
      row.className = 'settings-dialog__color-row';

      const lbl = document.createElement('span');
      lbl.className = 'settings-dialog__color-label';
      lbl.textContent = label;

      const hexSpan = document.createElement('span');
      hexSpan.className = 'settings-dialog__color-hex';
      hexSpan.textContent = this.settings.get(key);

      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'settings-dialog__color-input';
      input.value = this.settings.get(key);
      input.addEventListener('input', () => {
        hexSpan.textContent = input.value;
        this.settings.set(key, input.value);
      });

      row.appendChild(lbl);
      row.appendChild(hexSpan);
      row.appendChild(input);
      container.appendChild(row);
    }
  }

  _buildTypographyTab(container) {
    // Font family
    const famLabel = document.createElement('label');
    famLabel.className = 'dialog__label';
    famLabel.textContent = 'Font Family';
    container.appendChild(famLabel);

    const famSelect = document.createElement('select');
    famSelect.className = 'dialog__select';
    for (const [groupName, keys] of Object.entries(FONT_GROUPS)) {
      const optgroup = document.createElement('optgroup');
      optgroup.label = groupName;
      for (const key of keys) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = FONT_PRESET_LABELS[key];
        if (key === this.settings.get('fontFamily')) opt.selected = true;
        optgroup.appendChild(opt);
      }
      famSelect.appendChild(optgroup);
    }
    famSelect.addEventListener('change', () => {
      this.settings.set('fontFamily', famSelect.value);
    });
    container.appendChild(famSelect);

    // Font size
    const sizeLabel = document.createElement('label');
    sizeLabel.className = 'dialog__label';
    sizeLabel.textContent = 'Font Size';
    container.appendChild(sizeLabel);

    const sizeInput = document.createElement('input');
    sizeInput.type = 'number';
    sizeInput.className = 'dialog__input';
    sizeInput.min = '10';
    sizeInput.max = '20';
    sizeInput.step = '1';
    sizeInput.value = this.settings.get('fontSize');
    sizeInput.addEventListener('change', () => {
      const val = Math.max(10, Math.min(20, parseInt(sizeInput.value, 10) || 13));
      sizeInput.value = val;
      this.settings.set('fontSize', val);
    });
    container.appendChild(sizeInput);
  }

  _buildVoiceTab(container) {
    const tts = this.container.get('app')?.ttsManager;
    if (!tts) return;

    // TTS Backend
    const backendLabel = document.createElement('label');
    backendLabel.className = 'dialog__label';
    backendLabel.textContent = 'TTS Backend';
    container.appendChild(backendLabel);

    const backendSelect = document.createElement('select');
    backendSelect.className = 'dialog__select';
    const ttsOptions = tts.isNativeApp
      ? [['native', 'Native (on-device)'], ['server', 'Server (Kokoro daemon)']]
      : [['server', 'Server (Kokoro daemon)'], ['browser', 'On-Device (browser)']];
    for (const [value, label] of ttsOptions) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === tts.backend) opt.selected = true;
      backendSelect.appendChild(opt);
    }
    backendSelect.addEventListener('change', () => {
      tts.setBackend(backendSelect.value);
      statusEl.textContent = this._getTtsStatus(tts);
    });
    container.appendChild(backendSelect);

    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = tts.isNativeApp
      ? 'Native uses Kokoro TTS via the iOS Neural Engine.'
      : 'On-Device downloads an 86MB model on first use, then runs locally.';
    container.appendChild(hint);

    // TTS Status
    const ttsStatusEl = document.createElement('div');
    ttsStatusEl.className = 'field-hint';
    ttsStatusEl.style.marginTop = '12px';
    ttsStatusEl.textContent = this._getTtsStatus(tts);
    container.appendChild(ttsStatusEl);

    // --- STT Backend ---
    const stt = this.container.get('app')?.sttManager;
    if (!stt) return;

    const sttLabel = document.createElement('label');
    sttLabel.className = 'dialog__label';
    sttLabel.style.marginTop = '20px';
    sttLabel.textContent = 'STT Backend';
    container.appendChild(sttLabel);

    const sttSelect = document.createElement('select');
    sttSelect.className = 'dialog__select';
    const sttOptions = stt.isNativeApp
      ? [['native', 'Native (on-device)'], ['server', 'Server (Whisper daemon)']]
      : [['server', 'Server (Whisper daemon)'], ['browser', 'On-Device (browser)']];
    for (const [value, label] of sttOptions) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === stt.backend) opt.selected = true;
      sttSelect.appendChild(opt);
    }
    sttSelect.addEventListener('change', () => {
      stt.setBackend(sttSelect.value);
      sttStatusEl.textContent = this._getSttStatus(stt);
    });
    container.appendChild(sttSelect);

    const sttHint = document.createElement('span');
    sttHint.className = 'field-hint';
    sttHint.textContent = stt.isNativeApp
      ? 'Native uses WhisperKit STT via the iOS Neural Engine.'
      : 'On-Device downloads a 166MB Whisper model on first use.';
    container.appendChild(sttHint);

    const sttStatusEl = document.createElement('div');
    sttStatusEl.className = 'field-hint';
    sttStatusEl.style.marginTop = '12px';
    sttStatusEl.textContent = this._getSttStatus(stt);
    container.appendChild(sttStatusEl);
  }

  _getTtsStatus(tts) {
    if (tts.backend === 'native') return 'Using native Kokoro TTS via iOS Neural Engine.';
    if (tts.backend === 'server') return 'Using server-side Kokoro TTS daemon.';
    if (IS_SAFARI && tts.backend === 'browser') return 'Warning: On-device TTS is not yet supported on Safari. Use Server.';
    if (tts.browserReady) return 'On-device model loaded and ready.';
    if (tts.activeBackend?.loading) return 'Loading on-device model...';
    return 'On-device model will download on next voice session.';
  }

  _getSttStatus(stt) {
    if (stt.backend === 'native') return 'Using native WhisperKit STT via iOS Neural Engine.';
    if (stt.backend === 'server') return 'Using server-side Whisper daemon.';
    if (stt.browserReady) return 'On-device model loaded and ready.';
    if (stt.activeBackend?.loading) return 'Loading on-device model...';
    return 'On-device model will download on next voice session.';
  }

  _buildPresetsTab(container) {
    const grid = document.createElement('div');
    grid.className = 'settings-dialog__preset-grid';

    for (const [name, colors] of Object.entries(THEME_PRESETS)) {
      const card = document.createElement('button');
      card.className = 'settings-dialog__preset-card';

      // Color preview swatches
      const swatches = document.createElement('div');
      swatches.className = 'settings-dialog__preset-swatches';
      const previewColors = [colors.bgPrimary, colors.bgSecondary, colors.accentColor, colors.textPrimary];
      for (const c of previewColors) {
        const dot = document.createElement('span');
        dot.className = 'settings-dialog__preset-dot';
        dot.style.background = c;
        swatches.appendChild(dot);
      }

      const label = document.createElement('span');
      label.className = 'settings-dialog__preset-name';
      label.textContent = name;

      card.appendChild(swatches);
      card.appendChild(label);

      card.addEventListener('click', () => {
        const current = this.settings.getAll();
        this.settings.setAll({ ...colors, fontFamily: current.fontFamily, fontSize: current.fontSize });
        this.render();
      });

      grid.appendChild(card);
    }

    container.appendChild(grid);
  }
}
