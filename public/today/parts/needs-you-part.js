/** Threads waiting for a permission, turns that failed, and task runs that failed. */
class NeedsYouPart extends TodayPart {
  constructor() {
    super();
    this.id = 'needs-you';
    this.modes = ['home', 'work'];
    this.order = 20;
    this.title = 'Needs you';
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
      const status = activity.statusOf(s.id);
      if (status !== 'waiting' && status !== 'failed') continue;
      const project = state.getProject(s.projectId);
      rows.push(todayRow(state, {
        testid: `today-needs-row-${s.id}`, kind: status,
        project, projectId: s.projectId,
        title: sessionDisplayName(s, project) || s.id,
        sub: status === 'waiting' ? 'waiting for you' : activity.reasonOf(s.id),
        status,
        onClick: () => app()?.joinSession?.(s.id),
      }));
    }

    for (const t of state.tasks.values()) {
      if (!todayTaskIsFailed(t) || !state.isSessionInMode({ projectId: t.projectId })) continue;
      const project = state.getProject(t.projectId);
      rows.push(todayRow(state, {
        testid: `today-needs-row-${t.id}`, kind: 'failed',
        project, projectId: t.projectId,
        title: t.name || t.id,
        sub: t.lastStatus === 'timeout' ? 'task timed out' : 'task failed',
        status: 'failed',
        onClick: () => { if (t.lastSessionId) app()?.joinSession?.(t.lastSessionId); },
      }));
    }

    root.appendChild(todayEyebrow('Needs you'));
    if (rows.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'home__empty';
      empty.textContent = 'Nothing needs you.';
      root.appendChild(empty);
      return;
    }
    const list = document.createElement('div');
    list.className = 'home__list';
    rows.forEach(r => list.appendChild(r));
    root.appendChild(list);
  }
}
