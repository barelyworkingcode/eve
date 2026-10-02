// "Make this a routine" (docs/design-routines.md, S5b-A2): a header button on a
// chat thread opens a panel pre-filled from the thread. Create posts through
// TaskManager.createTask, which owns the save-error toast. Collaborators are
// read from the container at call time: this is built by features.boot(),
// before most of them exist.
class RoutinePanel {
  static DEFAULT_CHOICE = { when: 'daily', day: 'monday', time: '09:00', minute: 0 };
  static WHENS = [['daily', 'Every day'], ['weekly', null], ['hourly', 'Every hour'], ['on_demand', 'When I ask']];
  static NAME_MAX = 60;

  // Pure: the model the routine will use. `models` is what modelsForProject offers.
  static resolveModel(threadModel, models) {
    if (models.some(m => m.value === threadModel)) return { value: threadModel, replaced: null };
    const first = models[0];
    if (!first) return { value: '', replaced: null };
    return { value: first.value, replaced: threadModel || null };
  }

  // Pure: first user prompt in a session history, or ''.
  static firstPrompt(history) {
    const entry = (history || []).find(h => h && h.role === 'user' && typeof h.content === 'string' && h.content.trim());
    return entry ? entry.content : '';
  }

  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('RoutinePanel');
    this.state = container.get('state');
    this.sessionId = null;
    this.choice = { ...RoutinePanel.DEFAULT_CHOICE };
    this._saving = false;
    this._wired = false;
    this._wire();
  }

  get el() { return document.getElementById('routinePanel'); }
  get button() { return document.getElementById('makeRoutineBtn'); }

  _wire() {
    const sync = () => this.syncButton();
    for (const evt of [EVT.SESSION_SWITCH, EVT.SESSION_UPDATED, EVT.SESSION_REMOVED, EVT.CHAT_USER_MESSAGE]) {
      if (evt) this.bus.on(evt, sync);
    }
    // Tab changes of any kind (file, terminal, routines) rewrite the tab bar.
    const bar = document.getElementById('tabBar');
    if (bar && typeof MutationObserver !== 'undefined') {
      new MutationObserver(sync).observe(bar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    }
    // Nothing emits CHAT_USER_MESSAGE for a message typed in the composer, so a
    // new thread's first message is only seen as it lands in the message list.
    const messages = document.getElementById('messages');
    if (messages && typeof MutationObserver !== 'undefined') {
      new MutationObserver(sync).observe(messages, { childList: true });
    }
    this.button?.addEventListener('click', () => {
      const id = this._eligibleSessionId();
      if (id) this.open(id);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this._isOpen()) this.close();
    });
    this.syncButton();
  }

  _isOpen() {
    const el = this.el;
    return !!(el && !el.classList.contains('hidden'));
  }

  // The active chat thread that may become a routine, or null.
  _eligibleSessionId() {
    if (!this.container.has('tabManager')) return null;
    const tm = this.container.get('tabManager');
    const tab = tm.tabs.find(t => t.id === tm.activeTabId);
    if (!tab || tab.type !== 'session') return null;
    const session = this.state.sessions.get(tab.id);
    if (!session || !session.projectId || session.sessionType === 'voice') return null;
    if (this.state.isTaskRun(tab.id)) return null;
    if (!RoutinePanel.firstPrompt(this.state.sessionHistories.get(tab.id))) return null;
    return tab.id;
  }

  syncButton() {
    const id = this._eligibleSessionId();
    this.button?.classList.toggle('hidden', !id);
    if (this._isOpen() && id !== this.sessionId) this.close();
  }

  open(sessionId) {
    const session = this.state.sessions.get(sessionId);
    const root = this.el;
    if (!session || !root) return;
    const project = this.state.getProject(session.projectId);
    const models = this.state.modelsForProject(session.projectId);
    const model = RoutinePanel.resolveModel(session.model, models);
    this.sessionId = sessionId;
    this.choice = { ...RoutinePanel.DEFAULT_CHOICE };
    this._ctx = { session, project, models, model };
    const title = (typeof sessionDisplayName === 'function' ? sessionDisplayName(session, project) : session.name) || '';
    this._build(root, {
      name: title.slice(0, RoutinePanel.NAME_MAX),
      prompt: RoutinePanel.firstPrompt(this.state.sessionHistories.get(sessionId)),
    });
    root.classList.remove('hidden');
    this._update();
    root.querySelector('[data-testid="routine-panel-name"]')?.focus();
  }

  close() {
    this.el?.classList.add('hidden');
    this.sessionId = null;
    this._saving = false;
  }

  _mk(tag, cls, testid, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (testid) el.dataset.testid = testid;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  _field(root, label, control) {
    const wrap = this._mk('label', 'routine-panel__field');
    wrap.append(this._mk('span', 'routine-panel__label', null, label), control);
    root.appendChild(wrap);
    return control;
  }

  _build(root, { name, prompt }) {
    root.textContent = '';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Make this a routine');
    const { models, model, project } = this._ctx;

    const head = this._mk('div', 'routine-panel__head');
    head.append(this._mk('h2', 'routine-panel__title', null, 'Make this a routine'));
    const cancel = this._mk('button', 'routine-panel__close', 'routine-panel-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => this.close());
    head.appendChild(cancel);
    root.appendChild(head);

    const body = this._mk('div', 'routine-panel__body');
    this.nameInput = this._mk('input', 'dialog__input routine-panel__input', 'routine-panel-name');
    this.nameInput.type = 'text';
    this.nameInput.maxLength = RoutinePanel.NAME_MAX;
    this.nameInput.value = name;
    this._field(body, 'Routine name', this.nameInput);

    this.promptInput = this._mk('textarea', 'dialog__input routine-panel__input routine-panel__prompt', 'routine-panel-prompt');
    this.promptInput.rows = 5;
    this.promptInput.value = prompt;
    this._field(body, 'Prompt', this.promptInput);

    this.modelSelect = this._mk('select', 'dialog__select routine-panel__input', 'routine-panel-model');
    renderModelSelect(this.modelSelect, models, { className: 'dialog__select routine-panel__input', selectedValue: model.value });
    this.modelSelect.dataset.testid = 'routine-panel-model';
    this.modelSelect.value = model.value;
    this._field(body, 'Model', this.modelSelect);
    if (model.replaced) {
      const label = models.find(m => m.value === model.value)?.label || model.value;
      body.appendChild(this._mk('div', 'routine-panel__note', 'routine-panel-model-note',
        `${model.replaced} isn't allowed in ${project?.name || 'this project'} now, so this uses ${label}.`));
    }

    const chips = this._mk('div', 'routine-panel__chips');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'When');
    this.chips = {};
    for (const [when, label] of RoutinePanel.WHENS) {
      const chip = this._mk('button', 'routine-panel__chip', `routine-panel-when-${when}`, label || '');
      chip.type = 'button';
      chip.addEventListener('click', () => { this.choice.when = when; this._update(); });
      this.chips[when] = chip;
      chips.appendChild(chip);
    }
    body.appendChild(chips);

    this.dayRow = this._mk('div', 'routine-panel__row');
    this.daySelect = this._mk('select', 'dialog__select routine-panel__input', 'routine-panel-day');
    for (const d of TaskSchedule.WEEKDAYS) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = RoutinePanel._cap(d);
      this.daySelect.appendChild(opt);
    }
    this.daySelect.addEventListener('change', () => { this.choice.day = this.daySelect.value; this._update(); });
    this.dayRow.appendChild(this.daySelect);
    body.appendChild(this.dayRow);

    this.timeInput = this._mk('input', 'dialog__input routine-panel__input', 'routine-panel-time');
    this.timeInput.type = 'time';
    this.timeInput.addEventListener('input', () => { this.choice.time = this.timeInput.value; this._update(); });
    this.timeRow = this._mk('div', 'routine-panel__row');
    this._field(this.timeRow, 'At', this.timeInput);
    body.appendChild(this.timeRow);

    this.minuteInput = this._mk('input', 'dialog__input routine-panel__input', 'routine-panel-minute');
    this.minuteInput.type = 'number';
    this.minuteInput.min = '0';
    this.minuteInput.max = '59';
    this.minuteInput.addEventListener('input', () => {
      const n = parseInt(this.minuteInput.value, 10);
      this.choice.minute = Number.isFinite(n) ? Math.min(59, Math.max(0, n)) : 0;
      this._update();
    });
    this.minuteRow = this._mk('div', 'routine-panel__row');
    this._field(this.minuteRow, 'Minute past the hour', this.minuteInput);
    body.appendChild(this.minuteRow);

    this.readback = this._mk('p', 'routine-panel__sentence', 'routine-panel-sentence');
    this.modelSelect.addEventListener('change', () => this._update());
    for (const input of [this.nameInput, this.promptInput]) input.addEventListener('input', () => this._update());
    body.appendChild(this.readback);

    this.create = this._mk('button', 'dialog__btn dialog__btn--primary routine-panel__create', 'routine-panel-create', 'Create routine');
    this.create.type = 'button';
    this.create.addEventListener('click', () => this._create());
    body.appendChild(this.create);
    root.appendChild(body);
  }

  static _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  _schedule() { return RoutineSentence.fromChoice(this.choice); }

  _modelLabel() {
    const value = this.modelSelect.value;
    return this._ctx.models.find(m => m.value === value)?.label || value;
  }

  _update() {
    const c = this.choice;
    for (const [when, chip] of Object.entries(this.chips)) {
      chip.classList.toggle('routine-panel__chip--active', when === c.when);
      chip.setAttribute('aria-pressed', String(when === c.when));
    }
    this.chips.weekly.textContent = `Every ${RoutinePanel._cap(c.day)}`;
    this.dayRow.hidden = c.when !== 'weekly';
    this.timeRow.hidden = c.when !== 'daily' && c.when !== 'weekly';
    this.minuteRow.hidden = c.when !== 'hourly';
    if (this.daySelect.value !== c.day) this.daySelect.value = c.day;
    if (this.timeInput.value !== c.time) this.timeInput.value = c.time;
    if (document.activeElement !== this.minuteInput) this.minuteInput.value = String(c.minute);
    const projectName = this._ctx.project?.name || 'this project';
    this.readback.textContent = `${RoutineSentence.sentence(this._schedule())}, in ${projectName}, using ${this._modelLabel()}.`;
    const timed = c.when === 'daily' || c.when === 'weekly';
    const ok = this.nameInput.value.trim() && this.promptInput.value.trim() && this.modelSelect.value
      && (!timed || /^\d{2}:\d{2}$/.test(c.time));
    this.create.disabled = !ok || this._saving;
  }

  async _create() {
    if (this._saving || this.create.disabled) return;
    this._saving = true;
    this.create.disabled = true;
    try {
      const task = await this.container.get('taskManager').createTask({
        name: this.nameInput.value.trim(),
        projectId: this._ctx.session.projectId,
        prompt: this.promptInput.value,
        model: this.modelSelect.value,
        schedule: this._schedule(),
        enabled: true,
        sessionType: 'headless',
        catchUp: false,
      });
      if (task) this.close(); // a failed create keeps the panel; the save-error toast has shown
    } finally {
      this._saving = false;
      if (this._isOpen()) this._update();
    }
  }
}

if (typeof features !== 'undefined') {
  features.register({
    id: 'routinePanel',
    init: (container) => new RoutinePanel(container),
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RoutinePanel;
}
