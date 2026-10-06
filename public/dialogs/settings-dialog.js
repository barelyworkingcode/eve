// One short sheet: Display, Voice, Modes, Files, then a pointer to Relay.
// SettingsManager is untouched, so stored values for controls this sheet no
// longer offers (palettes, fonts, prompt tags) keep applying.
const SETTINGS_SPEEDS = ['0.75', '0.9', '1', '1.1', '1.25', '1.5'];

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
    // Projects can arrive after the sheet opens. Replace only the Modes group
    // so other controls keep their element, value and focus.
    this.bus.on(EVT.PROJECTS_LOADED, () => {
      if (!this.isVisible) return;
      const modes = this._panel.querySelector('[data-testid="settings-group-modes"]');
      if (modes) modes.replaceWith(this._buildModes());
    });
  }

  hide() {
    super.hide();
    if (this.container.has('voiceInitCoordinator')) {
      this.container.get('voiceInitCoordinator').evaluate();
    }
  }

  render() {
    this._panel.innerHTML = '';
    this._panel.classList.add('settings-sheet');

    const titleBar = document.createElement('div');
    titleBar.className = 'dialog__title-bar';
    const title = document.createElement('h3');
    title.className = 'dialog__title';
    title.textContent = 'Settings';
    const done = document.createElement('button');
    done.className = 'dialog__btn dialog__btn--primary';
    done.dataset.testid = 'settings-done';
    done.textContent = 'Done';
    done.addEventListener('click', () => this.hide());
    titleBar.appendChild(title);
    titleBar.appendChild(done);
    this._panel.appendChild(titleBar);

    const body = document.createElement('div');
    body.className = 'settings-sheet__body';
    body.appendChild(this._buildDisplay());
    const voice = this._buildVoice();
    if (voice) body.appendChild(voice);
    body.appendChild(this._buildModes());
    body.appendChild(this._buildFiles());
    body.appendChild(this._buildRelayRow());
    this._panel.appendChild(body);
  }

  _group(name, label) {
    const group = document.createElement('section');
    group.className = 'settings-sheet__group';
    group.dataset.testid = `settings-group-${name}`;
    const h = document.createElement('h4');
    h.className = 'settings-sheet__heading';
    h.textContent = label;
    group.appendChild(h);
    return group;
  }

  _row(labelText, control) {
    const row = document.createElement('div');
    row.className = 'settings-sheet__row';
    const label = document.createElement('span');
    label.className = 'settings-sheet__label';
    label.textContent = labelText;
    row.appendChild(label);
    row.appendChild(control);
    return row;
  }

  _buildDisplay() {
    const group = this._group('display', 'Display');

    const options = [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']];
    const current = this.settings.getThemeMode();
    const wrap = document.createElement('div');
    wrap.className = 'settings-dialog__segmented';
    const buttons = [];
    for (const [value, label] of options) {
      const btn = document.createElement('button');
      btn.className = 'settings-dialog__seg-btn';
      btn.dataset.testid = `settings-appearance-${value}`;
      btn.textContent = label;
      const sync = (on) => {
        btn.classList.toggle('settings-dialog__seg-btn--active', on);
        btn.setAttribute('aria-pressed', String(on));
      };
      sync(value === current);
      btn.addEventListener('click', () => {
        this.settings.setThemeMode(value);
        buttons.forEach(([v, b, s]) => s(v === value));
      });
      buttons.push([value, btn, sync]);
      wrap.appendChild(btn);
    }
    group.appendChild(this._row('Appearance', wrap));

    const size = document.createElement('input');
    size.type = 'range';
    size.className = 'settings-sheet__range';
    size.dataset.testid = 'settings-text-size';
    size.min = '10';
    size.max = '20';
    size.step = '1';
    size.value = String(this.settings.get('fontSize'));
    const readout = document.createElement('span');
    readout.className = 'settings-sheet__value';
    readout.textContent = size.value;
    size.addEventListener('input', () => {
      readout.textContent = size.value;
      this.settings.set('fontSize', parseInt(size.value, 10));
    });
    const sizeWrap = document.createElement('div');
    sizeWrap.className = 'settings-sheet__inline';
    sizeWrap.appendChild(size);
    sizeWrap.appendChild(readout);
    group.appendChild(this._row('Text size', sizeWrap));
    return group;
  }

  _buildVoice() {
    const tts = this.container.has('ttsManager') ? this.container.get('ttsManager') : null;
    if (!tts) return null;
    const group = this._group('voice', 'Voice');

    const voice = this._createVoiceSelect();
    voice.dataset.testid = 'settings-voice';
    voice.addEventListener('change', () => tts.setVoice(voice.value));
    group.appendChild(this._row('Voice', voice));

    const speed = document.createElement('select');
    speed.className = 'dialog__select';
    speed.dataset.testid = 'settings-voice-speed';
    for (const s of SETTINGS_SPEEDS) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = `${s}×`;
      speed.appendChild(opt);
    }
    speed.value = String(tts.speed);
    speed.addEventListener('change', () => tts.setSpeed(speed.value));
    group.appendChild(this._row('Speed', speed));

    if (tts.isNativeApp) {
      group.appendChild(this._row('Speech engine', this._engineSelect('settings-tts-engine', tts)));
      const stt = this.container.has('sttManager') ? this.container.get('sttManager') : null;
      if (stt && stt.isNativeApp) {
        group.appendChild(this._row('Dictation engine', this._engineSelect('settings-stt-engine', stt)));
      }
    }
    return group;
  }

  _engineSelect(testid, manager) {
    const select = document.createElement('select');
    select.className = 'dialog__select';
    select.dataset.testid = testid;
    for (const [value, label] of [['native', 'On this device'], ['server', 'Server']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      if (value === manager.backend) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => manager.setBackend(select.value));
    return select;
  }

  _buildModes() {
    const group = this._group('modes', 'Modes');
    const state = this.container.has('state') ? this.container.get('state') : null;
    const projects = state ? Array.from(state.projects.values()) : [];
    for (const [mode, label] of [['home', 'Home'], ['work', 'Work']]) {
      const p = projects.find(x => (x.defaultFor || []).includes(mode));
      const row = document.createElement('div');
      row.className = 'settings-sheet__text';
      row.dataset.testid = `settings-default-${mode}`;
      row.textContent = p ? `${label} starts in ${p.name}` : `${label}: no default. Ask lets you pick.`;
      group.appendChild(row);
      if (p) {
        const mp = ModePresets.forMode(projects, mode);
        const { ask, voice } = mp.project && mp.project.id === p.id ? mp : {};
        const presets = document.createElement('div');
        presets.className = 'settings-sheet__text';
        presets.dataset.testid = `settings-presets-${mode}`;
        presets.textContent = `Ask: ${ask ? ask.name : 'none'} · Voice: ${voice ? voice.name : 'none'}`;
        group.appendChild(presets);
      }
    }
    return group;
  }

  _buildFiles() {
    const group = this._group('files', 'Files');
    const row = document.createElement('label');
    row.className = 'dialog__checkbox-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.testid = 'settings-hidden-files';
    checkbox.checked = !!this.settings.get('showHiddenFiles');
    checkbox.addEventListener('change', () => {
      this.settings.set('showHiddenFiles', checkbox.checked);
    });
    const label = document.createElement('span');
    label.textContent = 'Show hidden files (dotfiles)';
    row.appendChild(checkbox);
    row.appendChild(label);
    group.appendChild(row);
    return group;
  }

  _buildRelayRow() {
    const group = this._group('relay', 'Relay');
    const text = document.createElement('p');
    text.className = 'settings-sheet__text';
    text.dataset.testid = 'settings-relay';
    text.textContent = 'Models, tools, hosts and permissions live in Relay on your Mac.';
    group.appendChild(text);
    return group;
  }
}
