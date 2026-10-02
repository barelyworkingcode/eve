// "Ask in <Other>" (docs/design-mode-presets.md): after a tool refusal in a text
// thread, a header button reruns the thread's last user turn as a new thread in
// the other mode's project. The original thread is never written to. The refused
// session ids live as long as the page; a reload forgets them. Collaborators are
// read from the container at call time: this is built by features.boot().
class AskElsewhere {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.state = container.get('state');
    this.refused = new Set();
    this._wire();
  }

  get button() { return document.getElementById('askElsewhereBtn'); }

  _wire() {
    const sync = () => this.syncButton();
    this.bus.on(EVT.TOOL_REFUSED, ({ sessionId }) => { if (sessionId) { this.refused.add(sessionId); sync(); } });
    for (const evt of [EVT.SESSION_SWITCH, EVT.SESSION_UPDATED, EVT.SESSION_REMOVED, EVT.CHAT_USER_MESSAGE,
      EVT.MODE_CHANGED, EVT.PROJECTS_LOADED]) {
      if (evt) this.bus.on(evt, sync);
    }
    // Tab changes of any kind rewrite the tab bar; a new thread's first message lands in the list.
    for (const [id, opts] of [['tabBar', { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }],
      ['messages', { childList: true }]]) {
      const el = document.getElementById(id);
      if (el && typeof MutationObserver !== 'undefined') new MutationObserver(sync).observe(el, opts);
    }
    this.bus.on(EVT.ASK_FAILED, ({ message, origin }) => {
      if (origin !== 'elsewhere') return;
      this.bus.emit(EVT.TOAST_SHOW, { message: AskPart.plainWords(message), type: 'warning', duration: 4000 });
    });
    this.button?.addEventListener('click', () => this.rerun());
    this.syncButton();
  }

  // Pure-ish: what the button would do for the active tab, or null.
  plan() {
    const { state, container } = { state: this.state, container: this.container };
    if (!container.has('tabManager')) return null;
    const tm = container.get('tabManager');
    const tab = tm.tabs.find(t => t.id === tm.activeTabId);
    if (!tab || tab.type !== 'session' || !this.refused.has(tab.id)) return null;
    const session = state.sessions.get(tab.id);
    if (!session || !session.projectId || session.sessionType === 'voice') return null;
    if (state.isTaskRun(tab.id)) return null;
    const history = state.sessionHistories.get(tab.id) || [];
    const last = [...history].reverse().find(h => h && h.role === 'user' && typeof h.content === 'string' && h.content.trim());
    if (!last) return null;
    const own = state.getProject(session.projectId);
    const mode = own && (own.mode === 'home' || own.mode === 'work') ? own.mode : state.mode;
    const other = ModePresets.other(mode);
    const mp = ModePresets.forMode(state.getVisibleProjects(), other);
    if (mp.project && mp.project.id === session.projectId) return null;
    return { other, mp, text: last.content };
  }

  syncButton() {
    const p = this.plan();
    const b = this.button;
    if (!b) return;
    b.classList.toggle('hidden', !p);
    if (p) b.textContent = `Ask in ${ModePresets.label(p.other)}`;
  }

  toast(message) { this.bus.emit(EVT.TOAST_SHOW, { message, type: 'warning', duration: 4000 }); }

  rerun() {
    const p = this.plan();
    const { state } = this;
    if (!p || state.pendingAsk) return;
    const label = ModePresets.label(p.other);
    const project = p.mp.project;
    if (!project) { this.toast(`Set a default ${label} project in Relay to ask there.`); return; }
    if (!state.models.length) { this.toast('Models are still loading. Try again.'); return; }
    const allowed = state.modelsForProject(project.id);
    let template = null;
    let model = '';
    if (p.mp.ask) {
      if (!allowed.some(m => m.value === p.mp.ask.model)) {
        this.toast(`The ${label} Ask preset uses a model ${project.name} doesn't allow.`);
        return;
      }
      template = p.mp.ask;
      model = template.model;
    } else {
      let last = '';
      try { last = localStorage.getItem(AskPart.MODEL_KEY) || ''; } catch {}
      model = (allowed.find(m => m.value === last) || allowed[0])?.value || '';
      if (!model) { this.toast('No model is allowed in this project.'); return; }
    }
    const msg = applyChatDefaults(ModePresets.askFrame({ project, template, model, text: p.text }), state.models);
    // The new thread's first message is the text, sent by the dispatcher on session_created.
    state.pendingAsk = { text: p.text, projectId: project.id, files: [], origin: 'elsewhere' };
    if (!this.container.get('app').wsClient.send(msg)) {
      state.pendingAsk = null;
      this.toast("Not connected to eve. Try again once it reconnects.");
      return;
    }
    state.setMode(p.other);
  }
}

if (typeof features !== 'undefined') {
  features.register({
    id: 'askElsewhere',
    init: (container) => new AskElsewhere(container),
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = AskElsewhere;
