/**
 * The Morning brief card. The brief is a relayScheduler task named
 * Brief.NAME; its last run's response ends in schema-v1 JSON written by a model
 * that read mail. Every string from it is untrusted: it is set with
 * textContent only, trimmed and capped. No element is built from brief data
 * other than div, p and span, so no link, image or markup can come from it.
 */
class BriefPart extends TodayPart {
  static LIMITS = { title: 120, note: 200, from: 80, subject: 120, weather: 120, line: 200, due: 80, tag: 40 };
  static MAX_MAIL = 5;

  constructor() {
    super();
    this.id = 'brief';
    this.modes = ['home', 'work'];
    this.order = 15;
    this.title = 'Morning brief';
    this.sources = ['tasks'];
    this.events = [EVT.TASKS_LOADED, EVT.TASK_UPDATED, EVT.PROJECTS_LOADED, EVT.MODE_CHANGED, EVT.MODELS_LOADED];
    this._history = null;
    this._busy = false;
    this._pick = '';
    this._shown = new Map(); // task id -> { when, brief } of the last readable run
    this._speaking = false;
    this._refreshed = new Set(); // task ids whose stored prompt was already refreshed this page load
  }

  onMount() {
    this.ctx.on(EVT.TTS_PLAYBACK_ENDED, () => {
      if (!this._speaking) return;
      this._speaking = false;
      this.paint();
    });
  }

  static cap(value, max) {
    const s = typeof value === 'string' ? value.trim() : '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  }

  _exec(task) {
    if (!this._history) {
      const tm = this.ctx.container.has('taskManager') ? this.ctx.container.get('taskManager') : null;
      this._history = new RoutineHistory({
        load: id => (tm ? tm.loadHistory(id) : Promise.resolve([])),
        onChange: () => this.paint(),
        limit: 3,
      });
    }
    return this._history.newest(task);
  }

  _task() {
    const { state } = this.ctx;
    let best = null;
    for (const t of state.tasks.values()) {
      if (!Brief.isBrief(t) || !state.isSessionInMode({ projectId: t.projectId })) continue;
      if (!best || String(t.createdAt || '') >= String(best.createdAt || '')) best = t;
    }
    return best;
  }

  // A brief keeps the prompt it was created with; bring an older one up to date, once per task, silently.
  // The scheduler's PUT replaces the whole task, so send the definition the task dialog would on an edit.
  _refreshPrompt(task) {
    const { container, state } = this.ctx;
    if (!Brief.PREVIOUS_PROMPTS.includes(task.prompt) || this._refreshed.has(task.id) || !container.has('api')) return;
    this._refreshed.add(task.id);
    const body = {
      name: task.name, projectId: task.projectId, schedule: task.schedule, enabled: task.enabled,
      sessionType: task.sessionType, prompt: Brief.prompt(), model: task.model,
    };
    if (task.useRelayTools) body.useRelayTools = true;
    if (task.catchUp) body.catchUp = true;
    container.get('api').updateTask(task.id, body)
      .then(updated => { if (updated?.id) state.addTask(updated); })
      .catch(err => console.error('[Today] brief prompt refresh failed for', task.id, err));
  }

  _setupProject() {
    const projects = this.ctx.state.getModeProjects();
    const mode = this.ctx.state.mode;
    return projects.find(p => (p.defaultFor || []).includes(mode)) || (projects.length === 1 ? projects[0] : null);
  }

  _classifier() {
    const { container } = this.ctx;
    return container.has('needsReplyClassifier') ? container.get('needsReplyClassifier') : new Brief.UnreadNeedsReply();
  }

  _text(tag, cls, text, testid) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (testid) el.dataset.testid = testid;
    el.textContent = text;
    return el;
  }

  _button(label, testid, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'today__retry today-brief__btn';
    b.dataset.testid = testid;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  async _run(task) {
    if (this._busy) return;
    this._busy = true;
    try { await this.ctx.container.get('taskManager').runTask(task.id); } finally { this._busy = false; }
    this.paint();
  }

  _open(task) {
    const { container } = this.ctx;
    if (container.has('taskViewer')) container.get('taskViewer').openLastRun(task);
  }

  render(root) {
    const { state } = this.ctx;
    root.appendChild(todayEyebrow('Morning brief'));
    const task = this._task();
    if (!task) return this._renderSetup(root);
    this._refreshPrompt(task);

    const wrap = document.createElement('div');
    wrap.className = 'today-brief';
    root.appendChild(wrap);
    const line = (text, testid) => wrap.appendChild(this._text('p', 'today-brief__line', text, testid));
    const actions = () => {
      const row = document.createElement('div');
      row.className = 'today-brief__actions';
      wrap.appendChild(row);
      return row;
    };

    const model = state.models.find(m => m.value === task.model);
    if (model && model.provider !== 'chat') {
      line(`This brief uses ${model.label || model.value}. Pick a local model for it in Edit.`, 'today-brief-model-warning');
      actions().appendChild(this._button('Edit', 'today-brief-edit', () =>
        this.ctx.bus.emit(EVT.DIALOG_TASK, { projectId: task.projectId, editTaskId: task.id })));
      return;
    }

    const status = task.lastStatus;
    const ran = status === 'success' || status === 'error' || status === 'timeout';
    const running = status === 'running';
    if (!ran && !running) {
      line(`No brief yet. It runs ${RoutineSentence.sentence(task.schedule).replace(/^./, c => c.toLowerCase())}.`);
      return;
    }

    const exec = ran ? this._exec(task) : null;
    if (ran && status !== 'success') {
      const prev = this._shown.get(task.id);
      line(RoutineSentence.result({ ...task, enabled: true }, exec).text, 'today-brief-failed');
      actions().appendChild(this._button('Retry', 'today-brief-retry', () => this._run(task)));
      if (prev) this._renderBrief(wrap, task, prev, true, false);
      return;
    }
    if (status === 'success' && exec) {
      const parsed = Brief.parse(exec.response);
      if (parsed.ok) this._shown.set(task.id, { when: task.lastRun, brief: parsed.brief });
      else this._shown.delete(task.id);
      if (!parsed.ok) {
        line("The brief came back in a form eve can't read.", 'today-brief-unreadable');
        actions().appendChild(this._button('Open', 'today-brief-open', () => this._open(task)));
        return;
      }
    }
    if (running) line('Refreshing…', 'today-brief-running');
    const shown = this._shown.get(task.id);
    if (shown) this._renderBrief(wrap, task, shown, !running);
  }

  _renderSetup(root) {
    const { state } = this.ctx;
    const wrap = document.createElement('div');
    wrap.className = 'today-brief';
    root.appendChild(wrap);
    const line = (text, testid) => wrap.appendChild(this._text('p', 'today-brief__line', text, testid));
    const project = this._setupProject();
    if (!project) {
      line(`Set a default ${state.mode === 'work' ? 'Work' : 'Home'} project in Relay to get a morning brief.`);
      return;
    }
    const models = Brief.localModels(state.modelsForProject(project.id));
    if (!models.length) {
      line(`The morning brief needs a local model. None is allowed in ${project.name}.`);
      return;
    }
    const setup = document.createElement('div');
    setup.dataset.testid = 'today-brief-setup';
    setup.className = 'today-brief__setup';
    wrap.appendChild(setup);
    setup.appendChild(this._text('p', 'today-brief__line',
      `Get a morning brief in ${project.name} every day at ${Brief.SCHEDULE_TIME}.`));
    const row = document.createElement('div');
    row.className = 'today-brief__actions';
    setup.appendChild(row);
    let select = null;
    if (models.length >= 2) {
      select = document.createElement('select');
      select.className = 'today-brief__model';
      select.dataset.testid = 'today-brief-model';
      select.setAttribute('aria-label', 'Brief model');
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.value;
        opt.textContent = m.label || m.value;
        select.appendChild(opt);
      }
      select.value = models.some(m => m.value === this._pick) ? this._pick : models[0].value;
      select.addEventListener('change', () => { this._pick = select.value; });
      row.appendChild(select);
    }
    const go = this._button('Set up', 'today-brief-setup-go', async () => {
      if (this._busy) return;
      this._busy = true;
      go.disabled = true;
      try {
        await this.ctx.container.get('taskManager').createTask(Brief.taskBody(project.id, select ? select.value : models[0].value));
      } finally { this._busy = false; }
      this.paint();
    });
    row.appendChild(go);
  }

  _renderBrief(wrap, task, shown, withActions = true, canListen = withActions) {
    const { cap, LIMITS } = BriefPart;
    const b = shown.brief;
    const box = document.createElement('div');
    box.className = 'today-brief__body';
    wrap.appendChild(box);
    box.appendChild(this._text('p', 'today-brief__when', `Brief · ${RoutineSentence.when(shown.when)}`, 'today-brief-when'));

    const spoken = [];
    let spokenItems = null;
    const section = (name, label, count) => {
      const heading = count == null ? label : `${label} (${count})`;
      spokenItems = [];
      spoken.push({ heading, items: spokenItems });
      const s = document.createElement('div');
      s.className = 'today-brief__section';
      s.dataset.testid = `today-brief-${name}`;
      s.appendChild(this._text('p', 'today-brief__label', heading));
      box.appendChild(s);
      return s;
    };
    const item = (s, text, extra) => {
      const d = this._text('div', 'today-brief__item', text, extra);
      if (text) spokenItems.push(text.replace(/ · /g, ', '));
      s.appendChild(d);
      return d;
    };

    if (b.events.length) {
      const s = section('events', 'Events');
      for (const e of b.events) {
        const d = item(s, [cap(e.time, LIMITS.tag), cap(e.title, LIMITS.title)].filter(Boolean).join(' · '));
        const note = cap(e.note, LIMITS.note);
        if (note) d.appendChild(this._text('div', 'today-brief__note', note));
      }
    }
    if (b.reminders.length) {
      const s = section('reminders', 'Reminders');
      for (const r of b.reminders) item(s, [cap(r.title, LIMITS.title), cap(r.due, LIMITS.due)].filter(Boolean).join(' · '));
    }
    const need = b.mail.filter(m => this._classifier().needsReply(m));
    if (need.length) {
      const s = section('reply', 'Needs a reply', need.length);
      need.slice(0, BriefPart.MAX_MAIL).forEach((m, i) =>
        item(s, `${cap(m.from, LIMITS.from)} · ${cap(m.subject, LIMITS.subject)}`, `today-brief-mail-${i}`));
      if (need.length > BriefPart.MAX_MAIL) s.appendChild(this._text('p', 'today__more', `+${need.length - BriefPart.MAX_MAIL} more`));
    }
    if (b.weather) {
      const s = section('weather', 'Weather');
      const range = [b.weather.high != null ? `high ${b.weather.high}` : '', b.weather.low != null ? `low ${b.weather.low}` : ''].filter(Boolean);
      item(s, [cap(b.weather.summary, LIMITS.weather), ...range].filter(Boolean).join(' · '));
    }
    if (b.notes.length) {
      const s = section('notes', 'Notes');
      for (const n of b.notes) item(s, cap(n, LIMITS.line));
    }
    if (b.unavailable.length) {
      box.appendChild(this._text('p', 'today-brief__line today-brief__unavailable',
        `Not in this brief: ${b.unavailable.map(u => cap(u, LIMITS.tag)).join(', ')}.`, 'today-brief-unavailable'));
    }
    if (!withActions) return;
    const row = document.createElement('div');
    row.className = 'today-brief__actions';
    wrap.appendChild(row);
    row.appendChild(this._button('Refresh', 'today-brief-refresh', () => this._run(task)));
    row.appendChild(this._button('Open', 'today-brief-open', () => this._open(task)));
    const text = spoken.map(s => [s.heading, ...s.items].map(t => (/[.!?]$/.test(t) ? t : `${t}.`)).join(' ')).join(' ');
    if (canListen && spoken.length && this.ctx.container.has('ttsManager')) row.appendChild(this._listen(text));
  }

  _listen(text) {
    const tts = this.ctx.container.get('ttsManager');
    const b = this._button(this._speaking ? 'Stop' : 'Listen', 'today-brief-listen', () => {
      const wasSpeaking = this._speaking; // stop() fires TTS_PLAYBACK_ENDED synchronously and clears _speaking
      tts.stop();
      if (wasSpeaking) {
        this._speaking = false;
      } else {
        tts.unlockAudio(); // iOS: inside the tap, before the async generation
        this._speaking = true;
        tts.speakText(text);
      }
      this.paint();
    });
    b.setAttribute('aria-pressed', String(this._speaking));
    return b;
  }
}
