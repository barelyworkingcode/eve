// Routines page (docs/design-routines.md, S5b-A1): one main-area tab listing
// the routines of in-mode projects as sentences with their last result, and
// the sheet a row opens. Collaborators are reached through the container at
// call time: this is constructed by features.boot(), before most exist.
class RoutinesPage {
  constructor(container) {
    this.container = container;
    this.bus = container.get('bus');
    this.log = container.get('logger').child('RoutinesPage');
    this.state = container.get('state');
    this._sheet = null; // { taskId, el, audit }
    this._history = new RoutineHistory({
      load: (id) => this.container.get('taskManager').loadHistory(id),
      onChange: () => this._refresh(),
    });
    this._onKey = (e) => { if (e.key === 'Escape' && this._sheet) this.closeSheet(); };
    for (const evt of [EVT.TASKS_LOADED, EVT.TASK_UPDATED, EVT.PROJECTS_LOADED, EVT.PROJECT_RENAMED, EVT.MODE_CHANGED]) {
      if (evt) this.bus.on(evt, () => this._refresh());
    }
    this.bus.on('today:source:tasks', () => this._refresh());
  }

  get el() { return document.getElementById('routinesPane'); }

  // Open or focus the one Routines tab.
  open() {
    this.container.get('tabManager').openPane('routines', {});
  }

  show() { this.render(); }

  _visible() {
    const el = this.el;
    return !!(el && !el.classList.contains('hidden'));
  }

  _refresh() {
    if (this._visible()) this.render();
  }

  _tasks() {
    const projects = new Map(this.state.getModeProjects().map(p => [p.id, p]));
    const rows = [];
    for (const t of this.state.tasks.values()) {
      const project = projects.get(t.projectId);
      if (project) rows.push({ task: t, project });
    }
    rows.sort((a, b) => a.project.name.localeCompare(b.project.name)
      || String(a.task.name).localeCompare(String(b.task.name)));
    return rows;
  }

  _source() {
    return this.container.has('todaySources') ? this.container.get('todaySources').tasks : null;
  }

  render() {
    const root = this.el;
    if (!root) return;
    this._sheet?.el.remove(); // re-attached below; the page rebuild must not drop it
    root.textContent = '';
    const page = this._div('routines-page', 'routines-page');
    const head = this._div('routines-page__header');
    const title = document.createElement('h1');
    title.className = 'routines-page__title';
    title.textContent = 'Routines';
    head.appendChild(title);
    const count = this._div('routines-page__count', 'routines-count');
    head.appendChild(count);
    page.appendChild(head);

    const source = this._source();
    const rows = this._tasks();
    if (source && source.status === 'error') {
      page.appendChild(this._note(source.describe(), true));
    } else if (rows.length === 0) {
      const loading = source && source.status === 'loading';
      page.appendChild(this._note(loading ? 'Loading…' : `Nothing scheduled in ${this._modeLabel()}.`, false));
      if (!loading) count.textContent = '0';
    } else {
      count.textContent = String(rows.length);
      const list = this._div('routines-page__list');
      for (const { task, project } of rows) list.appendChild(this._row(task, project));
      page.appendChild(list);
    }
    root.appendChild(page);
    if (this._sheet) {
      root.appendChild(this._sheet.el);
      this._fillSheetHead();
    }
  }

  _modeLabel() {
    const m = this.state.mode || 'work';
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  _div(cls, testid) {
    const el = document.createElement('div');
    el.className = cls;
    if (testid) el.dataset.testid = testid;
    return el;
  }

  _note(text, withRetry) {
    const note = this._div('routines-page__note', withRetry ? 'routines-error' : 'routines-empty');
    note.textContent = text;
    if (withRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'routines-page__retry';
      retry.dataset.testid = 'routines-retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => this._source()?.reload());
      note.append(' ', retry);
    }
    return note;
  }

  _row(task, project) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'routine-row';
    row.dataset.testid = `routine-${task.id}`;

    const sentence = this._div('routine-row__sentence');
    sentence.textContent = RoutineSentence.sentence(task.schedule);
    const meta = this._div('routine-row__meta');
    meta.textContent = `${task.name} · ${project.name}`;
    const res = RoutineSentence.result(task, this._history.lastExec(task));
    const result = this._div('routine-row__result');
    result.dataset.kind = res.kind;
    result.textContent = res.text;
    row.append(sentence, meta, result);
    row.addEventListener('click', () => this.openSheet(task.id));
    return row;
  }

  // ---- Sheet ------------------------------------------------------------

  openSheet(taskId) {
    const task = this.state.getTask(taskId);
    if (!task || !this.el) return;
    this.closeSheet();
    const el = this._div('routine-sheet', `routine-sheet-${taskId}`);
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    const scrim = this._div('routine-sheet__scrim');
    scrim.addEventListener('click', () => this.closeSheet());
    const panel = this._div('routine-sheet__panel');
    el.append(scrim, panel);

    this._sheetHead = this._div('routine-sheet__head');
    panel.appendChild(this._sheetHead);

    const actions = this._div('routine-sheet__actions');
    this._sheetActions = actions;
    panel.appendChild(actions);

    const auditEl = this._div('routine-sheet__audit', 'routine-sheet-audit');
    panel.appendChild(auditEl);
    panel.appendChild(this._button('Close', 'routine-sheet-close', () => this.closeSheet()));

    this.el.appendChild(el);
    this._sheet = { taskId, el, audit: null };
    this._fillSheetHead();
    if (typeof RoutineAudit !== 'undefined') {
      this._sheet.audit = new RoutineAudit({ container: this.container, projectId: task.projectId });
      this._sheet.audit.mount(auditEl);
    }
    document.addEventListener('keydown', this._onKey);
  }

  closeSheet() {
    const sheet = this._sheet;
    if (!sheet) return;
    this._sheet = null;
    sheet.audit?.destroy();
    sheet.el.remove();
    document.removeEventListener('keydown', this._onKey);
  }

  _fillSheetHead() {
    const task = this.state.getTask(this._sheet.taskId);
    if (!task) { this.closeSheet(); return; }
    const project = this.state.getProject(task.projectId);
    const head = this._sheetHead;
    head.textContent = '';
    const sentence = this._div('routine-sheet__sentence');
    sentence.textContent = RoutineSentence.sentence(task.schedule);
    const name = this._div('routine-sheet__name');
    name.textContent = task.name;
    const proj = this._div('routine-sheet__project');
    proj.textContent = project?.name || '';
    const res = RoutineSentence.result(task, this._history.lastExec(task));
    const result = this._div('routine-sheet__result');
    result.dataset.kind = res.kind;
    result.textContent = res.text;
    head.append(sentence, name, proj, result);

    const actions = this._sheetActions;
    actions.textContent = '';
    actions.appendChild(this._button('Run Now', 'routine-sheet-run', () => this._run(task)));
    actions.appendChild(this._button('Edit', 'routine-sheet-edit', () => {
      this.closeSheet();
      this.bus.emit(EVT.DIALOG_TASK, { projectId: task.projectId, editTaskId: task.id });
    }));
    const viewer = this.container.has('taskViewer') ? this.container.get('taskViewer') : null;
    if (viewer?.hasLastRun(task)) {
      actions.appendChild(this._button('Open last run', 'routine-sheet-open-last', () => {
        this.closeSheet();
        viewer.openLastRun(task);
      }));
    }
  }

  _button(label, testid, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'routine-sheet__btn';
    btn.dataset.testid = testid;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  async _run(task) {
    try {
      const taskManager = this.container.has('taskManager') ? this.container.get('taskManager') : null;
      if (taskManager) taskManager.userTriggeredRuns.add(task.id);
      await this.container.get('api').runTask(task.id);
    } catch (err) {
      this.log.error('Failed to run routine:', err);
    }
  }
}

if (typeof features !== 'undefined') {
  features.register({
    id: 'routinesPage',
    init: (container) => new RoutinesPage(container),
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RoutinesPage;
}
