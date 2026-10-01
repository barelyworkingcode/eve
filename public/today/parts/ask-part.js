/**
 * The Ask box: type, press Return, a thread starts in the mode's default project.
 * Its DOM is built once and only patched (status line, project pick, Send), so no
 * event elsewhere on Today can lose the text or the focus.
 */
class AskPart {
  constructor() {
    this.id = 'ask';
    this.modes = ['home', 'work'];
    this.order = 10;
    this.title = 'Ask';
    this.el = null;
    this.ctx = null;
    this._pending = false;      // a create_session is in flight
    this._queued = false;       // Return was pressed before the model list arrived
    this._failure = '';         // plain-words line from the last refusal
  }

  mount(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    el.dataset.state = 'ready';
    el.textContent = '';
    el.classList.add('today-ask');

    this.input = document.createElement('textarea');
    this.input.className = 'today-ask__input';
    this.input.rows = 2;
    this.input.placeholder = 'Ask anything…';
    this.input.setAttribute('aria-label', 'Ask');
    this.input.dataset.testid = 'today-ask-input';
    this.input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('input', () => { this._failure = ''; this.update(); });

    const row = document.createElement('div');
    row.className = 'today-ask__row';

    this.select = document.createElement('select');
    this.select.className = 'today-ask__project';
    this.select.dataset.testid = 'today-ask-project';
    this.select.setAttribute('aria-label', 'Project');
    this.select.addEventListener('change', () => {
      try { localStorage.setItem(AskPart.PROJECT_KEY, this.select.value); } catch {}
      this._failure = '';
      this.update();
    });

    this.status = document.createElement('span');
    this.status.className = 'today-ask__status';
    this.status.dataset.testid = 'today-ask-status';
    this.status.setAttribute('role', 'status');

    this.send = document.createElement('button');
    this.send.type = 'button';
    this.send.className = 'today-ask__send';
    this.send.dataset.testid = 'today-ask-send';
    this.send.textContent = 'Ask';
    this.send.addEventListener('click', () => this.submit());

    this.row = row;
    row.append(this.status, this.send);
    el.append(this.input, row);

    for (const evt of [EVT.PROJECTS_LOADED, EVT.PROJECT_DELETED, EVT.MODE_CHANGED, EVT.CONNECTION_CHANGED,
      'today:source:projects']) ctx.on(evt, () => this.update());
    ctx.on(EVT.CONNECTION_CHANGED, () => { if (!ctx.state.isOnline()) this._abandon(); });
    ctx.on(EVT.MODELS_LOADED, () => { this.update(); if (this._queued) this.submit(); });
    ctx.on(EVT.ASK_FAILED, ({ message }) => this._onFailed(message));
    ctx.on(EVT.ASK_SENT, () => { this._pending = false; this.input.value = ''; this._failure = ''; this.update(); });

    ctx.sources.projects.ensure();
    this.update();
    this.focus();
  }

  refresh() { this.update(); }

  destroy() { this.el = null; }

  // A coarse pointer means a soft keyboard: focusing would raise it over Today.
  // The one place that decides; every caller (open, show, resume) goes through focus().
  isCoarse() {
    const c = this.ctx.container;
    if (c?.has?.('layout')) return !!c.get('layout').coarse;
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  }

  focus() {
    if (this.isCoarse()) return;
    // Never take focus from something the user is already using.
    const a = document.activeElement;
    if (!a || a === document.body) this.input.focus();
  }

  // What Ask would do right now. `blocked` is the plain-words reason it cannot.
  plan() {
    const { state, sources } = this.ctx;
    if (sources.projects.status === 'error') return { blocked: sources.projects.describe() };
    if (!state.connection.browser) return { blocked: 'Not connected to eve. Your text is kept; try again once it reconnects.' };
    if (state.connection.relay === false) return { blocked: "Can't reach relay." };
    if (sources.projects.status !== 'ready') return { blocked: 'Loading projects…' };
    if (state.projects.size === 0) return { blocked: 'Create a project to start asking.' };

    const candidates = state.getModeProjects().filter(p => !p.hostId && !p.host);
    if (candidates.length === 0) {
      return { blocked: `No projects in ${state.mode[0].toUpperCase()}${state.mode.slice(1)} yet.` };
    }
    let project = candidates.find(p => (p.defaultFor || []).includes(state.mode));
    let needsPick = false;
    if (!project && candidates.length === 1) project = candidates[0];
    if (!project) {
      let remembered = '';
      try { remembered = localStorage.getItem(AskPart.PROJECT_KEY) || ''; } catch {}
      const picked = this.select.value || remembered;
      project = candidates.find(p => p.id === picked);
      needsPick = true;
    }
    const pick = needsPick ? candidates : null;
    if (!project) return { pick, blocked: 'Choose a project.' };

    if (!state.models.length) return { project, pick, waitingForModels: true };
    const model = this._model(project);
    if (!model) return { project, pick, blocked: 'No model is allowed in this project.' };
    return { project, pick, model };
  }

  _model(project) {
    const allowed = this.ctx.state.modelsForProject(project.id);
    let last = '';
    try { last = localStorage.getItem(AskPart.MODEL_KEY) || ''; } catch {}
    const hit = allowed.find(m => m.value === last);
    return (hit || allowed[0])?.value || '';
  }

  update() {
    if (!this.el) return;
    const plan = this.plan();
    // The inline pick exists only when there is a real choice to make.
    if (!plan.pick) this.select.remove();
    else {
      if (!this.select.isConnected) this.row.insertBefore(this.select, this.status);
      const remembered = this.select.value || plan.project?.id || '';
      this.select.textContent = '';
      const hint = document.createElement('option');
      hint.value = '';
      hint.textContent = 'Choose a project…';
      hint.disabled = true;
      this.select.appendChild(hint);
      for (const p of plan.pick) {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        this.select.appendChild(o);
      }
      this.select.value = plan.pick.some(p => p.id === remembered) ? remembered : '';
    }
    let line = this._failure;
    if (!line) {
      if (this._pending) line = 'Starting…';
      else if (this._queued || plan.waitingForModels) line = 'Waiting for models…';
      else if (plan.blocked) line = plan.blocked;
    }
    this.status.textContent = line;
    this.send.disabled = !!plan.blocked || this._pending;
  }

  submit() {
    const text = this.input.value.trim();
    if (!text || this._pending) return;
    const plan = this.plan();
    if (plan.blocked) { this.update(); return; }
    if (plan.waitingForModels) { this._queued = true; this.update(); return; }
    this._queued = false;
    this._failure = '';

    const { state, container } = this.ctx;
    try { localStorage.setItem(AskPart.MODEL_KEY, plan.model); } catch {}
    const app = container.get('app');
    const title = text.split('\n')[0].slice(0, 48);
    let msg = {
      type: 'create_session',
      projectId: plan.project.id,
      model: plan.model,
      settings: null,
      name: `${plan.project.name} - ${title}`,
    };
    msg = applyChatDefaults(msg, state.models);
    state.pendingAsk = { text, projectId: plan.project.id };
    this._pending = true;
    this.update();
    // The socket can drop between plan() and here; a lost send must not leave
    // the box on "Starting…" or the text queued for the next session.
    if (!app.wsClient.send(msg)) this._abandon();
  }

  // Forget an in-flight Ask that can no longer be answered. The typed text stays.
  _abandon() {
    const was = this._pending || this._queued;
    this._pending = false;
    this._queued = false;
    this.ctx.state.pendingAsk = null;
    if (was) this.update();
  }

  _onFailed(message) {
    this._pending = false;
    this._queued = false;
    this._failure = AskPart.plainWords(message);
    this.update();
  }

  static plainWords(message) {
    const m = String(message || '');
    if (/not allowed/i.test(m)) return "That model isn't allowed in this project.";
    if (/remote project/i.test(m)) return "That project runs on another machine and can't host a chat here.";
    if (/launch|unavailable|host/i.test(m)) return "The session host isn't available right now. Try again.";
    return "Couldn't start the thread. Try again.";
  }
}
AskPart.MODEL_KEY = 'eve-ask-model';
AskPart.PROJECT_KEY = 'eve-ask-project';
