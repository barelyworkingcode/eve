/**
 * SettingsDialog - browser theme configuration dialog.
 * Theme tabs: Theme (appearance mode + presets), Colors (palette editor),
 * Typography (UI + code/terminal fonts). Plus Voice and Files.
 * All changes apply live via SettingsManager.
 */
class SettingsDialog extends DialogBase {
  constructor(container) {
    super(container, 'settings-dialog');
    this.settings = container.get('settings');
    // Which palette the Colors tab edits. Only diverges from the active mode
    // when themeMode is 'auto' and the user picks the other side to customize.
    this._editMode = 'dark';
  }

  init() {
    this.bus.on(EVT.DIALOG_SETTINGS, () => {
      this.render();
      this.show();
    });
  }

  hide() {
    super.hide();
    // Re-evaluate voice preloading in case user changed TTS/STT backend
    if (this.container.has('voiceInitCoordinator')) {
      this.container.get('voiceInitCoordinator').evaluate();
    }
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

    // The Colors tab edits the active palette by default; under 'auto' the user
    // can switch which side they edit.
    this._editMode = this.settings.getActiveMode();

    // Tabs
    const themeContent = document.createElement('div');
    themeContent.className = 'dialog__tab-content';
    const colorsContent = document.createElement('div');
    colorsContent.className = 'dialog__tab-content hidden';
    const typographyContent = document.createElement('div');
    typographyContent.className = 'dialog__tab-content hidden';
    const voiceContent = document.createElement('div');
    voiceContent.className = 'dialog__tab-content hidden';
    const filesContent = document.createElement('div');
    filesContent.className = 'dialog__tab-content hidden';

    const tabs = [themeContent, colorsContent, typographyContent, voiceContent, filesContent];
    const { header } = this._createTabs(
      [
        { name: 'theme', label: 'Theme' },
        { name: 'colors', label: 'Colors' },
        { name: 'typography', label: 'Typography' },
        { name: 'voice', label: 'Voice' },
        { name: 'files', label: 'Files' },
      ],
      (tab) => {
        const map = { theme: 0, colors: 1, typography: 2, voice: 3, files: 4 };
        tabs.forEach((t, i) => t.classList.toggle('hidden', i !== map[tab]));
      }
    );
    this._panel.appendChild(header);

    // Build tab contents
    this._buildThemeTab(themeContent);
    this._buildColorsTab(colorsContent);
    this._buildTypographyTab(typographyContent);
    this._buildVoiceTab(voiceContent);
    this._buildFilesTab(filesContent);

    this._panel.appendChild(themeContent);
    this._panel.appendChild(colorsContent);
    this._panel.appendChild(typographyContent);
    this._panel.appendChild(voiceContent);
    this._panel.appendChild(filesContent);

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

  _buildThemeTab(container) {
    // Appearance mode: Auto follows the OS, Light/Dark pin it.
    const modeLabel = document.createElement('label');
    modeLabel.className = 'dialog__label';
    modeLabel.textContent = 'Appearance';
    container.appendChild(modeLabel);

    container.appendChild(this._buildSegmented(
      [
        { value: 'auto', label: 'Auto' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
      ],
      this.settings.getThemeMode(),
      (val) => {
        this.settings.setThemeMode(val);
        this._editMode = this.settings.getActiveMode();
        this.render();
      }
    ));

    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = this._appearanceHint();
    container.appendChild(hint);

    // Preset gallery, grouped by light/dark. Clicking applies into that side's palette.
    const groups = this.settings.getPresetGroups();
    for (const [groupKey, label] of [['dark', 'Dark themes'], ['light', 'Light themes']]) {
      const groupLabel = document.createElement('div');
      groupLabel.className = 'settings-dialog__preset-group-label';
      groupLabel.textContent = label;
      container.appendChild(groupLabel);

      const grid = document.createElement('div');
      grid.className = 'settings-dialog__preset-grid';
      const activeName = this.settings.matchPresetName(this.settings.getPalette(groupKey));

      for (const { name, colors } of groups[groupKey]) {
        const card = this._buildPresetCard(name, colors);
        if (name === activeName) card.classList.add('settings-dialog__preset-card--active');
        card.addEventListener('click', () => this._applyPreset(groupKey, colors));
        grid.appendChild(card);
      }
      container.appendChild(grid);
    }
  }

  _appearanceHint() {
    const mode = this.settings.getThemeMode();
    if (mode === 'auto') {
      const active = this.settings.getActiveMode() === 'light' ? 'Light' : 'Dark';
      return `Follows your system appearance — currently ${active}.`;
    }
    return mode === 'light' ? 'Always uses the light theme.' : 'Always uses the dark theme.';
  }

  _applyPreset(groupKey, colors) {
    this.settings.setPalette(groupKey, colors);
    const mode = this.settings.getThemeMode();
    if (mode === 'auto') {
      if (groupKey !== this.settings.getActiveMode()) {
        this.bus.emit(EVT.TOAST_SHOW, {
          id: 'theme-staged',
          type: 'info',
          message: `Saved as your ${groupKey} theme — shows when your system uses ${groupKey} mode.`,
        });
      }
    } else if (mode !== groupKey) {
      // Picking a preset from the other side is an explicit choice — switch to it.
      this.settings.setThemeMode(groupKey);
    }
    this._editMode = this.settings.getActiveMode();
    this.render();
  }

  _buildPresetCard(name, colors) {
    const card = document.createElement('button');
    card.className = 'settings-dialog__preset-card';

    const swatches = document.createElement('div');
    swatches.className = 'settings-dialog__preset-swatches';
    for (const c of [colors.bgPrimary, colors.bgSecondary, colors.accentColor, colors.textPrimary]) {
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
    return card;
  }

  _buildSegmented(options, current, onSelect) {
    const wrap = document.createElement('div');
    wrap.className = 'settings-dialog__segmented';
    const buttons = [];
    for (const opt of options) {
      const btn = document.createElement('button');
      btn.className = 'settings-dialog__seg-btn';
      btn.textContent = opt.label;
      if (opt.value === current) btn.classList.add('settings-dialog__seg-btn--active');
      btn.addEventListener('click', () => {
        for (const b of buttons) b.classList.remove('settings-dialog__seg-btn--active');
        btn.classList.add('settings-dialog__seg-btn--active');
        onSelect(opt.value);
      });
      buttons.push(btn);
      wrap.appendChild(btn);
    }
    return wrap;
  }

  _buildColorsTab(container) {
    const mode = this.settings.getThemeMode();
    // Outside 'auto' there is exactly one relevant palette — keep edit in sync.
    if (mode !== 'auto') this._editMode = this.settings.getActiveMode();

    const hint = document.createElement('span');
    hint.className = 'field-hint';

    if (mode === 'auto') {
      const head = document.createElement('div');
      head.className = 'settings-dialog__colors-head';
      const headLabel = document.createElement('span');
      headLabel.className = 'settings-dialog__colors-head-label';
      headLabel.textContent = 'Editing';
      head.appendChild(headLabel);
      head.appendChild(this._buildSegmented(
        [
          { value: 'dark', label: 'Dark palette' },
          { value: 'light', label: 'Light palette' },
        ],
        this._editMode,
        (val) => {
          this._editMode = val;
          this._renderColorRows(rows);
          hint.textContent = this._colorsHint();
        }
      ));
      container.appendChild(head);
    }

    container.appendChild(hint);

    const rows = document.createElement('div');
    container.appendChild(rows);

    this._renderColorRows(rows);
    hint.textContent = this._colorsHint();
  }

  _colorsHint() {
    const mode = this.settings.getThemeMode();
    if (mode !== 'auto') return `Editing the ${this._editMode} theme palette.`;
    const active = this.settings.getActiveMode();
    return this._editMode === active
      ? `Editing the ${this._editMode} palette (currently visible).`
      : `Editing the ${this._editMode} palette — visible when your system uses ${this._editMode} mode.`;
  }

  _renderColorRows(container) {
    container.innerHTML = '';
    const palette = this.settings.getPalette(this._editMode);
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
      hexSpan.textContent = palette[key];

      const input = document.createElement('input');
      input.type = 'color';
      input.className = 'settings-dialog__color-input';
      input.value = palette[key];
      input.addEventListener('input', () => {
        hexSpan.textContent = input.value;
        this.settings.setColor(this._editMode, key, input.value);
      });

      row.appendChild(lbl);
      row.appendChild(hexSpan);
      row.appendChild(input);
      container.appendChild(row);
    }
  }

  _buildTypographyTab(container) {
    // UI font — chrome, menus, chat prose.
    const famLabel = document.createElement('label');
    famLabel.className = 'dialog__label';
    famLabel.textContent = 'UI Font';
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

    const famHint = document.createElement('span');
    famHint.className = 'field-hint';
    famHint.textContent = 'Used for the interface, menus, and chat text.';
    container.appendChild(famHint);

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

    // Code & terminal font (monospace only).
    const termLabel = document.createElement('label');
    termLabel.className = 'dialog__label';
    termLabel.textContent = 'Code & Terminal Font';
    container.appendChild(termLabel);

    const termSelect = document.createElement('select');
    termSelect.className = 'dialog__select';
    for (const key of FONT_GROUPS['Monospace']) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = FONT_PRESET_LABELS[key];
      if (key === this.settings.get('terminalFontFamily')) opt.selected = true;
      termSelect.appendChild(opt);
    }
    termSelect.addEventListener('change', () => {
      this.settings.set('terminalFontFamily', termSelect.value);
    });
    container.appendChild(termSelect);

    const termHint = document.createElement('span');
    termHint.className = 'field-hint';
    termHint.textContent = 'Used by the terminal, code editor, and code blocks. Monospace only.';
    container.appendChild(termHint);
  }

  _buildVoiceTab(container) {
    const tts = this.container.has('ttsManager') ? this.container.get('ttsManager') : null;
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
      ttsStatusEl.textContent = this._getTtsStatus(tts);
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

    // TTS Prompt Tag
    const ttsTagLabel = document.createElement('label');
    ttsTagLabel.className = 'dialog__label';
    ttsTagLabel.style.marginTop = '16px';
    ttsTagLabel.textContent = 'TTS Prompt Tag';
    container.appendChild(ttsTagLabel);

    const ttsTagInput = document.createElement('input');
    ttsTagInput.type = 'text';
    ttsTagInput.className = 'dialog__input';
    ttsTagInput.value = this.settings.get('ttsPromptTag') ?? '';
    ttsTagInput.placeholder = '[SPEAK RESPONSE]';
    ttsTagInput.addEventListener('input', () => {
      this.settings.set('ttsPromptTag', ttsTagInput.value);
    });
    container.appendChild(ttsTagInput);

    const ttsTagHint = document.createElement('span');
    ttsTagHint.className = 'field-hint';
    ttsTagHint.textContent = 'Appended to every message when TTS is active. Clear to disable.';
    container.appendChild(ttsTagHint);

    // --- STT Backend ---
    const stt = this.container.has('sttManager') ? this.container.get('sttManager') : null;
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

    // STT Prompt Tag
    const sttTagLabel = document.createElement('label');
    sttTagLabel.className = 'dialog__label';
    sttTagLabel.style.marginTop = '16px';
    sttTagLabel.textContent = 'STT Prompt Tag';
    container.appendChild(sttTagLabel);

    const sttTagInput = document.createElement('input');
    sttTagInput.type = 'text';
    sttTagInput.className = 'dialog__input';
    sttTagInput.value = this.settings.get('sttPromptTag') ?? '';
    sttTagInput.placeholder = '[VOICE DICTATION]';
    sttTagInput.addEventListener('input', () => {
      this.settings.set('sttPromptTag', sttTagInput.value);
    });
    container.appendChild(sttTagInput);

    const sttTagHint = document.createElement('span');
    sttTagHint.className = 'field-hint';
    sttTagHint.textContent = 'Prepended to every voice-dictated message. Clear to disable.';
    container.appendChild(sttTagHint);
  }

  _buildFilesTab(container) {
    const row = document.createElement('label');
    row.className = 'dialog__checkbox-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.settings.get('showHiddenFiles');
    checkbox.addEventListener('change', () => {
      this.settings.set('showHiddenFiles', checkbox.checked);
    });

    const label = document.createElement('span');
    label.textContent = 'Show hidden files (dotfiles)';

    row.appendChild(checkbox);
    row.appendChild(label);
    container.appendChild(row);

    const hint = document.createElement('span');
    hint.className = 'field-hint';
    hint.textContent = 'When on, entries beginning with "." (e.g. .claude/, .gitignore, .env) appear in the sidebar file tree, styled italic and dimmer.';
    container.appendChild(hint);
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

}
