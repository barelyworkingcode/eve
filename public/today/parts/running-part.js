/** Turns in progress in threads this browser has joined, and task runs that are executing. */
class RunningPart extends TodayPart {
  constructor() {
    super();
    this.id = 'running';
    this.modes = ['home', 'work'];
    this.order = 50;
    this.title = 'Running';
    this.sources = ['tasks'];
    this.events = [
      EVT.SESSION_ACTIVITY, EVT.SESSION_UPDATED, EVT.SESSION_REMOVED, EVT.SESSION_RENAMED,
      EVT.TASKS_LOADED, EVT.TASK_UPDATED, EVT.PROJECTS_LOADED, EVT.MODE_CHANGED,
    ];
  }

  render(root) {
    const { state, activity, container } = this.ctx;
    const app = () => (container.has('app') ? container.get('app') : null);
    const rows = [];

    for (const s of todayThreads(state)) {
      if (activity.statusOf(s.id) !== 'running') continue;
      const project = state.getProject(s.projectId);
      rows.push(todayRow(state, {
        testid: `today-running-row-${s.id}`,
        project, projectId: s.projectId,
        title: sessionDisplayName(s, project) || s.id,
        sub: project?.name || '',
        status: 'running',
        onClick: () => app()?.joinSession?.(s.id),
      }));
    }

    for (const t of state.tasks.values()) {
      if (t.lastStatus !== 'running' || !state.isSessionInMode({ projectId: t.projectId })) continue;
      const project = state.getProject(t.projectId);
      rows.push(todayRow(state, {
        testid: `today-running-row-${t.id}`,
        project, projectId: t.projectId,
        title: t.name || t.id,
        sub: [project?.name, 'routine'].filter(Boolean).join(' · '),
        status: 'running',
        onClick: () => { if (t.lastSessionId) app()?.joinSession?.(t.lastSessionId); },
      }));
    }

    root.appendChild(todayEyebrow('Running'));
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'today__empty';
      empty.textContent = 'Nothing running.';
      root.appendChild(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'home__list';
    rows.forEach(r => list.appendChild(r));
    root.appendChild(list);
  }
}
