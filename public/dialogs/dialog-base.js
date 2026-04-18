/**
 * DialogBase - shared modal behavior for all dialogs.
 * Handles backdrop, escape key, focus trap, show/hide lifecycle.
 */
class DialogBase {
  constructor(container, dialogId) {
    this.container = container;
    this.bus = container.get('bus');
    this.dialogId = dialogId;
    this.el = null;
    this._panel = null;
    this._boundEscape = this._onEscape.bind(this);
    this._createShell();
  }

  _createShell() {
    this.el = document.createElement('div');
    this.el.id = this.dialogId;
    this.el.className = 'dialog hidden';
    this.el.dataset.testid = `dialog-${this.dialogId}`;

    const backdrop = document.createElement('div');
    backdrop.className = 'dialog__backdrop';
    backdrop.addEventListener('click', () => this.hide());

    this._panel = document.createElement('div');
    this._panel.className = 'dialog__panel';

    this.el.appendChild(backdrop);
    this.el.appendChild(this._panel);
    document.body.appendChild(this.el);
  }

  /**
   * Set the panel HTML content. Subclasses call this in render().
   */
  _setContent(html) {
    this._panel.innerHTML = html;
  }

  /**
   * Get the panel element for DOM manipulation.
   */
  get panel() {
    return this._panel;
  }

  show() {
    this.el.classList.remove('hidden');
    document.addEventListener('keydown', this._boundEscape);
    // Focus the first focusable element
    requestAnimationFrame(() => {
      const focusable = this._panel.querySelector('button, input, select, textarea, [tabindex]');
      if (focusable) focusable.focus();
    });
  }

  hide() {
    this.el.classList.add('hidden');
    document.removeEventListener('keydown', this._boundEscape);
  }

  get isVisible() {
    return !this.el.classList.contains('hidden');
  }

  _onEscape(e) {
    if (e.key === 'Escape' && this.isVisible) {
      e.preventDefault();
      this.hide();
    }
  }

  /**
   * Helper to create a title bar with title, badge, and close button.
   */
  _createTitleBar(titleText, badgeText) {
    const bar = document.createElement('div');
    bar.className = 'dialog__title-bar';

    const title = document.createElement('h3');
    title.className = 'dialog__title';
    title.textContent = titleText;

    const badge = document.createElement('span');
    badge.className = 'dialog__badge';
    badge.textContent = badgeText;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'dialog__close';
    closeBtn.dataset.testid = `dialog-close-${this.dialogId}`;
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => this.hide());

    bar.appendChild(title);
    bar.appendChild(badge);
    bar.appendChild(closeBtn);
    return bar;
  }

  /**
   * Helper to create tabbed header.
   * Returns { header, setActiveTab } where setActiveTab(name) updates the UI.
   */
  _createTabs(tabs, onSwitch) {
    const header = document.createElement('div');
    header.className = 'dialog__tabs';

    const buttons = {};
    for (const tab of tabs) {
      const btn = document.createElement('button');
      btn.className = 'dialog__tab';
      btn.textContent = tab.label;
      btn.dataset.tab = tab.name;
      btn.addEventListener('click', () => {
        onSwitch(tab.name);
        for (const b of Object.values(buttons)) b.classList.remove('dialog__tab--active');
        btn.classList.add('dialog__tab--active');
      });
      buttons[tab.name] = btn;
      header.appendChild(btn);
    }

    // Activate first tab
    if (tabs.length > 0) {
      buttons[tabs[0].name].classList.add('dialog__tab--active');
    }

    return {
      header,
      setActiveTab(name) {
        for (const b of Object.values(buttons)) b.classList.remove('dialog__tab--active');
        if (buttons[name]) buttons[name].classList.add('dialog__tab--active');
      }
    };
  }

  /**
   * Create a voice selection dropdown, optionally pre-selecting a voice.
   */
  _createVoiceSelect(selectedVoice) {
    const select = document.createElement('select');
    select.className = 'dialog__select';

    const ttsManager = this.container.has('ttsManager') ? this.container.get('ttsManager') : null;
    const voices = ttsManager?.voices || [];
    if (voices.length > 0) {
      const groups = {};
      for (const v of voices) {
        const lang = v.language || 'Other';
        if (!groups[lang]) groups[lang] = [];
        groups[lang].push(v);
      }
      for (const [lang, list] of Object.entries(groups)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = lang;
        for (const v of list) {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = v.name;
          if (v.id === (selectedVoice || ttsManager?.voice || 'af_heart')) opt.selected = true;
          optgroup.appendChild(opt);
        }
        select.appendChild(optgroup);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = 'af_heart';
      opt.textContent = 'Heart (F)';
      select.appendChild(opt);
    }
    return select;
  }

  /**
   * Add dynamic provider settings fields based on the selected model.
   * @param {HTMLElement} form - Parent form element.
   * @param {HTMLSelectElement} modelSelect - Model select dropdown.
   * @param {Object|null} existingSettings - Pre-existing settings to populate (for editing).
   * @returns {HTMLElement} The settings container element.
   */
  _addProviderSettings(form, modelSelect, existingSettings) {
    const state = this.container.get('state');
    const settingsContainer = document.createElement('div');
    settingsContainer.className = 'dialog__settings';
    form.appendChild(settingsContainer);

    const parsed = existingSettings && typeof existingSettings === 'string'
      ? JSON.parse(existingSettings)
      : existingSettings || {};

    const renderSettings = () => {
      settingsContainer.innerHTML = '';
      const selectedModel = state.models.find(m => m.value === modelSelect.value);
      if (!selectedModel) return;
      const fields = state.providerSettings[selectedModel.provider] || [];
      for (const field of fields) {
        const row = document.createElement('div');
        row.className = 'dialog__setting-row';
        const lbl = document.createElement('label');
        lbl.className = 'dialog__label';
        lbl.textContent = field.label || field.name;
        row.appendChild(lbl);

        if (field.type === 'boolean') {
          row.className = 'dialog__setting-row dialog__setting-row--checkbox';
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.name = field.key;
          input.checked = parsed[field.key] !== undefined ? parsed[field.key] : !!field.default;
          row.insertBefore(input, lbl);
        } else if (field.type === 'number') {
          const input = document.createElement('input');
          input.type = 'number';
          input.name = field.key;
          input.value = parsed[field.key] !== undefined ? parsed[field.key] : (field.default ?? '');
          if (field.min !== undefined) input.min = field.min;
          if (field.max !== undefined) input.max = field.max;
          input.step = field.step || 'any';
          if (field.placeholder) input.placeholder = field.placeholder;
          input.className = 'dialog__input';
          row.appendChild(input);
        } else {
          const input = document.createElement('input');
          input.type = 'text';
          input.name = field.key;
          input.dataset.settingType = field.type;
          const val = parsed[field.key];
          input.value = val !== undefined
            ? (Array.isArray(val) ? val.join(' ') : val)
            : (field.default ?? '');
          if (field.placeholder) input.placeholder = field.placeholder;
          input.className = 'dialog__input';
          row.appendChild(input);
        }
        settingsContainer.appendChild(row);
      }
    };

    modelSelect.addEventListener('change', renderSettings);
    renderSettings();
    return settingsContainer;
  }

  /**
   * Collect settings values from a provider settings container.
   */
  _collectSettings(container) {
    const settings = {};
    for (const input of container.querySelectorAll('input, select')) {
      if (!input.name) continue;
      if (input.type === 'checkbox') {
        settings[input.name] = input.checked;
      } else if (input.type === 'number' && input.value) {
        settings[input.name] = parseFloat(input.value);
      } else if (input.dataset.settingType === 'string[]') {
        const val = input.value.trim();
        if (val) settings[input.name] = val.split(/\s+/);
      } else if (input.value) {
        settings[input.name] = input.value;
      }
    }
    return Object.keys(settings).length > 0 ? settings : null;
  }
}
