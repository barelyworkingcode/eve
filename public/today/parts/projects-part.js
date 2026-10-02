/** Project chips; first-run when relay has none; a note when the mode has none. */
class ProjectsPart extends TodayPart {
  constructor() {
    super();
    this.id = 'projects';
    this.modes = ['home', 'work'];
    this.order = 60;
    this.title = 'Projects';
    this.sources = ['projects'];
    this.events = [
      EVT.PROJECTS_LOADED, EVT.PROJECT_ACTIVATED, EVT.PROJECT_RENAMED, EVT.PROJECT_DELETED,
      EVT.SESSION_UPDATED, EVT.SESSION_REMOVED, EVT.SESSION_CREATED, EVT.SESSION_ACTIVITY, EVT.TASKS_LOADED, EVT.MODE_CHANGED,
    ];
  }

  render(root) {
    const { state, bus } = this.ctx;
    if (state.projects.size === 0) return root.appendChild(this._firstRun());
    const projects = state.getModeProjects();
    if (projects.length === 0) return root.appendChild(this._emptyMode());

    root.appendChild(todayEyebrow('Projects'));
    const app = this.ctx.container.has('app') ? this.ctx.container.get('app') : null;
    const activeId = app?.projectTree?.activeProjectId || app?._resolveActiveProjectId?.() || null;
    const wrap = document.createElement('div');
    wrap.className = 'home__chips';
    const sorted = [...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const p of sorted) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `home__chip${p.id === activeId ? ' home__chip--active' : ''}`;
      chip.dataset.testid = `home-project-${p.id}`;
      const running = state.getSessionsForProject(p.id)
        .filter(s => !state.isTaskRun(s.id) && this.ctx.activity.statusOf(s.id) === 'running').length;
      chip.innerHTML = `
        <span class="home__monogram home__monogram--sm" style="--project-avatar-bg:${state.projectColor(p.id)}">${escapeHtml(projectMonogram(p.name))}</span>
        <span class="home__chip-name">${escapeHtml(p.name)}</span>
        ${running ? `<span class="home__live" title="${running} running"></span>` : ''}
      `;
      const hostTag = p.host && typeof hostChip === 'function'
        ? hostChip(p.host, { size: 'sm', status: state.hostStatus?.(p.host.id) })
        : null;
      if (hostTag) chip.appendChild(hostTag);
      // ProjectTree.setActive moves the rail, the panel and the highlight; the
      // bare PROJECT_ACTIVATED event only reaches TabManager.
      chip.addEventListener('click', () => {
        if (app?.projectTree) app.projectTree.setActive(p.id);
        else bus.emit(EVT.PROJECT_ACTIVATED, { projectId: p.id });
      });
      wrap.appendChild(chip);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'home__chip home__chip--add';
    add.dataset.testid = 'home-new-project';
    add.innerHTML = `${TODAY_ICONS.plus}<span class="home__chip-name">New project</span>`;
    add.addEventListener('click', () => bus.emit(EVT.DIALOG_PROJECT, {}));
    wrap.appendChild(add);
    root.appendChild(wrap);
  }

  _firstRun() {
    const card = document.createElement('div');
    card.className = 'home__first-run';
    card.innerHTML = `
      <div class="home__first-run-art" aria-hidden="true">${TODAY_ICONS.spark}</div>
      <h2>Start with a project</h2>
      <p>A project is a folder Eve can see. Sessions, files, terminals and routines all live inside one.</p>
    `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'home__primary-btn';
    btn.dataset.testid = 'home-new-project';
    btn.textContent = 'Create a project';
    btn.addEventListener('click', () => this.ctx.bus.emit(EVT.DIALOG_PROJECT, {}));
    card.appendChild(btn);
    return card;
  }

  _emptyMode() {
    const { state } = this.ctx;
    const mode = state.mode;
    const other = mode === 'work' ? 'home' : 'work';
    const label = (m) => m[0].toUpperCase() + m.slice(1);
    const card = document.createElement('div');
    card.className = 'home__empty';
    card.dataset.testid = 'today-empty-mode';
    card.append(`No projects in ${label(mode)} yet. `);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'today__link';
    btn.textContent = `Switch to ${label(other)}`;
    btn.addEventListener('click', () => state.setMode(other));
    card.appendChild(btn);
    return card;
  }
}
